import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireIdentity } from "./lib/auth";
import { enqueueKeyState, enqueueKeyUpsert } from "./registrySync";

const OPERATION_TTL_MS = 5 * 60_000;

export type KeySettingView = {
  _id: Id<"keySettings">;
  keyId: string;
  monthlyCapCredits?: number;
  disabled: boolean;
  rotatedFromKeyId?: string;
  graceUntil?: number;
  updatedAt: number;
};

export type GatewayKeySettingRow = Omit<KeySettingView, "_id" | "updatedAt">;

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

type DbCtx = QueryCtx | MutationCtx;

async function requireOrgScope(
  ctx: DbCtx,
): Promise<{ clerkOrgId: string; userId: string }> {
  const claims = await requireIdentity(ctx);
  if (!claims.orgId) {
    throw new Error("Select an organization before managing API keys");
  }
  const org = await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", claims.orgId!))
    .unique();
  if (org === null) throw new Error("Organization not found");
  return { clerkOrgId: claims.orgId, userId: claims.subject };
}

function validId(value: string, label: string): string {
  const id = value.trim();
  if (id.length < 8 || id.length > 256) throw new Error(`${label} is invalid`);
  return id;
}

async function ownedRow(
  ctx: MutationCtx,
  clerkOrgId: string,
  userId: string,
  keyId: string,
): Promise<Doc<"keySettings">> {
  const row = await ctx.db
    .query("keySettings")
    .withIndex("by_key", (q) => q.eq("keyId", keyId))
    .unique();
  if (
    row === null ||
    row.clerkOrgId !== clerkOrgId ||
    row.ownerUserId !== userId
  ) {
    throw new Error("Key unavailable");
  }
  return row;
}

async function registerOwnedRow(
  ctx: MutationCtx,
  clerkOrgId: string,
  userId: string,
  rawKeyId: string,
): Promise<{ row: Doc<"keySettings">; changed: boolean }> {
  const keyId = validId(rawKeyId, "Key id");
  const existing = await ctx.db
    .query("keySettings")
    .withIndex("by_key", (q) => q.eq("keyId", keyId))
    .unique();
  if (existing !== null) {
    if (
      existing.clerkOrgId !== clerkOrgId ||
      (existing.ownerUserId !== undefined && existing.ownerUserId !== userId)
    ) {
      throw new Error("Key unavailable");
    }
    if (existing.ownerUserId === undefined) {
      await ctx.db.patch(existing._id, {
        ownerUserId: userId,
        updatedAt: Date.now(),
      });
      const claimed = await ctx.db.get(existing._id);
      if (claimed === null) throw new Error("Failed to register key");
      return { row: claimed, changed: true };
    }
    return { row: existing, changed: false };
  }
  const id = await ctx.db.insert("keySettings", {
    clerkOrgId,
    ownerUserId: userId,
    keyId,
    disabled: false,
    updatedAt: Date.now(),
  });
  const created = await ctx.db.get(id);
  if (created === null) throw new Error("Failed to register key");
  return { row: created, changed: true };
}

function currentLifecycle(
  row: Doc<"keySettings">,
): "active" | "disabled" | "grace" {
  if (row.disabled) return "disabled";
  if (row.graceUntil !== undefined && row.graceUntil > Date.now()) {
    return "grace";
  }
  return "active";
}

async function patchOwned(
  ctx: MutationCtx,
  clerkOrgId: string,
  userId: string,
  keyId: string,
  patch: Partial<Doc<"keySettings">>,
): Promise<Doc<"keySettings">> {
  const row = await ownedRow(ctx, clerkOrgId, userId, keyId);
  await ctx.db.patch(row._id, { ...patch, updatedAt: Date.now() });
  const updated = await ctx.db.get(row._id);
  if (updated === null) throw new Error("Key unavailable");
  return updated;
}

/** Member sees only own key metadata; sibling key ids never cross boundary. */
export const getForOrg = query({
  args: {},
  handler: async (ctx): Promise<KeySettingView[]> => {
    const { clerkOrgId, userId } = await requireOrgScope(ctx);
    const rows = await ctx.db
      .query("keySettings")
      .withIndex("by_owner", (q) =>
        q.eq("clerkOrgId", clerkOrgId).eq("ownerUserId", userId),
      )
      .collect();
    return rows.map(toView);
  },
});

/** Called only after keyBroker verifies Clerk subject + org + fresh membership. */
export const registerVerified = internalMutation({
  args: { clerkOrgId: v.string(), userId: v.string(), keyId: v.string() },
  handler: async (ctx, args): Promise<KeySettingView> => {
    const registered = await registerOwnedRow(
      ctx,
      args.clerkOrgId,
      args.userId,
      args.keyId,
    );
    if (registered.changed) await enqueueKeyUpsert(ctx, registered.row);
    return toView(registered.row);
  },
});

export const setCapVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    keyId: v.string(),
    monthlyCapCredits: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args): Promise<KeySettingView> => {
    if (
      args.monthlyCapCredits !== null &&
      (!Number.isInteger(args.monthlyCapCredits) || args.monthlyCapCredits <= 0)
    ) {
      throw new Error("Cap must be a positive whole number of credits");
    }
    const updated = await patchOwned(
      ctx,
      args.clerkOrgId,
      args.userId,
      args.keyId,
      {
        monthlyCapCredits:
          args.monthlyCapCredits === null ? undefined : args.monthlyCapCredits,
      },
    );
    await enqueueKeyState(ctx, updated, currentLifecycle(updated));
    return toView(updated);
  },
});

export const setDisabledVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    keyId: v.string(),
    disabled: v.boolean(),
  },
  handler: async (ctx, args): Promise<KeySettingView> => {
    if (!args.disabled) {
      const activeRevoke = await ctx.db
        .query("keyLifecycleOperations")
        .withIndex("by_active_kind", (q) =>
          q
            .eq("clerkOrgId", args.clerkOrgId)
            .eq("userId", args.userId)
            .eq("kind", "revoke")
            .eq("status", "reserved"),
        )
        .unique();
      if (activeRevoke?.keyId === args.keyId) {
        throw new Error("Key revocation is in progress");
      }
    }
    const updated = await patchOwned(
      ctx,
      args.clerkOrgId,
      args.userId,
      args.keyId,
      { disabled: args.disabled },
    );
    await enqueueKeyState(ctx, updated, currentLifecycle(updated));
    return toView(updated);
  },
});

async function lifecycleOperation(
  ctx: MutationCtx,
  scope: { clerkOrgId: string; userId: string; operationId: string },
) {
  return await ctx.db
    .query("keyLifecycleOperations")
    .withIndex("by_operation", (q) =>
      q
        .eq("clerkOrgId", scope.clerkOrgId)
        .eq("userId", scope.userId)
        .eq("operationId", scope.operationId),
    )
    .unique();
}

export const beginCreateVerified = internalMutation({
  args: { clerkOrgId: v.string(), userId: v.string(), operationId: v.string() },
  handler: async (ctx, args) => {
    const operationId = validId(args.operationId, "Operation");
    const existing = await lifecycleOperation(ctx, { ...args, operationId });
    if (existing) return existing;
    const active = await ctx.db
      .query("keyLifecycleOperations")
      .withIndex("by_active_kind", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("userId", args.userId)
          .eq("kind", "create")
          .eq("status", "reserved"),
      )
      .unique();
    if (active && Date.now() - active.updatedAt <= OPERATION_TTL_MS) {
      throw new Error("Key creation is already in progress");
    }
    if (active) {
      await ctx.db.patch(active._id, {
        status: "failed",
        failure: "Reservation expired",
        updatedAt: Date.now(),
      });
    }
    const now = Date.now();
    const id = await ctx.db.insert("keyLifecycleOperations", {
      clerkOrgId: args.clerkOrgId,
      userId: args.userId,
      operationId,
      kind: "create",
      status: "reserved",
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(id);
  },
});

export const completeCreateVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    keyId: v.string(),
  },
  handler: async (ctx, args) => {
    const op = await lifecycleOperation(ctx, args);
    if (!op || op.kind !== "create") throw new Error("Creation unavailable");
    if (op.status === "completed") return op;
    if (op.status !== "reserved") throw new Error("Creation unavailable");
    const registered = await registerOwnedRow(
      ctx,
      args.clerkOrgId,
      args.userId,
      args.keyId,
    );
    if (registered.changed) await enqueueKeyUpsert(ctx, registered.row);
    await ctx.db.patch(op._id, {
      status: "completed",
      keyId: args.keyId,
      updatedAt: Date.now(),
    });
    return await ctx.db.get(op._id);
  },
});

export const failCreateVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const op = await lifecycleOperation(ctx, args);
    if (!op || op.kind !== "create" || op.status !== "reserved") return op;
    await ctx.db.patch(op._id, {
      status: "failed",
      failure: args.message.slice(0, 160),
      updatedAt: Date.now(),
    });
    return await ctx.db.get(op._id);
  },
});

export const beginRevokeVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    keyId: v.string(),
  },
  handler: async (ctx, args) => {
    const operationId = validId(args.operationId, "Operation");
    const existing = await lifecycleOperation(ctx, { ...args, operationId });
    if (existing) return existing;
    const active = await ctx.db
      .query("keyLifecycleOperations")
      .withIndex("by_active_kind", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("userId", args.userId)
          .eq("kind", "revoke")
          .eq("status", "reserved"),
      )
      .unique();
    if (active && Date.now() - active.updatedAt <= OPERATION_TTL_MS) {
      throw new Error("Key revocation is already in progress");
    }
    if (active) {
      // Fail closed. An expired reservation may already have revoked the Clerk
      // key, so never restore its local gate automatically.
      await ctx.db.patch(active._id, {
        status: "failed",
        failure: "Reservation expired; key remained disabled",
        updatedAt: Date.now(),
      });
    }
    const rotation = await ctx.db
      .query("keyRotationOperations")
      .withIndex("by_active_old_key", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("oldKeyId", args.keyId)
          .eq("status", "reserved"),
      )
      .unique();
    if (rotation) throw new Error("Key rotation is in progress");
    const row = await ownedRow(ctx, args.clerkOrgId, args.userId, args.keyId);
    const now = Date.now();
    const id = await ctx.db.insert("keyLifecycleOperations", {
      clerkOrgId: args.clerkOrgId,
      userId: args.userId,
      operationId,
      kind: "revoke",
      status: "reserved",
      keyId: args.keyId,
      previousDisabled: row.disabled,
      createdAt: now,
      updatedAt: now,
    });
    // Local gate closes before external Clerk mutation.
    await ctx.db.patch(row._id, {
      disabled: true,
      graceUntil: undefined,
      updatedAt: now,
    });
    const disabled = await ctx.db.get(row._id);
    if (disabled === null) throw new Error("Key unavailable");
    await enqueueKeyState(ctx, disabled, "disabled");
    return await ctx.db.get(id);
  },
});

export const completeRevokeVerified = internalMutation({
  args: { clerkOrgId: v.string(), userId: v.string(), operationId: v.string() },
  handler: async (ctx, args) => {
    const op = await lifecycleOperation(ctx, args);
    if (!op || op.kind !== "revoke") throw new Error("Revocation unavailable");
    if (op.status === "completed") return op;
    if (op.status !== "reserved") throw new Error("Revocation unavailable");
    if (!op.keyId) throw new Error("Revocation unavailable");
    const row = await ownedRow(ctx, args.clerkOrgId, args.userId, op.keyId);
    await enqueueKeyState(ctx, row, "revoked");
    await ctx.db.patch(op._id, { status: "completed", updatedAt: Date.now() });
    return await ctx.db.get(op._id);
  },
});

export const failRevokeVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const op = await lifecycleOperation(ctx, args);
    if (!op || op.kind !== "revoke" || op.status !== "reserved") return op;
    if (op.keyId) {
      const row = await ownedRow(ctx, args.clerkOrgId, args.userId, op.keyId);
      await ctx.db.patch(row._id, {
        disabled: op.previousDisabled ?? false,
        updatedAt: Date.now(),
      });
      const restored = await ctx.db.get(row._id);
      if (restored === null) throw new Error("Key unavailable");
      await enqueueKeyState(ctx, restored, currentLifecycle(restored));
    }
    await ctx.db.patch(op._id, {
      status: "failed",
      failure: args.message.slice(0, 160),
      updatedAt: Date.now(),
    });
    return await ctx.db.get(op._id);
  },
});

export const beginRotationVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    oldKeyId: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ownedRow(
      ctx,
      args.clerkOrgId,
      args.userId,
      args.oldKeyId,
    );
    if (row.disabled) throw new Error("Key unavailable");
    const operationId = validId(args.operationId, "Operation");
    const existing = await ctx.db
      .query("keyRotationOperations")
      .withIndex("by_operation", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("userId", args.userId)
          .eq("operationId", operationId),
      )
      .unique();
    if (existing) return existing;
    const revoke = await ctx.db
      .query("keyLifecycleOperations")
      .withIndex("by_active_kind", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("userId", args.userId)
          .eq("kind", "revoke")
          .eq("status", "reserved"),
      )
      .unique();
    if (revoke?.keyId === args.oldKeyId) {
      throw new Error("Key revocation is in progress");
    }
    const active = await ctx.db
      .query("keyRotationOperations")
      .withIndex("by_active_old_key", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("oldKeyId", args.oldKeyId)
          .eq("status", "reserved"),
      )
      .unique();
    if (active && Date.now() - active.updatedAt <= OPERATION_TTL_MS) {
      throw new Error("A rotation is already in progress for this key");
    }
    if (active) {
      await ctx.db.patch(active._id, {
        status: "failed",
        failure: "Reservation expired",
        updatedAt: Date.now(),
      });
    }
    const now = Date.now();
    const id = await ctx.db.insert("keyRotationOperations", {
      clerkOrgId: args.clerkOrgId,
      userId: args.userId,
      operationId,
      oldKeyId: args.oldKeyId,
      status: "reserved",
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(id);
  },
});

export const completeRotationVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    oldKeyId: v.string(),
    newKeyId: v.string(),
    graceUntil: v.number(),
  },
  handler: async (ctx, args) => {
    const op = await ctx.db
      .query("keyRotationOperations")
      .withIndex("by_operation", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("userId", args.userId)
          .eq("operationId", args.operationId),
      )
      .unique();
    if (!op || op.oldKeyId !== args.oldKeyId) {
      throw new Error("Rotation unavailable");
    }
    if (op.status === "completed") return op;
    if (op.status !== "reserved") throw new Error("Rotation unavailable");
    const old = await ownedRow(
      ctx,
      args.clerkOrgId,
      args.userId,
      args.oldKeyId,
    );
    if (old.disabled) throw new Error("Rotation unavailable");
    const oldUpdated = await patchOwned(
      ctx,
      args.clerkOrgId,
      args.userId,
      args.oldKeyId,
      {
        graceUntil: args.graceUntil,
      },
    );
    const next = await registerOwnedRow(
      ctx,
      args.clerkOrgId,
      args.userId,
      args.newKeyId,
    );
    await ctx.db.patch(next.row._id, {
      rotatedFromKeyId: args.oldKeyId,
      updatedAt: Date.now(),
    });
    const nextUpdated = await ctx.db.get(next.row._id);
    if (nextUpdated === null) throw new Error("Rotation unavailable");
    await enqueueKeyState(ctx, oldUpdated, "grace");
    await enqueueKeyUpsert(ctx, nextUpdated);
    await enqueueKeyState(ctx, nextUpdated, currentLifecycle(nextUpdated));
    await ctx.db.patch(op._id, {
      status: "completed",
      newKeyId: args.newKeyId,
      graceUntil: args.graceUntil,
      updatedAt: Date.now(),
    });
    return await ctx.db.get(op._id);
  },
});

export const failRotationVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const op = await ctx.db
      .query("keyRotationOperations")
      .withIndex("by_operation", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("userId", args.userId)
          .eq("operationId", args.operationId),
      )
      .unique();
    if (!op || op.status !== "reserved") return op;
    await ctx.db.patch(op._id, {
      status: "failed",
      failure: args.message.slice(0, 160),
      updatedAt: Date.now(),
    });
    return await ctx.db.get(op._id);
  },
});
