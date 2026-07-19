/**
 * Per-key controls: monthly credit cap, enable/disable, rotation grace.
 *
 * Clerk owns the key itself; these rows are Zevium metadata pulled by the
 * gateway wallet DO during the ledger sync — never per-request.
 *
 * Auth model: the active Clerk org claim (identity.orgId) is the org scope.
 * keyId ownership is verified against an existing row's clerkOrgId; a brand-new
 * row is stamped with the caller's orgId (the web only ever passes keyIds it
 * listed from Clerk filtered to that org).
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireIdentity, requireOrgAdmin } from "./lib/auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KeySettingView = {
  _id: Id<"keySettings">;
  keyId: string;
  /** Absent = unlimited. */
  monthlyCapCredits?: number;
  disabled: boolean;
  rotatedFromKeyId?: string;
  /** Old rotated key works until this ms epoch. */
  graceUntil?: number;
  updatedAt: number;
};

export type GatewayKeySettingRow = {
  keyId: string;
  monthlyCapCredits?: number;
  disabled: boolean;
  rotatedFromKeyId?: string;
  graceUntil?: number;
};

function toView(doc: Doc<"keySettings">): KeySettingView {
  return {
    _id: doc._id,
    keyId: doc.keyId,
    monthlyCapCredits: doc.monthlyCapCredits,
    disabled: doc.disabled,
    rotatedFromKeyId: doc.rotatedFromKeyId,
    graceUntil: doc.graceUntil,
    updatedAt: doc.updatedAt,
  };
}

export function toGatewayRow(doc: Doc<"keySettings">): GatewayKeySettingRow {
  return {
    keyId: doc.keyId,
    monthlyCapCredits: doc.monthlyCapCredits,
    disabled: doc.disabled,
    rotatedFromKeyId: doc.rotatedFromKeyId,
    graceUntil: doc.graceUntil,
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

type DbCtx = QueryCtx | MutationCtx;

/**
 * Require an authenticated member of the active Clerk org. The org is derived
 * from the JWT active-org claim (identity.orgId); a mirrored org row must exist.
 */
async function requireOrgByClerkId(
  ctx: DbCtx,
): Promise<{ clerkOrgId: string }> {
  const claims = await requireIdentity(ctx);
  const clerkOrgId = claims.orgId;
  if (typeof clerkOrgId !== "string" || clerkOrgId.length === 0) {
    throw new Error("Select an organization before managing API keys");
  }
  const org = await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", clerkOrgId))
    .unique();
  if (org === null) {
    throw new Error("Organization not found");
  }
  return { clerkOrgId };
}

/** Load a keySettings row by keyId, enforcing org ownership. */
async function getOwnedRow(
  ctx: MutationCtx,
  clerkOrgId: string,
  keyId: string,
): Promise<Doc<"keySettings"> | null> {
  const existing = await ctx.db
    .query("keySettings")
    .withIndex("by_key", (q) => q.eq("keyId", keyId))
    .unique();
  if (existing === null) return null;
  if (existing.clerkOrgId !== clerkOrgId) {
    // Cross-org attempt — do not leak existence.
    throw new Error("Key not found");
  }
  return existing;
}

/** Insert a keySettings row (minimal: disabled defaults to false). */
async function insertSetting(
  ctx: MutationCtx,
  clerkOrgId: string,
  keyId: string,
  patch: UpsertPatch,
): Promise<Doc<"keySettings">> {
  const now = Date.now();
  const id = await ctx.db.insert("keySettings", {
    clerkOrgId,
    keyId,
    disabled: patch.disabled ?? false,
    updatedAt: now,
    ...(patch.monthlyCapCredits !== undefined
      ? { monthlyCapCredits: patch.monthlyCapCredits }
      : {}),
    ...(patch.rotatedFromKeyId !== undefined
      ? { rotatedFromKeyId: patch.rotatedFromKeyId }
      : {}),
    ...(patch.graceUntil !== undefined ? { graceUntil: patch.graceUntil } : {}),
  });
  const created = await ctx.db.get(id);
  if (created === null) throw new Error("Failed to read created key setting");
  return created;
}

type UpsertPatch = {
  monthlyCapCredits?: number;
  disabled?: boolean;
  rotatedFromKeyId?: string;
  graceUntil?: number;
};

/**
 * Update an existing row's fields. A field set to `undefined` is deleted from
 * the document (Convex patch semantics) — used to clear monthlyCapCredits.
 */
async function patchSetting(
  ctx: MutationCtx,
  id: Id<"keySettings">,
  patch: UpsertPatch,
): Promise<Doc<"keySettings">> {
  const update: Record<string, unknown> = { updatedAt: Date.now() };
  for (const [k, value] of Object.entries(patch)) {
    update[k] = value;
  }
  await ctx.db.patch(id, update as Partial<Doc<"keySettings">>);
  const updated = await ctx.db.get(id);
  if (updated === null) throw new Error("Failed to read updated key setting");
  return updated;
}

/** Insert or update a keySettings row scoped to clerkOrgId. */
async function upsertSetting(
  ctx: MutationCtx,
  clerkOrgId: string,
  keyId: string,
  patch: UpsertPatch,
): Promise<Doc<"keySettings">> {
  const existing = await getOwnedRow(ctx, clerkOrgId, keyId);
  if (existing !== null) {
    return await patchSetting(ctx, existing._id, patch);
  }
  return await insertSetting(ctx, clerkOrgId, keyId, patch);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * All key settings for the active org. Realtime-synced to the keys screen.
 */
export const getForOrg = query({
  args: {},
  handler: async (ctx): Promise<KeySettingView[]> => {
    const { clerkOrgId } = await requireOrgByClerkId(ctx);
    const rows = await ctx.db
      .query("keySettings")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", clerkOrgId))
      .collect();
    return rows.map(toView);
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Set or clear (null) the monthly credit cap for a key. */
export const setCap = mutation({
  args: {
    keyId: v.string(),
    /** null clears the cap (unlimited); a positive integer sets it. */
    monthlyCapCredits: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args): Promise<KeySettingView> => {
    const { clerkOrgId } = await requireOrgByClerkId(ctx);
    if (args.keyId.trim().length === 0) {
      throw new Error("keyId is required");
    }
    if (
      args.monthlyCapCredits !== null &&
      (!Number.isFinite(args.monthlyCapCredits) ||
        args.monthlyCapCredits <= 0 ||
        !Number.isInteger(args.monthlyCapCredits))
    ) {
      throw new Error("Cap must be a positive whole number of credits");
    }
    // null clears the field (undefined in patch deletes it); a number sets it.
    const doc = await upsertSetting(ctx, clerkOrgId, args.keyId, {
      monthlyCapCredits:
        args.monthlyCapCredits === null ? undefined : args.monthlyCapCredits,
    });
    return toView(doc);
  },
});

/** Enable or disable a key. */
export const setDisabled = mutation({
  args: {
    keyId: v.string(),
    disabled: v.boolean(),
  },
  handler: async (ctx, args): Promise<KeySettingView> => {
    const { clerkOrgId } = await requireOrgByClerkId(ctx);
    if (args.keyId.trim().length === 0) {
      throw new Error("keyId is required");
    }
    const doc = await upsertSetting(ctx, clerkOrgId, args.keyId, {
      disabled: args.disabled,
    });
    return toView(doc);
  },
});

export const revokePrevious = mutation({
  args: { keyId: v.string() },
  handler: async (ctx, args): Promise<KeySettingView> => {
    const claims = await requireIdentity(ctx);
    requireOrgAdmin(claims);
    const { clerkOrgId } = await requireOrgByClerkId(ctx);
    const doc = await upsertSetting(ctx, clerkOrgId, args.keyId, {
      disabled: true,
      graceUntil: undefined,
    });
    return toView(doc);
  },
});

export const beginRotation = mutation({
  args: { operationId: v.string(), oldKeyId: v.string() },
  handler: async (ctx, args) => {
    const claims = await requireIdentity(ctx);
    requireOrgAdmin(claims);
    if (!claims.orgId || !claims.subject)
      throw new Error("Select an organization before rotating");
    const existing = await ctx.db
      .query("keyRotationOperations")
      .withIndex("by_operation", (q) =>
        q
          .eq("clerkOrgId", claims.orgId!)
          .eq("userId", claims.subject!)
          .eq("operationId", args.operationId),
      )
      .unique();
    if (
      existing?.status === "reserved" &&
      Date.now() - existing.updatedAt > 5 * 60_000
    ) {
      await ctx.db.patch(existing._id, {
        status: "failed",
        failure: "Reservation expired",
        updatedAt: Date.now(),
      });
    } else if (existing) return existing;
    const active = await ctx.db
      .query("keyRotationOperations")
      .withIndex("by_active_old_key", (q) =>
        q
          .eq("clerkOrgId", claims.orgId!)
          .eq("oldKeyId", args.oldKeyId)
          .eq("status", "reserved"),
      )
      .unique();
    if (active && Date.now() - active.updatedAt > 5 * 60_000) {
      await ctx.db.patch(active._id, {
        status: "failed",
        failure: "Reservation expired",
        updatedAt: Date.now(),
      });
    } else if (active) {
      throw new Error("A rotation is already in progress for this key");
    }
    const now = Date.now();
    const id = await ctx.db.insert("keyRotationOperations", {
      clerkOrgId: claims.orgId,
      userId: claims.subject,
      operationId: args.operationId,
      oldKeyId: args.oldKeyId,
      status: "reserved",
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(id);
  },
});

export const completeRotation = mutation({
  args: {
    operationId: v.string(),
    oldKeyId: v.string(),
    newKeyId: v.string(),
    graceUntil: v.number(),
  },
  handler: async (ctx, args) => {
    const claims = await requireIdentity(ctx);
    requireOrgAdmin(claims);
    if (!claims.orgId || !claims.subject)
      throw new Error("Select an organization before rotating");
    const op = await ctx.db
      .query("keyRotationOperations")
      .withIndex("by_operation", (q) =>
        q
          .eq("clerkOrgId", claims.orgId!)
          .eq("userId", claims.subject!)
          .eq("operationId", args.operationId),
      )
      .unique();
    if (!op || op.oldKeyId !== args.oldKeyId)
      throw new Error("Rotation operation not found");
    if (op.status === "completed") return op;
    if (op.status !== "reserved") throw new Error("Rotation operation failed");
    const oldDoc = await upsertSetting(ctx, claims.orgId, args.oldKeyId, {
      graceUntil: args.graceUntil,
    });
    await upsertSetting(ctx, claims.orgId, args.newKeyId, {
      rotatedFromKeyId: args.oldKeyId,
    });
    await ctx.db.patch(op._id, {
      status: "completed",
      newKeyId: args.newKeyId,
      graceUntil: oldDoc.graceUntil,
      updatedAt: Date.now(),
    });
    return await ctx.db.get(op._id);
  },
});

export const failRotation = mutation({
  args: { operationId: v.string(), message: v.string() },
  handler: async (ctx, args) => {
    const claims = await requireIdentity(ctx);
    requireOrgAdmin(claims);
    if (!claims.orgId || !claims.subject)
      throw new Error("Select an organization before rotating");
    const op = await ctx.db
      .query("keyRotationOperations")
      .withIndex("by_operation", (q) =>
        q
          .eq("clerkOrgId", claims.orgId!)
          .eq("userId", claims.subject!)
          .eq("operationId", args.operationId),
      )
      .unique();
    if (!op) throw new Error("Rotation operation not found");
    if (op.status === "completed") return op;
    await ctx.db.patch(op._id, {
      status: "failed",
      failure: args.message.slice(0, 160),
      updatedAt: Date.now(),
    });
    return await ctx.db.get(op._id);
  },
});
