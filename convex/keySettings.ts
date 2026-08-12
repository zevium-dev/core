import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { enqueueEdgeKeyRevocation } from "./edgeKeyRevocation";
import { orgCapabilities, requireIdentity } from "./lib/auth";
import { maskedSuffix, publicReference } from "./lib/publicIds";
import { enqueueKeyState, enqueueKeyUpsert } from "./registrySync";
import type { EdgeKeyRevocationReason } from "@zevium/shared";

const OPERATION_TTL_MS = 5 * 60_000;
const SAGA_RECONCILE_DELAY_MS = 60_000;
const AUTO_REVOKE_LEASE_MS = 5 * 60_000;
export const ROTATION_GRACE_MS = 24 * 60 * 60_000;

export type KeySettingView = {
  keyId: string;
  managed: boolean;
  familyId: string;
  monthlyCapCredits?: number;
  disabled: boolean;
  rotatedFromKeyId?: string;
  graceUntil?: number;
  updatedAt: number;
};

export type GatewayKeySettingRow = {
  keyId: string;
  familyId: string;
  monthlyCapCredits?: number;
  disabled: boolean;
  rotatedFromKeyId?: string;
  graceUntil?: number;
};

function toView(doc: Doc<"keySettings">): KeySettingView {
  return {
    keyId: doc.keyId,
    managed: doc.managed === true,
    familyId: doc.familyId ?? doc.keyId,
    monthlyCapCredits: doc.monthlyCapCredits,
    disabled: doc.managed !== true || doc.disabled,
    rotatedFromKeyId: doc.rotatedFromKeyId,
    graceUntil: doc.graceUntil,
    updatedAt: doc.updatedAt,
  };
}

export function toGatewayRow(
  doc: Doc<"keySettings">,
  forceDisabled = false,
): GatewayKeySettingRow {
  return {
    keyId: doc.keyId,
    familyId: doc.familyId ?? doc.keyId,
    monthlyCapCredits: doc.monthlyCapCredits,
    disabled: forceDisabled || doc.managed !== true || doc.disabled,
    rotatedFromKeyId: doc.rotatedFromKeyId,
    graceUntil: doc.graceUntil,
  };
}

type DbCtx = QueryCtx | MutationCtx;

async function requireOrgScope(
  ctx: DbCtx,
): Promise<{
  clerkOrgId: string;
  userId: string;
  canManageOrgKeyPolicy: boolean;
}> {
  const claims = await requireIdentity(ctx);
  if (!claims.orgId) {
    throw new Error("Select an organization before managing API keys");
  }
  const org = await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", claims.orgId!))
    .unique();
  if (org === null) throw new Error("Organization not found");
  return {
    clerkOrgId: claims.orgId,
    userId: claims.subject,
    canManageOrgKeyPolicy: orgCapabilities(claims).canManageOrgKeyPolicy,
  };
}

function validId(value: string, label: string): string {
  const id = value.trim();
  if (id.length < 8 || id.length > 256) throw new Error(`${label} is invalid`);
  return id;
}

/** Registry projection plus durable signed edge revocation that bypasses 60s sync. */
async function publishTerminalKeyState(
  ctx: MutationCtx,
  row: Doc<"keySettings">,
  lifecycle: "disabled" | "revoked",
  reason: EdgeKeyRevocationReason,
): Promise<void> {
  await enqueueKeyState(ctx, row, lifecycle);
  await enqueueEdgeKeyRevocation(ctx, row, reason);
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
    row.ownerUserId !== userId ||
    row.managed !== true
  ) {
    throw new Error("Key unavailable");
  }
  return row;
}

async function ownedObservedRow(
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

async function observeOwnedRow(
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
    if (existing.ownerUserId === undefined || existing.managed !== true) {
      await ctx.db.patch(existing._id, {
        ownerUserId: userId,
        managed: false,
        familyId: existing.familyId ?? existing.keyId,
        disabled: true,
        graceUntil: undefined,
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
    managed: false,
    familyId: keyId,
    disabled: true,
    updatedAt: Date.now(),
  });
  const created = await ctx.db.get(id);
  if (created === null) throw new Error("Failed to register key");
  return { row: created, changed: true };
}

async function registerManagedRow(
  ctx: MutationCtx,
  clerkOrgId: string,
  userId: string,
  rawKeyId: string,
  options?: {
    familyId?: string;
    monthlyCapCredits?: number;
    rotatedFromKeyId?: string;
  },
): Promise<{ row: Doc<"keySettings">; changed: boolean }> {
  const keyId = validId(rawKeyId, "Key id");
  const familyId = validId(options?.familyId ?? keyId, "Key family");
  const existing = await ctx.db
    .query("keySettings")
    .withIndex("by_key", (q) => q.eq("keyId", keyId))
    .unique();
  const now = Date.now();
  if (existing !== null) {
    if (
      existing.clerkOrgId !== clerkOrgId ||
      (existing.ownerUserId !== undefined && existing.ownerUserId !== userId) ||
      (existing.managed === true &&
        (existing.familyId ?? existing.keyId) !== familyId)
    ) {
      throw new Error("Key unavailable");
    }
    await ctx.db.patch(existing._id, {
      ownerUserId: userId,
      managed: true,
      familyId,
      disabled: false,
      monthlyCapCredits: options?.monthlyCapCredits,
      rotatedFromKeyId: options?.rotatedFromKeyId,
      graceUntil: undefined,
      revokedAt: undefined,
      membershipRevokedAt: undefined,
      updatedAt: now,
    });
    const updated = await ctx.db.get(existing._id);
    if (updated === null) throw new Error("Failed to register key");
    return { row: updated, changed: true };
  }
  const id = await ctx.db.insert("keySettings", {
    clerkOrgId,
    ownerUserId: userId,
    keyId,
    managed: true,
    familyId,
    monthlyCapCredits: options?.monthlyCapCredits,
    disabled: false,
    rotatedFromKeyId: options?.rotatedFromKeyId,
    updatedAt: now,
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
      .take(2_000);
    return rows.map(toView);
  },
});

export type OrgKeyPolicyView = {
  policyId: string;
  ownerRef: string;
  keyLabel: string;
  monthlyCapCredits?: number;
  disabled: boolean;
  lifecycle: "active" | "disabled" | "grace" | "revoked";
  updatedAt: number;
};

async function toOrgPolicyView(
  row: Doc<"keySettings">,
): Promise<OrgKeyPolicyView> {
  const lifecycle =
    row.revokedAt !== undefined || row.membershipRevokedAt !== undefined
      ? "revoked"
      : currentLifecycle(row);
  return {
    policyId: await publicReference("key-policy", row.keyId),
    ownerRef: await publicReference("org-member", row.ownerUserId ?? "unknown"),
    keyLabel: maskedSuffix(row.keyId),
    monthlyCapCredits: row.monthlyCapCredits,
    disabled: row.managed !== true || row.disabled,
    lifecycle,
    updatedAt: row.updatedAt,
  };
}

/** Org admins get policy attribution without provider or Convex identifiers. */
export const listOrgPolicy = query({
  args: {},
  handler: async (ctx): Promise<OrgKeyPolicyView[]> => {
    const scope = await requireOrgScope(ctx);
    if (!scope.canManageOrgKeyPolicy) throw new Error("Org admin role required");
    const rows = await ctx.db
      .query("keySettings")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", scope.clerkOrgId))
      .take(2_000);
    return await Promise.all(
      rows.filter((row) => row.managed === true).map(toOrgPolicyView),
    );
  },
});

/** Admin cap/disable controls resolve opaque policy ids server-side. */
export const setOrgPolicy = mutation({
  args: {
    policyId: v.string(),
    monthlyCapCredits: v.optional(v.union(v.number(), v.null())),
    disabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<OrgKeyPolicyView> => {
    const scope = await requireOrgScope(ctx);
    if (!scope.canManageOrgKeyPolicy) throw new Error("Org admin role required");
    if (args.monthlyCapCredits === undefined && args.disabled === undefined) {
      throw new Error("Key policy change is required");
    }
    if (
      args.monthlyCapCredits !== undefined &&
      args.monthlyCapCredits !== null &&
      (!Number.isSafeInteger(args.monthlyCapCredits) ||
        args.monthlyCapCredits <= 0)
    ) {
      throw new Error("Cap must be a positive whole number of credits");
    }
    const rows = await ctx.db
      .query("keySettings")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", scope.clerkOrgId))
      .take(2_000);
    let selected: Doc<"keySettings"> | null = null;
    for (const row of rows) {
      if ((await publicReference("key-policy", row.keyId)) === args.policyId) {
        selected = row;
        break;
      }
    }
    if (selected === null || selected.ownerUserId === undefined) {
      throw new Error("Key policy unavailable");
    }
    if (
      args.disabled === false &&
      (selected.revokedAt !== undefined ||
        selected.membershipRevokedAt !== undefined ||
        (selected.graceUntil !== undefined &&
          selected.graceUntil <= Date.now()))
    ) {
      throw new Error("Revoked keys cannot be enabled");
    }
    const familyId = selected.familyId ?? selected.keyId;
    const family = await ctx.db
      .query("keySettings")
      .withIndex("by_family", (q) =>
        q
          .eq("clerkOrgId", scope.clerkOrgId)
          .eq("ownerUserId", selected!.ownerUserId)
          .eq("familyId", familyId),
      )
      .take(2_000);
    const targets = family.some((row) => row._id === selected!._id)
      ? family
      : [selected, ...family];
    const now = Date.now();
    let updatedSelected: Doc<"keySettings"> | null = null;
    for (const row of targets) {
      const patch: Partial<Doc<"keySettings">> = { updatedAt: now };
      if (args.monthlyCapCredits !== undefined) {
        patch.monthlyCapCredits =
          args.monthlyCapCredits === null
            ? undefined
            : args.monthlyCapCredits;
      }
      if (args.disabled !== undefined) patch.disabled = args.disabled;
      await ctx.db.patch(row._id, patch);
      const updated = await ctx.db.get(row._id);
      if (updated === null) throw new Error("Key policy unavailable");
      const lifecycle = currentLifecycle(updated);
      if (lifecycle === "disabled") {
        await publishTerminalKeyState(ctx, updated, "disabled", "disabled");
      } else {
        await enqueueKeyState(ctx, updated, lifecycle);
      }
      if (row._id === selected._id) updatedSelected = updated;
    }
    if (updatedSelected === null) throw new Error("Key policy unavailable");
    return await toOrgPolicyView(updatedSelected);
  },
});

/**
 * Record provider-visible keys without granting authority. Unknown keys enter a
 * disabled quarantine and can only be revoked; lifecycle completion is the only
 * path that upgrades one to a managed, enabled key.
 */
export const observeVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    keyIds: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<KeySettingView[]> => {
    if (args.keyIds.length > 500) throw new Error("Too many API keys");
    const views: KeySettingView[] = [];
    for (const keyId of args.keyIds) {
      const observed = await observeOwnedRow(
        ctx,
        args.clerkOrgId,
        args.userId,
        keyId,
      );
      if (observed.changed) {
        await enqueueKeyUpsert(ctx, observed.row);
        await publishTerminalKeyState(
          ctx,
          observed.row,
          "disabled",
          "provider_revoked",
        );
      }
      views.push(toView(observed.row));
    }
    return views;
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
    const selected = await ownedRow(
      ctx,
      args.clerkOrgId,
      args.userId,
      args.keyId,
    );
    const familyId = selected.familyId ?? selected.keyId;
    const family = await ctx.db
      .query("keySettings")
      .withIndex("by_family", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("ownerUserId", args.userId)
          .eq("familyId", familyId),
      )
      .take(2_000);
    const rows = family.some((row) => row._id === selected._id)
      ? family
      : [selected, ...family];
    const now = Date.now();
    const monthlyCapCredits =
      args.monthlyCapCredits === null ? undefined : args.monthlyCapCredits;
    let updatedSelected: Doc<"keySettings"> | null = null;
    for (const row of rows) {
      await ctx.db.patch(row._id, { monthlyCapCredits, updatedAt: now });
      const updated = await ctx.db.get(row._id);
      if (updated === null) throw new Error("Key unavailable");
      await enqueueKeyState(ctx, updated, currentLifecycle(updated));
      if (row._id === selected._id) updatedSelected = updated;
    }
    if (updatedSelected === null) throw new Error("Key unavailable");
    return toView(updatedSelected);
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
      const row = await ownedRow(ctx, args.clerkOrgId, args.userId, args.keyId);
      if (
        row.revokedAt !== undefined ||
        row.membershipRevokedAt !== undefined ||
        (row.graceUntil !== undefined && row.graceUntil <= Date.now())
      ) {
        throw new Error("Revoked keys cannot be enabled");
      }
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
    const lifecycle = currentLifecycle(updated);
    if (lifecycle === "disabled") {
      await publishTerminalKeyState(ctx, updated, "disabled", "disabled");
    } else {
      await enqueueKeyState(ctx, updated, lifecycle);
    }
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

async function establishMembershipFence(
  ctx: MutationCtx,
  clerkOrgId: string,
  userId: string,
  verifiedAt: number,
): Promise<number> {
  const now = Date.now();
  if (
    !Number.isFinite(verifiedAt) ||
    verifiedAt > now ||
    verifiedAt < now - 60_000
  ) {
    throw new Error("Fresh organization membership proof is required");
  }
  const state = await ctx.db
    .query("clerkMembershipStates")
    .withIndex("by_membership", (q) =>
      q.eq("clerkOrgId", clerkOrgId).eq("userId", userId),
    )
    .unique();
  if (state === null) {
    await ctx.db.insert("clerkMembershipStates", {
      clerkOrgId,
      userId,
      status: "active",
      revision: 0,
      updatedAt: now,
    });
    return 0;
  }
  if (state.status === "revoked") {
    // A deletion committed after (or in the same clock tick as) the provider
    // lookup wins. A later authoritative provider lookup can fence re-join.
    if (state.updatedAt >= verifiedAt) {
      throw new Error("Organization membership changed during key operation");
    }
    const revision = state.revision + 1;
    await ctx.db.patch(state._id, {
      status: "active",
      revision,
      updatedAt: now,
    });
    return revision;
  }
  return state.revision;
}

async function requireMembershipFence(
  ctx: MutationCtx,
  clerkOrgId: string,
  userId: string,
  revision: number | undefined,
): Promise<void> {
  if (revision === undefined) {
    throw new Error("Key operation membership fence is missing");
  }
  const state = await ctx.db
    .query("clerkMembershipStates")
    .withIndex("by_membership", (q) =>
      q.eq("clerkOrgId", clerkOrgId).eq("userId", userId),
    )
    .unique();
  if (
    state === null ||
    state.status !== "active" ||
    state.revision !== revision
  ) {
    throw new Error("Organization membership changed during key operation");
  }
}

export const beginCreateVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    requestedName: v.string(),
    membershipVerifiedAt: v.number(),
    leaseToken: v.string(),
  },
  handler: async (ctx, args) => {
    const operationId = validId(args.operationId, "Operation");
    const leaseToken = validId(args.leaseToken, "Lease");
    const requestedName = args.requestedName.trim();
    if (requestedName.length === 0 || requestedName.length > 64) {
      throw new Error("Key name is invalid");
    }
    const membershipRevision = await establishMembershipFence(
      ctx,
      args.clerkOrgId,
      args.userId,
      args.membershipVerifiedAt,
    );
    const existing = await lifecycleOperation(ctx, { ...args, operationId });
    if (existing) {
      if (
        existing.kind !== "create" ||
        existing.requestedName !== requestedName
      ) {
        throw new Error("Creation operation binding does not match");
      }
      return {
        ...existing,
        acquired:
          existing.status === "reserved" &&
          existing.leaseToken === leaseToken &&
          (existing.leaseExpiresAt ?? 0) > Date.now(),
      };
    }
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
        orphanReconciledAt: undefined,
        failure: "Reservation expired",
        updatedAt: Date.now(),
      });
    }
    const now = Date.now();
    const leaseExpiresAt = now + OPERATION_TTL_MS;
    const id = await ctx.db.insert("keyLifecycleOperations", {
      clerkOrgId: args.clerkOrgId,
      userId: args.userId,
      operationId,
      kind: "create",
      requestedName,
      membershipRevision,
      leaseToken,
      leaseExpiresAt,
      status: "reserved",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(
      leaseExpiresAt,
      internal.keyBroker.reconcileCreateOperation,
      {
        clerkOrgId: args.clerkOrgId,
        userId: args.userId,
        operationId,
        leaseToken,
      },
    );
    const created = await ctx.db.get(id);
    return created === null ? null : { ...created, acquired: true };
  },
});

export const completeCreateVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    keyId: v.string(),
    leaseToken: v.string(),
  },
  handler: async (ctx, args) => {
    const op = await lifecycleOperation(ctx, args);
    if (!op || op.kind !== "create") throw new Error("Creation unavailable");
    if (op.status === "completed") {
      if (op.keyId !== args.keyId || op.leaseToken !== args.leaseToken) {
        throw new Error("Creation completion binding does not match");
      }
      return op;
    }
    if (op.status !== "reserved") throw new Error("Creation unavailable");
    if (
      op.leaseToken !== args.leaseToken ||
      (op.leaseExpiresAt ?? 0) <= Date.now()
    ) {
      throw new Error("Creation reservation expired");
    }
    await requireMembershipFence(
      ctx,
      args.clerkOrgId,
      args.userId,
      op.membershipRevision,
    );
    const registered = await registerManagedRow(
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
    leaseToken: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const op = await lifecycleOperation(ctx, args);
    if (
      !op ||
      op.kind !== "create" ||
      op.status !== "reserved" ||
      op.leaseToken !== args.leaseToken
    ) {
      return op;
    }
    await ctx.db.patch(op._id, {
      status: "failed",
      orphanReconciledAt: undefined,
      failure: args.message.slice(0, 160),
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(
      SAGA_RECONCILE_DELAY_MS,
      internal.keyBroker.reconcileCreateOperation,
      {
        clerkOrgId: args.clerkOrgId,
        userId: args.userId,
        operationId: args.operationId,
        leaseToken: args.leaseToken,
        attempt: 1,
      },
    );
    return await ctx.db.get(op._id);
  },
});

/** Provider revoke won; force local state closed even after ambiguous completion. */
export const compensateCreatedKeyVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    keyId: v.string(),
    leaseToken: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const op = await lifecycleOperation(ctx, args);
    if (
      !op ||
      op.kind !== "create" ||
      op.leaseToken !== args.leaseToken ||
      (op.keyId !== undefined && op.keyId !== args.keyId) ||
      (op.status === "completed" && op.keyId !== args.keyId)
    ) {
      return op;
    }
    const row = await ctx.db
      .query("keySettings")
      .withIndex("by_key", (q) => q.eq("keyId", args.keyId))
      .unique();
    const now = Date.now();
    if (
      row !== null &&
      row.clerkOrgId === args.clerkOrgId &&
      row.ownerUserId === args.userId
    ) {
      await ctx.db.patch(row._id, {
        disabled: true,
        graceUntil: undefined,
        revokedAt: now,
        updatedAt: now,
      });
      const revoked = await ctx.db.get(row._id);
      if (revoked !== null) {
        await publishTerminalKeyState(
          ctx,
          revoked,
          "revoked",
          "provider_revoked",
        );
      }
    }
    await ctx.db.patch(op._id, {
      status: "failed",
      keyId: args.keyId,
      orphanReconciledAt: undefined,
      failure: args.message.slice(0, 160),
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      SAGA_RECONCILE_DELAY_MS,
      internal.keyBroker.reconcileCreateOperation,
      {
        clerkOrgId: args.clerkOrgId,
        userId: args.userId,
        operationId: args.operationId,
        leaseToken: args.leaseToken,
        attempt: 1,
      },
    );
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
    if (existing) {
      if (existing.kind !== "revoke" || existing.keyId !== args.keyId) {
        throw new Error("Revocation operation binding does not match");
      }
      return existing;
    }
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
    const row = await ownedObservedRow(
      ctx,
      args.clerkOrgId,
      args.userId,
      args.keyId,
    );
    const now = Date.now();
    const leaseExpiresAt = now + OPERATION_TTL_MS;
    const id = await ctx.db.insert("keyLifecycleOperations", {
      clerkOrgId: args.clerkOrgId,
      userId: args.userId,
      operationId,
      kind: "revoke",
      status: "reserved",
      keyId: args.keyId,
      previousDisabled: row.disabled,
      leaseExpiresAt,
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
    await publishTerminalKeyState(ctx, disabled, "disabled", "admin_revoked");
    await ctx.scheduler.runAt(
      leaseExpiresAt,
      internal.keyBroker.reconcileRevokedKey,
      {
        clerkOrgId: args.clerkOrgId,
        userId: args.userId,
        operationId,
        keyId: args.keyId,
      },
    );
    return await ctx.db.get(id);
  },
});

export const completeRevokeVerified = internalMutation({
  args: { clerkOrgId: v.string(), userId: v.string(), operationId: v.string() },
  handler: async (ctx, args) => {
    const op = await lifecycleOperation(ctx, args);
    if (!op || op.kind !== "revoke") throw new Error("Revocation unavailable");
    if (op.status === "completed") return op;
    if (op.status !== "reserved" && op.status !== "failed") {
      throw new Error("Revocation unavailable");
    }
    if (!op.keyId) throw new Error("Revocation unavailable");
    const row = await ownedObservedRow(
      ctx,
      args.clerkOrgId,
      args.userId,
      op.keyId,
    );
    const now = Date.now();
    await ctx.db.patch(row._id, {
      disabled: true,
      graceUntil: undefined,
      revokedAt: now,
      updatedAt: now,
    });
    const revoked = await ctx.db.get(row._id);
    if (revoked === null) throw new Error("Key unavailable");
    await publishTerminalKeyState(ctx, revoked, "revoked", "admin_revoked");
    await ctx.db.patch(op._id, {
      status: "completed",
      orphanReconciledAt: now,
      updatedAt: now,
    });
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
      const row = await ownedObservedRow(
        ctx,
        args.clerkOrgId,
        args.userId,
        op.keyId,
      );
      const now = Date.now();
      await ctx.db.patch(row._id, {
        disabled: true,
        graceUntil: undefined,
        revokedAt: row.revokedAt ?? now,
        updatedAt: now,
      });
      const closed = await ctx.db.get(row._id);
      if (closed === null) throw new Error("Key unavailable");
      await publishTerminalKeyState(ctx, closed, "revoked", "admin_revoked");
    }
    await ctx.db.patch(op._id, {
      status: "failed",
      orphanReconciledAt: undefined,
      failure: args.message.slice(0, 160),
      updatedAt: Date.now(),
    });
    if (op.keyId) {
      await ctx.scheduler.runAfter(0, internal.keyBroker.reconcileRevokedKey, {
        clerkOrgId: args.clerkOrgId,
        userId: args.userId,
        operationId: args.operationId,
        keyId: op.keyId,
        attempt: 0,
      });
    }
    return await ctx.db.get(op._id);
  },
});

export const beginRotationVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    oldKeyId: v.string(),
    requestedName: v.string(),
    membershipVerifiedAt: v.number(),
    leaseToken: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ownedRow(
      ctx,
      args.clerkOrgId,
      args.userId,
      args.oldKeyId,
    );
    if (row.disabled || row.revokedAt !== undefined) {
      throw new Error("Key unavailable");
    }
    const operationId = validId(args.operationId, "Operation");
    const leaseToken = validId(args.leaseToken, "Lease");
    const requestedName = args.requestedName.trim();
    if (requestedName.length === 0 || requestedName.length > 64) {
      throw new Error("Key name is invalid");
    }
    const membershipRevision = await establishMembershipFence(
      ctx,
      args.clerkOrgId,
      args.userId,
      args.membershipVerifiedAt,
    );
    const existing = await ctx.db
      .query("keyRotationOperations")
      .withIndex("by_operation", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("userId", args.userId)
          .eq("operationId", operationId),
      )
      .unique();
    if (existing) {
      if (
        existing.oldKeyId !== args.oldKeyId ||
        existing.requestedName !== requestedName
      ) {
        throw new Error("Rotation operation binding does not match");
      }
      return {
        ...existing,
        acquired:
          existing.status === "reserved" &&
          existing.leaseToken === leaseToken &&
          (existing.leaseExpiresAt ?? 0) > Date.now(),
      };
    }
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
    const create = await ctx.db
      .query("keyLifecycleOperations")
      .withIndex("by_active_kind", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("userId", args.userId)
          .eq("kind", "create")
          .eq("status", "reserved"),
      )
      .unique();
    if (create && (create.leaseExpiresAt ?? create.updatedAt) > Date.now()) {
      throw new Error("Key creation is in progress");
    }
    const owned = await ctx.db
      .query("keySettings")
      .withIndex("by_owner", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("ownerUserId", args.userId),
      )
      .take(3);
    if (
      owned.some(
        (candidate) =>
          candidate.keyId !== args.oldKeyId &&
          candidate.managed !== false &&
          !candidate.disabled &&
          candidate.graceUntil !== undefined &&
          candidate.graceUntil > Date.now(),
      )
    ) {
      throw new Error("A previous rotation grace period is still active");
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
        orphanReconciledAt: undefined,
        failure: "Reservation expired",
        updatedAt: Date.now(),
      });
    }
    const now = Date.now();
    const leaseExpiresAt = now + OPERATION_TTL_MS;
    const id = await ctx.db.insert("keyRotationOperations", {
      clerkOrgId: args.clerkOrgId,
      userId: args.userId,
      operationId,
      oldKeyId: args.oldKeyId,
      requestedName,
      membershipRevision,
      leaseToken,
      leaseExpiresAt,
      status: "reserved",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(
      leaseExpiresAt,
      internal.keyBroker.reconcileRotationOperation,
      {
        clerkOrgId: args.clerkOrgId,
        userId: args.userId,
        operationId,
        leaseToken,
      },
    );
    const created = await ctx.db.get(id);
    return created === null ? null : { ...created, acquired: true };
  },
});

export const completeRotationVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    oldKeyId: v.string(),
    newKeyId: v.string(),
    leaseToken: v.string(),
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
    if (op.status === "completed") {
      if (op.newKeyId !== args.newKeyId || op.leaseToken !== args.leaseToken) {
        throw new Error("Rotation completion binding does not match");
      }
      return op;
    }
    if (op.status !== "reserved") throw new Error("Rotation unavailable");
    if (
      op.leaseToken !== args.leaseToken ||
      (op.leaseExpiresAt ?? 0) <= Date.now()
    ) {
      throw new Error("Rotation reservation expired");
    }
    if (args.newKeyId === args.oldKeyId) {
      throw new Error("Replacement key must differ from old key");
    }
    await requireMembershipFence(
      ctx,
      args.clerkOrgId,
      args.userId,
      op.membershipRevision,
    );
    const old = await ownedRow(
      ctx,
      args.clerkOrgId,
      args.userId,
      args.oldKeyId,
    );
    if (old.disabled || old.revokedAt !== undefined) {
      throw new Error("Rotation unavailable");
    }
    const now = Date.now();
    const graceUntil = now + ROTATION_GRACE_MS;
    const oldUpdated = await patchOwned(
      ctx,
      args.clerkOrgId,
      args.userId,
      args.oldKeyId,
      {
        familyId: old.familyId ?? old.keyId,
        graceUntil,
      },
    );
    const next = await registerManagedRow(
      ctx,
      args.clerkOrgId,
      args.userId,
      args.newKeyId,
      {
        familyId: old.familyId ?? old.keyId,
        monthlyCapCredits: old.monthlyCapCredits,
        rotatedFromKeyId: args.oldKeyId,
      },
    );
    await enqueueKeyState(ctx, oldUpdated, "grace");
    await enqueueKeyUpsert(ctx, next.row);
    await enqueueKeyState(ctx, next.row, currentLifecycle(next.row));
    await ctx.db.patch(op._id, {
      status: "completed",
      newKeyId: args.newKeyId,
      graceUntil,
      autoRevokeStatus: "scheduled",
      autoRevokeAttempts: 0,
      autoRevokeLeaseUntil: undefined,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(
      graceUntil,
      internal.keyBroker.revokeExpiredRotation,
      {
        clerkOrgId: args.clerkOrgId,
        userId: args.userId,
        operationId: args.operationId,
      },
    );
    return await ctx.db.get(op._id);
  },
});

export const failRotationVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    leaseToken: v.string(),
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
    if (!op || op.status !== "reserved" || op.leaseToken !== args.leaseToken) {
      return op;
    }
    await ctx.db.patch(op._id, {
      status: "failed",
      orphanReconciledAt: undefined,
      failure: args.message.slice(0, 160),
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(
      SAGA_RECONCILE_DELAY_MS,
      internal.keyBroker.reconcileRotationOperation,
      {
        clerkOrgId: args.clerkOrgId,
        userId: args.userId,
        operationId: args.operationId,
        leaseToken: args.leaseToken,
        attempt: 1,
      },
    );
    return await ctx.db.get(op._id);
  },
});

/** Roll back local lineage after replacement key was physically revoked. */
export const compensateRotationVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    oldKeyId: v.string(),
    newKeyId: v.string(),
    leaseToken: v.string(),
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
    if (
      !op ||
      op.oldKeyId !== args.oldKeyId ||
      op.leaseToken !== args.leaseToken ||
      (op.newKeyId !== undefined && op.newKeyId !== args.newKeyId) ||
      (op.status === "completed" && op.newKeyId !== args.newKeyId)
    ) {
      return op;
    }
    const now = Date.now();
    const replacement = await ctx.db
      .query("keySettings")
      .withIndex("by_key", (q) => q.eq("keyId", args.newKeyId))
      .unique();
    if (
      replacement !== null &&
      replacement.clerkOrgId === args.clerkOrgId &&
      replacement.ownerUserId === args.userId
    ) {
      await ctx.db.patch(replacement._id, {
        disabled: true,
        graceUntil: undefined,
        revokedAt: now,
        updatedAt: now,
      });
      const revoked = await ctx.db.get(replacement._id);
      if (revoked !== null) {
        await publishTerminalKeyState(
          ctx,
          revoked,
          "revoked",
          "provider_revoked",
        );
      }
    }
    const old = await ctx.db
      .query("keySettings")
      .withIndex("by_key", (q) => q.eq("keyId", args.oldKeyId))
      .unique();
    if (
      old !== null &&
      old.clerkOrgId === args.clerkOrgId &&
      old.ownerUserId === args.userId
    ) {
      const membershipRevoked = old.membershipRevokedAt !== undefined;
      await ctx.db.patch(old._id, {
        disabled: membershipRevoked,
        graceUntil: undefined,
        updatedAt: now,
      });
      const restored = await ctx.db.get(old._id);
      if (restored !== null) {
        await enqueueKeyState(
          ctx,
          restored,
          membershipRevoked ? "revoked" : "active",
        );
      }
    }
    await ctx.db.patch(op._id, {
      status: "failed",
      newKeyId: args.newKeyId,
      graceUntil: undefined,
      autoRevokeStatus: undefined,
      autoRevokeLeaseUntil: undefined,
      orphanReconciledAt: undefined,
      failure: args.message.slice(0, 160),
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      SAGA_RECONCILE_DELAY_MS,
      internal.keyBroker.reconcileRotationOperation,
      {
        clerkOrgId: args.clerkOrgId,
        userId: args.userId,
        operationId: args.operationId,
        leaseToken: args.leaseToken,
        attempt: 1,
      },
    );
    return await ctx.db.get(op._id);
  },
});

export const expireCreateVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    leaseToken: v.string(),
  },
  handler: async (ctx, args) => {
    const op = await lifecycleOperation(ctx, args);
    if (!op || op.kind !== "create" || op.leaseToken !== args.leaseToken) {
      return null;
    }
    if (op.status === "completed" || op.orphanReconciledAt !== undefined) {
      return null;
    }
    if (op.status === "reserved") {
      if ((op.leaseExpiresAt ?? 0) > Date.now()) return null;
      await ctx.db.patch(op._id, {
        status: "failed",
        orphanReconciledAt: undefined,
        failure: "Reservation expired; orphan reconciliation started",
        updatedAt: Date.now(),
      });
    }
    return await ctx.db.get(op._id);
  },
});

export const expireRotationVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    leaseToken: v.string(),
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
    if (!op || op.leaseToken !== args.leaseToken) {
      return null;
    }
    if (op.status === "completed" || op.orphanReconciledAt !== undefined) {
      return null;
    }
    if (op.status === "reserved") {
      if ((op.leaseExpiresAt ?? 0) > Date.now()) return null;
      await ctx.db.patch(op._id, {
        status: "failed",
        orphanReconciledAt: undefined,
        failure: "Reservation expired; orphan reconciliation started",
        updatedAt: Date.now(),
      });
    }
    return await ctx.db.get(op._id);
  },
});

export const claimRevokeReconciliation = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    keyId: v.string(),
  },
  handler: async (ctx, args) => {
    const op = await lifecycleOperation(ctx, args);
    if (!op || op.kind !== "revoke" || op.keyId !== args.keyId) return null;
    if (op.status === "completed") return null;
    const now = Date.now();
    if (
      op.status === "reserved" &&
      (op.leaseExpiresAt ?? op.updatedAt + OPERATION_TTL_MS) > now
    ) {
      return null;
    }
    if (op.status === "reserved") {
      await ctx.db.patch(op._id, {
        status: "failed",
        orphanReconciledAt: undefined,
        failure: "Revocation reservation expired; cleanup resumed",
        updatedAt: now,
      });
    }
    return await ctx.db.get(op._id);
  },
});

export const markSagaReconciled = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    leaseToken: v.string(),
    kind: v.union(v.literal("create"), v.literal("rotation")),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const now = Date.now();
    if (args.kind === "create") {
      const op = await lifecycleOperation(ctx, args);
      if (
        !op ||
        op.kind !== "create" ||
        op.status !== "failed" ||
        op.leaseToken !== args.leaseToken
      ) {
        return false;
      }
      await ctx.db.patch(op._id, {
        orphanReconciledAt: now,
        updatedAt: now,
      });
      return true;
    }
    const op = await ctx.db
      .query("keyRotationOperations")
      .withIndex("by_operation", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("userId", args.userId)
          .eq("operationId", args.operationId),
      )
      .unique();
    if (!op || op.status !== "failed" || op.leaseToken !== args.leaseToken) {
      return false;
    }
    await ctx.db.patch(op._id, {
      orphanReconciledAt: now,
      updatedAt: now,
    });
    return true;
  },
});

/** Requeue expired reservations and stale failures after scheduler/action loss. */
export const resumeStaleSagaCleanup = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const now = Date.now();
    const cutoff = now - OPERATION_TTL_MS;
    const [expiredLifecycle, lifecycle, expiredRotations, rotations] =
      await Promise.all([
        ctx.db
          .query("keyLifecycleOperations")
          .withIndex("by_lease_expiry", (q) =>
            q.eq("status", "reserved").lte("leaseExpiresAt", now),
          )
          .take(20),
        ctx.db
          .query("keyLifecycleOperations")
          .withIndex("by_reconcile", (q) =>
            q
              .eq("status", "failed")
              .eq("orphanReconciledAt", undefined)
              .lte("updatedAt", cutoff),
          )
          .take(20),
        ctx.db
          .query("keyRotationOperations")
          .withIndex("by_lease_expiry", (q) =>
            q.eq("status", "reserved").lte("leaseExpiresAt", now),
          )
          .take(20),
        ctx.db
          .query("keyRotationOperations")
          .withIndex("by_reconcile", (q) =>
            q
              .eq("status", "failed")
              .eq("orphanReconciledAt", undefined)
              .lte("updatedAt", cutoff),
          )
          .take(20),
      ]);
    let scheduled = 0;
    for (const op of expiredLifecycle) {
      if (op.kind === "create" && op.leaseToken !== undefined) {
        await ctx.scheduler.runAfter(
          0,
          internal.keyBroker.reconcileCreateOperation,
          {
            clerkOrgId: op.clerkOrgId,
            userId: op.userId,
            operationId: op.operationId,
            leaseToken: op.leaseToken,
            attempt: 0,
          },
        );
        scheduled += 1;
      } else if (op.kind === "revoke" && op.keyId !== undefined) {
        await ctx.scheduler.runAfter(
          0,
          internal.keyBroker.reconcileRevokedKey,
          {
            clerkOrgId: op.clerkOrgId,
            userId: op.userId,
            operationId: op.operationId,
            keyId: op.keyId,
            attempt: 0,
          },
        );
        scheduled += 1;
      }
    }
    for (const op of expiredRotations) {
      if (op.leaseToken === undefined) continue;
      await ctx.scheduler.runAfter(
        0,
        internal.keyBroker.reconcileRotationOperation,
        {
          clerkOrgId: op.clerkOrgId,
          userId: op.userId,
          operationId: op.operationId,
          leaseToken: op.leaseToken,
          attempt: 0,
        },
      );
      scheduled += 1;
    }
    for (const op of lifecycle) {
      await ctx.db.patch(op._id, { updatedAt: now });
      if (op.kind === "create" && op.leaseToken !== undefined) {
        await ctx.scheduler.runAfter(
          0,
          internal.keyBroker.reconcileCreateOperation,
          {
            clerkOrgId: op.clerkOrgId,
            userId: op.userId,
            operationId: op.operationId,
            leaseToken: op.leaseToken,
            attempt: 1,
          },
        );
        scheduled += 1;
      } else if (op.kind === "revoke" && op.keyId !== undefined) {
        await ctx.scheduler.runAfter(
          0,
          internal.keyBroker.reconcileRevokedKey,
          {
            clerkOrgId: op.clerkOrgId,
            userId: op.userId,
            operationId: op.operationId,
            keyId: op.keyId,
            attempt: 0,
          },
        );
        scheduled += 1;
      }
    }
    for (const op of rotations) {
      await ctx.db.patch(op._id, { updatedAt: now });
      if (op.leaseToken === undefined) continue;
      await ctx.scheduler.runAfter(
        0,
        internal.keyBroker.reconcileRotationOperation,
        {
          clerkOrgId: op.clerkOrgId,
          userId: op.userId,
          operationId: op.operationId,
          leaseToken: op.leaseToken,
          attempt: 1,
        },
      );
      scheduled += 1;
    }
    return { scheduled };
  },
});

export const claimExpiredRotationRevoke = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
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
    if (
      !op ||
      op.status !== "completed" ||
      op.newKeyId === undefined ||
      op.graceUntil === undefined ||
      op.graceUntil > Date.now() ||
      op.autoRevokeStatus === "revoked" ||
      op.autoRevokeStatus === "failed"
    ) {
      return null;
    }
    const now = Date.now();
    if (
      op.autoRevokeStatus === "revoking" &&
      (op.autoRevokeLeaseUntil ?? 0) > now
    ) {
      return null;
    }
    const old = await ownedObservedRow(
      ctx,
      args.clerkOrgId,
      args.userId,
      op.oldKeyId,
    );
    await ctx.db.patch(old._id, {
      disabled: true,
      graceUntil: undefined,
      updatedAt: now,
    });
    const disabled = await ctx.db.get(old._id);
    if (disabled === null) throw new Error("Rotation key unavailable");
    await publishTerminalKeyState(ctx, disabled, "revoked", "rotated");
    await ctx.db.patch(op._id, {
      autoRevokeStatus: "revoking",
      autoRevokeAttempts: (op.autoRevokeAttempts ?? 0) + 1,
      autoRevokeLeaseUntil: now + AUTO_REVOKE_LEASE_MS,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      AUTO_REVOKE_LEASE_MS,
      internal.keyBroker.revokeExpiredRotation,
      args,
    );
    return await ctx.db.get(op._id);
  },
});

export const completeExpiredRotationRevoke = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    oldKeyId: v.string(),
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
    if (!op || op.oldKeyId !== args.oldKeyId || op.status !== "completed") {
      throw new Error("Rotation revocation unavailable");
    }
    if (op.autoRevokeStatus === "revoked") return op;
    if (op.autoRevokeStatus !== "revoking") {
      throw new Error("Rotation revocation unavailable");
    }
    const old = await ownedObservedRow(
      ctx,
      args.clerkOrgId,
      args.userId,
      args.oldKeyId,
    );
    const now = Date.now();
    await ctx.db.patch(old._id, {
      disabled: true,
      graceUntil: undefined,
      revokedAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(op._id, {
      autoRevokeStatus: "revoked",
      autoRevokeLeaseUntil: undefined,
      oldKeyRevokedAt: now,
      autoRevokeFailure: undefined,
      updatedAt: now,
    });
    return await ctx.db.get(op._id);
  },
});

export const retryExpiredRotationRevoke = internalMutation({
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
    if (!op || op.autoRevokeStatus !== "revoking") return op;
    const attempts = op.autoRevokeAttempts ?? 1;
    const terminal = attempts >= 5;
    await ctx.db.patch(op._id, {
      autoRevokeStatus: terminal ? "failed" : "scheduled",
      autoRevokeLeaseUntil: undefined,
      autoRevokeFailure: args.message.slice(0, 160),
      updatedAt: Date.now(),
    });
    if (!terminal) {
      const delay = Math.min(60 * 60_000, 2 ** attempts * 60_000);
      await ctx.scheduler.runAfter(
        delay,
        internal.keyBroker.revokeExpiredRotation,
        {
          clerkOrgId: args.clerkOrgId,
          userId: args.userId,
          operationId: args.operationId,
        },
      );
    }
    return await ctx.db.get(op._id);
  },
});

/** Recover lost due messages, expired action leases, and cooled failures. */
export const resumeDueAutoRevokes = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const now = Date.now();
    const [due, expiredLeases, failed] = await Promise.all([
      ctx.db
        .query("keyRotationOperations")
        .withIndex("by_auto_revoke_due", (q) =>
          q.eq("autoRevokeStatus", "scheduled").lte("graceUntil", now),
        )
        .take(20),
      ctx.db
        .query("keyRotationOperations")
        .withIndex("by_auto_revoke_lease", (q) =>
          q.eq("autoRevokeStatus", "revoking").lte("autoRevokeLeaseUntil", now),
        )
        .take(20),
      ctx.db
        .query("keyRotationOperations")
        .withIndex("by_auto_revoke", (q) =>
          q
            .eq("autoRevokeStatus", "failed")
            .lte("updatedAt", now - 60 * 60_000),
        )
        .take(20),
    ]);
    for (const op of [...due, ...expiredLeases]) {
      await ctx.scheduler.runAfter(
        0,
        internal.keyBroker.revokeExpiredRotation,
        {
          clerkOrgId: op.clerkOrgId,
          userId: op.userId,
          operationId: op.operationId,
        },
      );
    }
    for (const op of failed) {
      await ctx.db.patch(op._id, {
        autoRevokeStatus: "scheduled",
        autoRevokeAttempts: 0,
        autoRevokeLeaseUntil: undefined,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.keyBroker.revokeExpiredRotation,
        {
          clerkOrgId: op.clerkOrgId,
          userId: op.userId,
          operationId: op.operationId,
        },
      );
    }
    return { scheduled: due.length + expiredLeases.length + failed.length };
  },
});

const MEMBERSHIP_CLEANUP_LEASE_MS = 2 * 60_000;

async function ensureMembershipCleanupJob(
  ctx: MutationCtx,
  clerkOrgId: string,
  userId: string,
  membershipRevision: number,
  resume = false,
): Promise<void> {
  const now = Date.now();
  let shouldSchedule = true;
  const existing = await ctx.db
    .query("membershipCleanupJobs")
    .withIndex("by_membership", (q) =>
      q.eq("clerkOrgId", clerkOrgId).eq("userId", userId),
    )
    .unique();
  if (existing === null) {
    await ctx.db.insert("membershipCleanupJobs", {
      clerkOrgId,
      userId,
      membershipRevision,
      status: "pending",
      attempts: 0,
      zeroVerificationPasses: 0,
      cursorOffset: 0,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
    });
  } else if (existing.membershipRevision !== membershipRevision) {
    await ctx.db.patch(existing._id, {
      membershipRevision,
      status: "pending",
      attempts: 0,
      zeroVerificationPasses: 0,
      cursorOffset: 0,
      scanExpectedTotal: undefined,
      scanProviderIds: undefined,
      previousZeroFingerprint: undefined,
      leaseToken: undefined,
      leaseUntil: undefined,
      nextRunAt: now,
      lastErrorCode: undefined,
      updatedAt: now,
      completedAt: undefined,
    });
  } else if (resume && existing.status !== "completed") {
    await ctx.db.patch(existing._id, {
      status: "pending",
      leaseToken: undefined,
      leaseUntil: undefined,
      nextRunAt: now,
      updatedAt: now,
    });
  } else if (existing.status === "completed") {
    shouldSchedule = false;
  }
  if (shouldSchedule) {
    await ctx.scheduler.runAfter(0, internal.keyBroker.revokeMembershipKeys, {
      clerkOrgId,
      userId,
    });
  }
}

/** Verified Clerk membership deletion closes every local spending gate first. */
export const revokeMembershipVerified = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    svixId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ duplicate: boolean; keyIds: string[] }> => {
    const prior = await ctx.db
      .query("clerkWebhookReceipts")
      .withIndex("by_svix_id", (q) => q.eq("svixId", args.svixId))
      .unique();
    if (prior !== null) {
      const membership = await ctx.db
        .query("clerkMembershipStates")
        .withIndex("by_membership", (q) =>
          q.eq("clerkOrgId", args.clerkOrgId).eq("userId", args.userId),
        )
        .unique();
      if (membership?.status === "revoked") {
        await ensureMembershipCleanupJob(
          ctx,
          args.clerkOrgId,
          args.userId,
          membership.revision,
          true,
        );
      }
      return { duplicate: true, keyIds: [] };
    }
    const now = Date.now();
    await ctx.db.insert("clerkWebhookReceipts", {
      svixId: args.svixId,
      eventType: "organizationMembership.deleted",
      receivedAt: now,
    });
    const membership = await ctx.db
      .query("clerkMembershipStates")
      .withIndex("by_membership", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("userId", args.userId),
      )
      .unique();
    const membershipRevision =
      membership === null ? 1 : membership.revision + 1;
    if (membership === null) {
      await ctx.db.insert("clerkMembershipStates", {
        clerkOrgId: args.clerkOrgId,
        userId: args.userId,
        status: "revoked",
        revision: membershipRevision,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(membership._id, {
        status: "revoked",
        revision: membershipRevision,
        updatedAt: now,
      });
    }
    const rows = await ctx.db
      .query("keySettings")
      .withIndex("by_owner", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("ownerUserId", args.userId),
      )
      // Broker refuses more than 2,000 provider keys. Reading that full bound
      // makes membership deletion one immediate fail-closed projection. Include
      // already-disabled rows so re-adding the member cannot resurrect them.
      .take(2_000);
    const rotations = await ctx.db
      .query("keyRotationOperations")
      .withIndex("by_operation", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("userId", args.userId),
      )
      .take(2_000);
    for (const row of rows) {
      await ctx.db.patch(row._id, {
        disabled: true,
        graceUntil: undefined,
        membershipRevokedAt: now,
        updatedAt: now,
      });
      const disabled = await ctx.db.get(row._id);
      if (disabled !== null) {
        await publishTerminalKeyState(
          ctx,
          disabled,
          "revoked",
          "membership_deleted",
        );
      }
    }
    for (const rotation of rotations) {
      if (rotation.status === "reserved") {
        await ctx.db.patch(rotation._id, {
          status: "failed",
          orphanReconciledAt: undefined,
          failure: "Organization membership deleted",
          updatedAt: now,
        });
        if (rotation.leaseToken !== undefined) {
          await ctx.scheduler.runAfter(
            SAGA_RECONCILE_DELAY_MS,
            internal.keyBroker.reconcileRotationOperation,
            {
              clerkOrgId: args.clerkOrgId,
              userId: args.userId,
              operationId: rotation.operationId,
              leaseToken: rotation.leaseToken,
              attempt: 1,
            },
          );
        }
      }
    }
    const create = await ctx.db
      .query("keyLifecycleOperations")
      .withIndex("by_active_kind", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("userId", args.userId)
          .eq("kind", "create")
          .eq("status", "reserved"),
      )
      .unique();
    if (create !== null) {
      await ctx.db.patch(create._id, {
        status: "failed",
        orphanReconciledAt: undefined,
        failure: "Organization membership deleted",
        updatedAt: now,
      });
      if (create.leaseToken !== undefined) {
        await ctx.scheduler.runAfter(
          SAGA_RECONCILE_DELAY_MS,
          internal.keyBroker.reconcileCreateOperation,
          {
            clerkOrgId: args.clerkOrgId,
            userId: args.userId,
            operationId: create.operationId,
            leaseToken: create.leaseToken,
            attempt: 1,
          },
        );
      }
    }
    await ensureMembershipCleanupJob(
      ctx,
      args.clerkOrgId,
      args.userId,
      membershipRevision,
      true,
    );
    return { duplicate: false, keyIds: rows.map((row) => row.keyId) };
  },
});

/** Lease one exact revoked-membership cleanup revision. */
export const claimMembershipCleanup = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    leaseToken: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.leaseToken.length < 16 || args.leaseToken.length > 128) {
      throw new Error("Membership cleanup lease is invalid");
    }
    const job = await ctx.db
      .query("membershipCleanupJobs")
      .withIndex("by_membership", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("userId", args.userId),
      )
      .unique();
    if (job === null || job.status === "completed") return null;
    const membership = await ctx.db
      .query("clerkMembershipStates")
      .withIndex("by_membership", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("userId", args.userId),
      )
      .unique();
    if (
      membership === null ||
      membership.status !== "revoked" ||
      membership.revision !== job.membershipRevision
    ) {
      const now = Date.now();
      await ctx.db.patch(job._id, {
        status: "completed",
        leaseToken: undefined,
        leaseUntil: undefined,
        lastErrorCode: "superseded",
        nextRunAt: now,
        updatedAt: now,
        completedAt: now,
      });
      return null;
    }
    const now = Date.now();
    if (job.status === "running" && (job.leaseUntil ?? 0) > now) return null;
    const leaseUntil = now + MEMBERSHIP_CLEANUP_LEASE_MS;
    await ctx.db.patch(job._id, {
      status: "running",
      attempts: job.attempts + 1,
      leaseToken: args.leaseToken,
      leaseUntil,
      updatedAt: now,
    });
    return {
      membershipRevision: job.membershipRevision,
      zeroVerificationPasses: job.zeroVerificationPasses,
      cursorOffset: job.cursorOffset ?? 0,
      scanExpectedTotal: job.scanExpectedTotal,
    };
  },
});

/**
 * Persist one provider page. Revocations restart from offset zero; only two
 * identical, complete zero-live-key snapshots can complete cleanup.
 */
export const recordMembershipCleanupPage = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    membershipRevision: v.number(),
    leaseToken: v.string(),
    cursorOffset: v.number(),
    totalCount: v.number(),
    providerIds: v.array(v.string()),
    liveKeysObserved: v.boolean(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const job = await ctx.db
      .query("membershipCleanupJobs")
      .withIndex("by_membership", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("userId", args.userId),
      )
      .unique();
    if (
      job === null ||
      job.status !== "running" ||
      job.membershipRevision !== args.membershipRevision ||
      job.leaseToken !== args.leaseToken
    ) {
      return false;
    }
    const membership = await ctx.db
      .query("clerkMembershipStates")
      .withIndex("by_membership", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("userId", args.userId),
      )
      .unique();
    if (
      membership === null ||
      membership.status !== "revoked" ||
      membership.revision !== args.membershipRevision
    ) {
      return false;
    }
    const now = Date.now();
    const schedule = async (delayMs: number) => {
      await ctx.scheduler.runAfter(
        delayMs,
        internal.keyBroker.revokeMembershipKeys,
        {
          clerkOrgId: args.clerkOrgId,
          userId: args.userId,
        },
      );
    };
    const restart = async (errorCode?: string) => {
      await ctx.db.patch(job._id, {
        status: "pending",
        zeroVerificationPasses: 0,
        cursorOffset: 0,
        scanExpectedTotal: undefined,
        scanProviderIds: undefined,
        previousZeroFingerprint: undefined,
        leaseToken: undefined,
        leaseUntil: undefined,
        nextRunAt: now + 1_000,
        lastErrorCode: errorCode,
        updatedAt: now,
      });
      await schedule(1_000);
    };

    if (args.liveKeysObserved) {
      await restart();
      return false;
    }
    if (
      !Number.isSafeInteger(args.cursorOffset) ||
      args.cursorOffset < 0 ||
      args.cursorOffset !== (job.cursorOffset ?? 0) ||
      !Number.isSafeInteger(args.totalCount) ||
      args.totalCount < 0 ||
      args.totalCount > 2_000 ||
      args.providerIds.length > 500 ||
      args.providerIds.some((id) => id.length < 1 || id.length > 256)
    ) {
      await restart("provider_page_invalid");
      return false;
    }
    if (
      job.scanExpectedTotal !== undefined &&
      job.scanExpectedTotal !== args.totalCount
    ) {
      await restart("provider_changed");
      return false;
    }
    const priorIds = job.scanProviderIds ?? [];
    const seen = new Set(priorIds);
    if (
      args.providerIds.some((id) => {
        if (seen.has(id)) return true;
        seen.add(id);
        return false;
      })
    ) {
      await restart("provider_changed");
      return false;
    }
    const allIds = [...priorIds, ...args.providerIds];
    const nextOffset = args.cursorOffset + args.providerIds.length;
    if (
      nextOffset > args.totalCount ||
      (args.providerIds.length === 0 && nextOffset < args.totalCount)
    ) {
      await restart("provider_page_invalid");
      return false;
    }
    if (nextOffset < args.totalCount) {
      await ctx.db.patch(job._id, {
        status: "pending",
        cursorOffset: nextOffset,
        scanExpectedTotal: args.totalCount,
        scanProviderIds: allIds,
        leaseToken: undefined,
        leaseUntil: undefined,
        nextRunAt: now,
        lastErrorCode: undefined,
        updatedAt: now,
      });
      await schedule(0);
      return false;
    }
    if (allIds.length !== args.totalCount) {
      await restart("provider_page_invalid");
      return false;
    }

    const fingerprint = await publicReference(
      "membership-cleanup-snapshot",
      JSON.stringify([...allIds].sort((left, right) => left.localeCompare(right))),
    );
    const sameAsPrevious =
      job.zeroVerificationPasses >= 1 &&
      job.previousZeroFingerprint === fingerprint;
    if (sameAsPrevious) {
      await ctx.db.patch(job._id, {
        status: "completed",
        zeroVerificationPasses: 2,
        cursorOffset: 0,
        scanExpectedTotal: undefined,
        scanProviderIds: undefined,
        previousZeroFingerprint: fingerprint,
        leaseToken: undefined,
        leaseUntil: undefined,
        nextRunAt: now,
        lastErrorCode: undefined,
        updatedAt: now,
        completedAt: now,
      });
      return true;
    }
    await ctx.db.patch(job._id, {
      status: "pending",
      zeroVerificationPasses: 1,
      cursorOffset: 0,
      scanExpectedTotal: undefined,
      scanProviderIds: undefined,
      previousZeroFingerprint: fingerprint,
      leaseToken: undefined,
      leaseUntil: undefined,
      nextRunAt: now + 1_000,
      lastErrorCode: undefined,
      updatedAt: now,
    });
    await schedule(1_000);
    return false;
  },
});

/** Failures remain durable forever with bounded backoff and safe error codes. */
export const retryMembershipCleanup = internalMutation({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    membershipRevision: v.number(),
    leaseToken: v.string(),
    errorCode: v.union(
      v.literal("provider_rate_limited"),
      v.literal("provider_unavailable"),
      v.literal("provider_rejected"),
    ),
  },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.db
      .query("membershipCleanupJobs")
      .withIndex("by_membership", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("userId", args.userId),
      )
      .unique();
    if (
      job === null ||
      job.status !== "running" ||
      job.membershipRevision !== args.membershipRevision ||
      job.leaseToken !== args.leaseToken
    ) {
      return;
    }
    const delay = Math.min(60 * 60_000, 2 ** Math.min(job.attempts, 10) * 1_000);
    const now = Date.now();
    await ctx.db.patch(job._id, {
      status: "pending",
      zeroVerificationPasses: 0,
      cursorOffset: 0,
      scanExpectedTotal: undefined,
      scanProviderIds: undefined,
      previousZeroFingerprint: undefined,
      leaseToken: undefined,
      leaseUntil: undefined,
      nextRunAt: now + delay,
      lastErrorCode: args.errorCode,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(delay, internal.keyBroker.revokeMembershipKeys, {
      clerkOrgId: args.clerkOrgId,
      userId: args.userId,
    });
  },
});

/** Cron recovery for lost schedules, crashed leases, and old revoked rows. */
export const scheduleMembershipCleanupDue = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const now = Date.now();
    const [pending, expired, revoked] = await Promise.all([
      ctx.db
        .query("membershipCleanupJobs")
        .withIndex("by_due", (q) =>
          q.eq("status", "pending").lte("nextRunAt", now),
        )
        .take(50),
      ctx.db
        .query("membershipCleanupJobs")
        .withIndex("by_lease", (q) =>
          q.eq("status", "running").lte("leaseUntil", now),
        )
        .take(50),
      ctx.db
        .query("clerkMembershipStates")
        .withIndex("by_status", (q) => q.eq("status", "revoked"))
        .take(50),
    ]);
    for (const membership of revoked) {
      await ensureMembershipCleanupJob(
        ctx,
        membership.clerkOrgId,
        membership.userId,
        membership.revision,
      );
    }
    const scopes = new Map<string, { clerkOrgId: string; userId: string }>();
    for (const job of [...pending, ...expired]) {
      scopes.set(`${job.clerkOrgId}\u0000${job.userId}`, job);
    }
    for (const scope of scopes.values()) {
      await ctx.scheduler.runAfter(0, internal.keyBroker.revokeMembershipKeys, scope);
    }
    return { scheduled: scopes.size + revoked.length };
  },
});
