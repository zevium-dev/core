/**
 * Per-key controls: monthly credit cap, enable/disable, rotation grace.
 *
 * Clerk owns the key itself; these rows are Zevium metadata pulled by the
 * gateway wallet DO during the ledger sync — never per-request.
 *
 * Auth model: the active Clerk org claim (identity.orgId) is the org scope.
 * Existing controls require an exact key.put event; new rows require a
 * short-lived HMAC projection created only after the server verifies Clerk.
 */

import {
  REGISTRY_MAX_CLOCK_SKEW_MS,
  canonicalJson,
  validateRegistryEvent,
  verifyRegistryVerifiedKeyProjection,
  verifyRegistryVerifiedKeyRotationProjection,
  type RegistryEvent,
  type RegistryKeyLifecycle,
  type RegistryPayloadMap,
  type RegistryVerifiedKeyProjection,
  type RegistryVerifiedKeyRotationProjection,
} from "@zevium/shared";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireIdentity, requireOrgAdmin } from "./lib/auth";
import {
  getActiveOrganizationByClerkId,
  getOrganizationTombstone,
} from "./lib/publicRoutes";
import {
  enqueueKeyLifecycle,
  enqueueKeyPut,
  enqueueKeyRevoke,
} from "./registrySync";

const keyProvisionValidator = v.object({
  secretSha256: v.string(),
  clerkKeyId: v.string(),
  clerkOrgId: v.string(),
  ownerUserId: v.string(),
  subjectUserId: v.string(),
  budgetId: v.string(),
  budgetRevision: v.number(),
  lifecycle: v.union(
    v.literal("active"),
    v.literal("grace"),
    v.literal("disabled"),
  ),
  monthlyCapCredits: v.union(v.number(), v.null()),
  graceUntil: v.union(v.number(), v.null()),
  expiresAt: v.union(v.number(), v.null()),
  scopes: v.array(v.string()),
});

const verifiedKeyProjectionValidator = v.object({
  schemaVersion: v.literal(1),
  verifiedAt: v.number(),
  provision: keyProvisionValidator,
});

const verifiedKeyRotationProjectionValidator = v.object({
  schemaVersion: v.literal(1),
  verifiedAt: v.number(),
  operationId: v.string(),
  oldKeyId: v.string(),
  newProvision: keyProvisionValidator,
  graceUntil: v.number(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KeySettingView = {
  _id: Id<"keySettings">;
  keyId: string;
  budgetId?: string;
  budgetRevision?: number;
  /** Absent = unlimited. */
  monthlyCapCredits?: number;
  disabled: boolean;
  rotatedFromKeyId?: string;
  /** Old rotated key works until this ms epoch. */
  graceUntil?: number;
  rotationRequiredAt?: number;
  lifecycle?: "active" | "grace" | "disabled" | "revoked";
  updatedAt: number;
};

export type GatewayKeySettingRow = {
  keyId: string;
  budgetId?: string;
  budgetRevision?: number;
  monthlyCapCredits?: number;
  disabled: boolean;
  rotatedFromKeyId?: string;
  graceUntil?: number;
  rotationRequiredAt?: number;
  lifecycle?: "active" | "grace" | "disabled" | "revoked";
};

function toView(doc: Doc<"keySettings">): KeySettingView {
  return {
    _id: doc._id,
    keyId: doc.keyId,
    budgetId: doc.budgetId,
    budgetRevision: doc.budgetRevision,
    monthlyCapCredits: doc.monthlyCapCredits,
    disabled: doc.disabled,
    rotatedFromKeyId: doc.rotatedFromKeyId,
    graceUntil: doc.graceUntil,
    rotationRequiredAt: doc.rotationRequiredAt,
    lifecycle: doc.lifecycle,
    updatedAt: doc.updatedAt,
  };
}

export function toGatewayRow(doc: Doc<"keySettings">): GatewayKeySettingRow {
  return {
    keyId: doc.keyId,
    budgetId: doc.budgetId,
    budgetRevision: doc.budgetRevision,
    monthlyCapCredits: doc.monthlyCapCredits,
    disabled: doc.disabled,
    rotatedFromKeyId: doc.rotatedFromKeyId,
    graceUntil: doc.graceUntil,
    rotationRequiredAt: doc.rotationRequiredAt,
    lifecycle: doc.lifecycle,
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
async function requireOrgByClerkId(ctx: DbCtx): Promise<{
  clerkOrgId: string;
  claims: Awaited<ReturnType<typeof requireIdentity>>;
}> {
  const claims = await requireIdentity(ctx);
  const clerkOrgId = claims.orgId;
  if (typeof clerkOrgId !== "string" || clerkOrgId.length === 0) {
    throw new Error("Select an organization before managing API keys");
  }
  if ((await getOrganizationTombstone(ctx, clerkOrgId)) !== null) {
    throw new Error("Organization is archived");
  }
  const org = await getActiveOrganizationByClerkId(ctx, clerkOrgId);
  if (org === null) {
    throw new Error("Organization not found");
  }
  return { clerkOrgId, claims };
}

/** Load a keySettings row by keyId, enforcing org ownership. */
async function getOwnedVerifiedRow(
  ctx: MutationCtx,
  clerkOrgId: string,
  keyId: string,
): Promise<Doc<"keySettings">> {
  const existing = await ctx.db
    .query("keySettings")
    .withIndex("by_key", (q) => q.eq("keyId", keyId))
    .unique();
  if (
    existing === null ||
    existing.clerkOrgId !== clerkOrgId ||
    existing.ownerUserId === undefined
  ) {
    // Cross-org attempt — do not leak existence.
    throw new Error("Verified key not found");
  }
  const firstEvent =
    existing.secretSha256 === undefined
      ? null
      : await ctx.db
          .query("registryOutbox")
          .withIndex("by_stream_revision", (q) =>
            q.eq("streamKey", `key:${existing.secretSha256}`).eq("revision", 1),
          )
          .unique();
  const event =
    firstEvent === null
      ? null
      : await validateRegistryEvent(JSON.parse(firstEvent.eventJson));
  const provision =
    event?.operation === "key.put"
      ? (event as RegistryEvent & { operation: "key.put" })
      : null;
  if (
    provision === null ||
    provision.payload.clerkOrgId !== clerkOrgId ||
    provision.payload.ownerUserId !== existing.ownerUserId ||
    provision.payload.clerkKeyId !== existing.keyId
  ) {
    throw new Error("Verified key not found");
  }
  return existing;
}

async function insertVerifiedSetting(
  ctx: MutationCtx,
  provision: RegistryPayloadMap["key.put"],
  patch: Pick<UpsertPatch, "rotatedFromKeyId"> = {},
): Promise<Doc<"keySettings">> {
  const now = Date.now();
  const id = await ctx.db.insert("keySettings", {
    clerkOrgId: provision.clerkOrgId,
    keyId: provision.clerkKeyId,
    subjectUserId: provision.subjectUserId,
    ownerUserId: provision.ownerUserId,
    budgetId: provision.budgetId,
    budgetRevision: provision.budgetRevision,
    secretSha256: provision.secretSha256,
    lifecycle: provision.lifecycle,
    disabled: provision.lifecycle === "disabled",
    updatedAt: now,
    ...(provision.monthlyCapCredits !== null
      ? { monthlyCapCredits: provision.monthlyCapCredits }
      : {}),
    ...(patch.rotatedFromKeyId !== undefined
      ? { rotatedFromKeyId: patch.rotatedFromKeyId }
      : {}),
    ...(provision.graceUntil === null
      ? {}
      : { graceUntil: provision.graceUntil }),
    ...(provision.expiresAt === null ? {} : { expiresAt: provision.expiresAt }),
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
  rotationRequiredAt?: number;
  lifecycle?: "active" | "grace" | "disabled" | "revoked";
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

function currentLifecycle(
  row: Doc<"keySettings">,
  now: number,
): RegistryKeyLifecycle {
  if (row.lifecycle === "revoked") return "revoked";
  if (row.lifecycle === "disabled") return "disabled";
  if (row.lifecycle === "grace" && (row.graceUntil ?? 0) > now) return "grace";
  if (row.disabled) return "disabled";
  if (row.graceUntil !== undefined) {
    return row.graceUntil > now ? "grace" : "disabled";
  }
  return "active";
}

function projectionSecret(): string {
  const secret = process.env.REGISTRY_KEY_PROJECTION_HMAC_SECRET;
  if (!secret) throw new Error("Verified key projection is not configured");
  return secret;
}

function requireFreshProjection(verifiedAt: number): void {
  const delta = Math.abs(Date.now() - verifiedAt);
  if (!Number.isSafeInteger(verifiedAt) || delta > REGISTRY_MAX_CLOCK_SKEW_MS) {
    throw new Error("Verified key projection is expired");
  }
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

/** Persist only a server-verified Clerk projection; raw secret never crosses. */
export const registerVerified = mutation({
  args: {
    projection: verifiedKeyProjectionValidator,
    signature: v.string(),
  },
  handler: async (ctx, args): Promise<KeySettingView> => {
    const projection = args.projection as RegistryVerifiedKeyProjection;
    const { clerkOrgId, claims } = await requireOrgByClerkId(ctx);
    requireFreshProjection(projection.verifiedAt);
    if (
      !(await verifyRegistryVerifiedKeyProjection(
        projectionSecret(),
        projection,
        args.signature,
      ))
    ) {
      throw new Error("Verified key projection signature is invalid");
    }
    const provision = projection.provision;
    if (
      provision.clerkOrgId !== clerkOrgId ||
      provision.ownerUserId !== claims.subject ||
      provision.subjectUserId !== claims.subject
    ) {
      throw new Error("Verified key projection does not match identity");
    }

    const existing = await ctx.db
      .query("keySettings")
      .withIndex("by_key", (q) => q.eq("keyId", provision.clerkKeyId))
      .unique();
    if (existing !== null) {
      const firstEvent = await ctx.db
        .query("registryOutbox")
        .withIndex("by_stream_revision", (q) =>
          q.eq("streamKey", `key:${provision.secretSha256}`).eq("revision", 1),
        )
        .unique();
      const event =
        firstEvent === null
          ? null
          : await validateRegistryEvent(JSON.parse(firstEvent.eventJson));
      if (
        existing.clerkOrgId === clerkOrgId &&
        existing.ownerUserId === claims.subject &&
        event?.operation === "key.put" &&
        canonicalJson(event.payload) === canonicalJson(provision)
      ) {
        return toView(existing);
      }
      throw new Error("Verified key projection conflicts with existing state");
    }

    const created = await insertVerifiedSetting(ctx, provision);
    await enqueueKeyPut(ctx, provision);
    return toView(created);
  },
});

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
    const existing = await getOwnedVerifiedRow(ctx, clerkOrgId, args.keyId);
    const doc = await patchSetting(ctx, existing._id, {
      monthlyCapCredits:
        args.monthlyCapCredits === null ? undefined : args.monthlyCapCredits,
    });
    await enqueueKeyLifecycle(
      ctx,
      doc,
      currentLifecycle(doc, Date.now()) as Exclude<
        RegistryKeyLifecycle,
        "revoked"
      >,
    );
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
    const existing = await getOwnedVerifiedRow(ctx, clerkOrgId, args.keyId);
    if (args.disabled === false && existing.rotationRequiredAt !== undefined) {
      throw new Error("Key must be rotated before it can be enabled");
    }
    const doc = await patchSetting(ctx, existing._id, {
      disabled: args.disabled,
      lifecycle: args.disabled ? "disabled" : "active",
    });
    await enqueueKeyLifecycle(
      ctx,
      doc,
      currentLifecycle(doc, Date.now()) as Exclude<
        RegistryKeyLifecycle,
        "revoked"
      >,
    );
    return toView(doc);
  },
});

export const revokePrevious = mutation({
  args: { keyId: v.string() },
  handler: async (ctx, args): Promise<KeySettingView> => {
    const claims = await requireIdentity(ctx);
    requireOrgAdmin(claims);
    const { clerkOrgId } = await requireOrgByClerkId(ctx);
    const existing = await getOwnedVerifiedRow(ctx, clerkOrgId, args.keyId);
    const doc = await patchSetting(ctx, existing._id, {
      disabled: true,
      lifecycle: "revoked",
      graceUntil: undefined,
    });
    await enqueueKeyRevoke(ctx, doc, "admin_revoked");
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
    const oldKey = await getOwnedVerifiedRow(ctx, claims.orgId, args.oldKeyId);
    if (oldKey.ownerUserId !== claims.subject) {
      throw new Error("Verified key not found");
    }
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
    projection: verifiedKeyRotationProjectionValidator,
    signature: v.string(),
  },
  handler: async (ctx, args) => {
    const projection = args.projection as RegistryVerifiedKeyRotationProjection;
    const claims = await requireIdentity(ctx);
    requireOrgAdmin(claims);
    if (!claims.orgId || !claims.subject)
      throw new Error("Select an organization before rotating");
    requireFreshProjection(projection.verifiedAt);
    if (
      !(await verifyRegistryVerifiedKeyRotationProjection(
        projectionSecret(),
        projection,
        args.signature,
      ))
    ) {
      throw new Error("Verified key rotation signature is invalid");
    }
    if (
      projection.newProvision.clerkOrgId !== claims.orgId ||
      projection.newProvision.ownerUserId !== claims.subject ||
      projection.newProvision.subjectUserId !== claims.subject
    ) {
      throw new Error("Verified key rotation does not match identity");
    }
    const op = await ctx.db
      .query("keyRotationOperations")
      .withIndex("by_operation", (q) =>
        q
          .eq("clerkOrgId", claims.orgId!)
          .eq("userId", claims.subject!)
          .eq("operationId", projection.operationId),
      )
      .unique();
    if (!op || op.oldKeyId !== projection.oldKeyId)
      throw new Error("Rotation operation not found");
    if (op.status === "completed") {
      if (op.newKeyId !== projection.newProvision.clerkKeyId) {
        throw new Error("Rotation operation conflicts with completed key");
      }
      return op;
    }
    if (op.status !== "reserved") throw new Error("Rotation operation failed");
    const old = await getOwnedVerifiedRow(
      ctx,
      claims.orgId,
      projection.oldKeyId,
    );
    if (old.ownerUserId !== claims.subject) {
      throw new Error("Verified key not found");
    }
    const existingNew = await ctx.db
      .query("keySettings")
      .withIndex("by_key", (q) =>
        q.eq("keyId", projection.newProvision.clerkKeyId),
      )
      .unique();
    if (existingNew !== null) {
      throw new Error("Verified replacement key already exists");
    }
    const newDoc = await insertVerifiedSetting(ctx, projection.newProvision, {
      rotatedFromKeyId: projection.oldKeyId,
    });
    await enqueueKeyPut(ctx, projection.newProvision);
    void newDoc;
    const oldDoc = await patchSetting(ctx, old._id, {
      disabled: false,
      lifecycle: "grace",
      graceUntil: projection.graceUntil,
    });
    await enqueueKeyLifecycle(ctx, oldDoc, "grace");
    await ctx.db.patch(op._id, {
      status: "completed",
      newKeyId: projection.newProvision.clerkKeyId,
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

// ---------------------------------------------------------------------------
// Provider-verified ownership (#228): gateway verifies the key against Clerk,
// then records ownership here. Predates/parallel to registry projections.
// ---------------------------------------------------------------------------

async function getOwnedRow(
  ctx: MutationCtx,
  clerkOrgId: string,
  keyId: string,
): Promise<Doc<"keySettings"> | null> {
  const existing = await ctx.db
    .query("keySettings")
    .withIndex("by_key", (q) => q.eq("keyId", keyId))
    .unique();
  if (existing === null || existing.clerkOrgId !== clerkOrgId) return null;
  return existing;
}

async function insertSetting(
  ctx: MutationCtx,
  clerkOrgId: string,
  keyId: string,
  patch: UpsertPatch,
): Promise<Doc<"keySettings">> {
  const id = await ctx.db.insert("keySettings", {
    clerkOrgId,
    keyId,
    disabled: patch.disabled ?? false,
    updatedAt: Date.now(),
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

export const recordProviderVerifiedKey = internalMutation({
  args: {
    keyId: v.string(),
    ownerUserId: v.string(),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args): Promise<KeySettingView> => {
    if (
      args.keyId.trim() === "" ||
      args.ownerUserId.trim() === "" ||
      args.clerkOrgId.trim() === ""
    ) {
      throw new Error("Provider key ownership could not be verified");
    }
    if ((await getActiveOrganizationByClerkId(ctx, args.clerkOrgId)) === null) {
      throw new Error("Organization is archived or not provisioned");
    }
    const existing = await getOwnedRow(ctx, args.clerkOrgId, args.keyId);
    const doc =
      existing === null
        ? await insertSetting(ctx, args.clerkOrgId, args.keyId, {})
        : await patchSetting(ctx, existing._id, {});
    if (doc.ownerUserId !== args.ownerUserId) {
      await ctx.db.patch(doc._id, {
        ownerUserId: args.ownerUserId,
        updatedAt: Date.now(),
      });
    }
    const updated = await ctx.db.get(doc._id);
    if (updated === null) throw new Error("Key setting disappeared");
    return toView(updated);
  },
});
