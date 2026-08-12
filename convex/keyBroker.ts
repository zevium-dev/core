"use node";

import { createClerkClient, type APIKey } from "@clerk/backend";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { requireIdentity } from "./lib/auth";

const CLERK_KEY_PAGE_SIZE = 500;
const MAX_KEYS_PER_USER = 2_000;
const MAX_ACTIVE_KEYS_PER_ORG = 2;
const MAX_RECONCILE_ATTEMPTS = 5;

const SAGA_OPERATION_CLAIM = "zevium_operation_id";
const SAGA_LEASE_CLAIM = "zevium_lease_token";
const SAGA_KIND_CLAIM = "zevium_operation_kind";

type FreshScope = {
  clerkOrgId: string;
  userId: string;
  client: ReturnType<typeof createClerkClient>;
};

type OperationResult = {
  status: "reserved" | "completed" | "failed";
  operationId: string;
  acquired?: boolean;
  keyId?: string;
  oldKeyId?: string;
  newKeyId?: string;
  graceUntil?: number;
} | null;

export type BrokerKeyRow = {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
  expired: boolean;
};

export type BrokerCreatedKey = {
  id: string;
  name: string;
  secret: string;
  createdAt: number;
};

export type BrokerRotatedKey = BrokerCreatedKey & { graceUntil: number };

type BrokerKeySettingView = {
  _id: Id<"keySettings">;
  keyId: string;
  managed: boolean;
  familyId: string;
  monthlyCapCredits?: number;
  disabled: boolean;
  rotatedFromKeyId?: string;
  graceUntil?: number;
  updatedAt: number;
};

function client() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("API key management is temporarily unavailable");
  }
  return createClerkClient({ secretKey });
}

/** Backend membership lookup closes session-token membership lag. */
async function freshScope(ctx: ActionCtx): Promise<FreshScope> {
  const claims = await requireIdentity(ctx);
  if (!claims.orgId) {
    throw new Error("Select an organization before managing API keys");
  }
  const clerk = client();
  if (!(await hasFreshMembership(clerk, claims.orgId, claims.subject))) {
    throw new Error("API key management authorization could not be verified");
  }
  return { clerkOrgId: claims.orgId, userId: claims.subject, client: clerk };
}

async function hasFreshMembership(
  clerk: ReturnType<typeof createClerkClient>,
  clerkOrgId: string,
  userId: string,
): Promise<boolean> {
  try {
    const memberships = await clerk.organizations.getOrganizationMembershipList(
      {
        organizationId: clerkOrgId,
        userId: [userId],
        limit: 1,
      },
    );
    return memberships.data.some(
      (membership) => membership.publicUserData?.userId === userId,
    );
  } catch {
    return false;
  }
}

async function requireFreshMembership(scope: FreshScope): Promise<number> {
  if (
    !(await hasFreshMembership(scope.client, scope.clerkOrgId, scope.userId))
  ) {
    throw new Error("API key management authorization could not be verified");
  }
  return Date.now();
}

function belongsToScope(key: APIKey, scope: FreshScope): boolean {
  return (
    key.subject === scope.userId &&
    key.claims !== null &&
    typeof key.claims.org_id === "string" &&
    key.claims.org_id === scope.clerkOrgId
  );
}

function toRow(key: APIKey): BrokerKeyRow {
  return {
    id: key.id,
    name: key.name,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    revoked: key.revoked,
    expired: key.expired,
  };
}

/** Bounded pagination: no per-key GETs and no silent newest-page truncation. */
async function listScopedKeys(
  scope: FreshScope,
  options: { reserveProviderSlot?: boolean } = {},
): Promise<APIKey[]> {
  const keys = new Map<string, APIKey>();
  const seenProviderIds = new Set<string>();
  let offset = 0;
  let expectedTotal: number | undefined;
  for (;;) {
    let page: Awaited<ReturnType<FreshScope["client"]["apiKeys"]["list"]>>;
    try {
      page = await scope.client.apiKeys.list({
        subject: scope.userId,
        includeInvalid: false,
        limit: CLERK_KEY_PAGE_SIZE,
        offset,
      });
    } catch {
      throw new Error("API key list is temporarily unavailable. Try again.");
    }
    expectedTotal ??= page.totalCount;
    if (page.totalCount !== expectedTotal) {
      throw new Error(
        "API key list changed while it was being read. Try again.",
      );
    }
    if (
      page.totalCount > MAX_KEYS_PER_USER ||
      (options.reserveProviderSlot === true &&
        page.totalCount >= MAX_KEYS_PER_USER)
    ) {
      throw new Error(
        "API key count exceeds the supported limit. Revoke old keys before continuing.",
      );
    }
    for (const key of page.data) {
      if (seenProviderIds.has(key.id)) {
        throw new Error(
          "API key list changed while it was being read. Try again.",
        );
      }
      seenProviderIds.add(key.id);
      if (belongsToScope(key, scope)) keys.set(key.id, key);
    }
    offset += page.data.length;
    if (page.data.length === 0 && offset < page.totalCount) {
      throw new Error("API key list could not be read completely. Try again.");
    }
    if (offset >= page.totalCount) {
      if (seenProviderIds.size !== page.totalCount) {
        throw new Error(
          "API key list could not be read completely. Try again.",
        );
      }
      break;
    }
    if (offset >= MAX_KEYS_PER_USER) {
      throw new Error(
        "API key count exceeds the supported limit. Revoke old keys before continuing.",
      );
    }
  }
  return [...keys.values()];
}

async function observeKeys(
  ctx: ActionCtx,
  scope: FreshScope,
  keys: readonly APIKey[],
): Promise<void> {
  for (let start = 0; start < keys.length; start += CLERK_KEY_PAGE_SIZE) {
    await ctx.runMutation(internal.keySettings.observeVerified, {
      clerkOrgId: scope.clerkOrgId,
      userId: scope.userId,
      keyIds: keys
        .slice(start, start + CLERK_KEY_PAGE_SIZE)
        .map((key) => key.id),
    });
  }
}

async function ownedKey(scope: FreshScope, keyId: string): Promise<APIKey> {
  try {
    const key = await scope.client.apiKeys.get(keyId);
    if (!belongsToScope(key, scope)) throw new Error("wrong owner");
    return key;
  } catch {
    throw new Error("Key unavailable");
  }
}

function sagaClaims(
  scope: Pick<FreshScope, "clerkOrgId">,
  operationId: string,
  leaseToken: string,
  kind: "create" | "rotation",
): Record<string, string> {
  return {
    org_id: scope.clerkOrgId,
    [SAGA_OPERATION_CLAIM]: operationId,
    [SAGA_LEASE_CLAIM]: leaseToken,
    [SAGA_KIND_CLAIM]: kind,
  };
}

function matchesSaga(
  key: APIKey,
  operationId: string,
  leaseToken: string,
  kind: "create" | "rotation",
): boolean {
  return (
    key.claims !== null &&
    key.claims[SAGA_OPERATION_CLAIM] === operationId &&
    key.claims[SAGA_LEASE_CLAIM] === leaseToken &&
    key.claims[SAGA_KIND_CLAIM] === kind
  );
}

async function revokeProviderKey(
  clerk: ReturnType<typeof createClerkClient>,
  key: APIKey,
  reason: string,
): Promise<void> {
  if (key.revoked || key.expired) return;
  await clerk.apiKeys.revoke({ apiKeyId: key.id, revocationReason: reason });
}

function providerStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const value = error as { status?: unknown; statusCode?: unknown };
  if (typeof value.status === "number") return value.status;
  return typeof value.statusCode === "number" ? value.statusCode : undefined;
}

async function failCreateAfterCompensation(
  ctx: ActionCtx,
  scope: FreshScope,
  operationId: string,
  leaseToken: string,
  key: APIKey,
  reason: string,
): Promise<void> {
  await ctx.runMutation(internal.keySettings.compensateCreatedKeyVerified, {
    clerkOrgId: scope.clerkOrgId,
    userId: scope.userId,
    operationId,
    keyId: key.id,
    leaseToken,
    message: reason,
  });
  try {
    await revokeProviderKey(scope.client, key, reason);
  } catch {
    throw new Error("API key cleanup is still in progress. Try again shortly.");
  }
  await ctx.runMutation(internal.keySettings.markSagaReconciled, {
    clerkOrgId: scope.clerkOrgId,
    userId: scope.userId,
    operationId,
    leaseToken,
    kind: "create",
  });
}

async function failRotationAfterCompensation(
  ctx: ActionCtx,
  scope: FreshScope,
  operationId: string,
  leaseToken: string,
  oldKeyId: string,
  key: APIKey,
  reason: string,
): Promise<void> {
  await ctx.runMutation(internal.keySettings.compensateRotationVerified, {
    clerkOrgId: scope.clerkOrgId,
    userId: scope.userId,
    operationId,
    oldKeyId,
    newKeyId: key.id,
    leaseToken,
    message: reason,
  });
  try {
    await revokeProviderKey(scope.client, key, reason);
  } catch {
    throw new Error("API key cleanup is still in progress. Try again shortly.");
  }
  await ctx.runMutation(internal.keySettings.markSagaReconciled, {
    clerkOrgId: scope.clerkOrgId,
    userId: scope.userId,
    operationId,
    leaseToken,
    kind: "rotation",
  });
}

async function projectFreshMembershipLoss(
  ctx: ActionCtx,
  scope: FreshScope,
  operationId: string,
): Promise<void> {
  await ctx.runMutation(internal.keySettings.revokeMembershipVerified, {
    clerkOrgId: scope.clerkOrgId,
    userId: scope.userId,
    svixId: `fresh-membership:${scope.clerkOrgId}:${scope.userId}:${operationId}`,
  });
  await ctx.scheduler.runAfter(0, internal.keyBroker.revokeMembershipKeys, {
    clerkOrgId: scope.clerkOrgId,
    userId: scope.userId,
  });
}

export const listOwnedKeys = action({
  args: {},
  handler: async (ctx): Promise<BrokerKeyRow[]> => {
    const scope = await freshScope(ctx);
    const keys = await listScopedKeys(scope);
    await observeKeys(ctx, scope, keys);
    return keys.map(toRow);
  },
});

/** Fenced create saga. Only lease owner can reach non-idempotent Clerk create. */
export const createManagedKey = action({
  args: { operationId: v.string(), name: v.string() },
  handler: async (ctx, args): Promise<BrokerCreatedKey> => {
    const scope = await freshScope(ctx);
    const existing = await listScopedKeys(scope, { reserveProviderSlot: true });
    await observeKeys(ctx, scope, existing);
    if (existing.length > 0) {
      throw new Error(
        "Only one API key per organization. Revoke the existing key first.",
      );
    }
    const membershipVerifiedAt = await requireFreshMembership(scope);

    const leaseToken = crypto.randomUUID();
    const operation = (await ctx.runMutation(
      internal.keySettings.beginCreateVerified,
      {
        clerkOrgId: scope.clerkOrgId,
        userId: scope.userId,
        operationId: args.operationId,
        requestedName: args.name,
        membershipVerifiedAt,
        leaseToken,
      },
    )) as OperationResult;
    if (operation?.status === "completed") {
      throw new Error(
        "This key was already created. Its one-time secret cannot be shown again.",
      );
    }
    if (operation?.status === "failed") {
      throw new Error("This creation attempt expired. Start a new one.");
    }
    if (operation?.status !== "reserved" || operation.acquired !== true) {
      throw new Error("Key creation is already in progress");
    }

    let created: APIKey;
    try {
      created = await scope.client.apiKeys.create({
        name: args.name,
        subject: scope.userId,
        createdBy: scope.userId,
        claims: sagaClaims(scope, args.operationId, leaseToken, "create"),
      });
    } catch {
      await ctx.runMutation(internal.keySettings.failCreateVerified, {
        clerkOrgId: scope.clerkOrgId,
        userId: scope.userId,
        operationId: args.operationId,
        leaseToken,
        message: "Clerk key creation failed",
      });
      throw new Error("API key could not be created. Try again.");
    }

    if (typeof created.secret !== "string" || created.secret.length === 0) {
      await failCreateAfterCompensation(
        ctx,
        scope,
        args.operationId,
        leaseToken,
        created,
        "Creation secret was not returned",
      );
      throw new Error("Key created but secret missing. Contact support.");
    }
    if (
      !(await hasFreshMembership(scope.client, scope.clerkOrgId, scope.userId))
    ) {
      await projectFreshMembershipLoss(ctx, scope, args.operationId);
      await failCreateAfterCompensation(
        ctx,
        scope,
        args.operationId,
        leaseToken,
        created,
        "Organization membership changed during creation",
      );
      throw new Error("API key management authorization changed");
    }
    try {
      await ctx.runMutation(internal.keySettings.completeCreateVerified, {
        clerkOrgId: scope.clerkOrgId,
        userId: scope.userId,
        operationId: args.operationId,
        keyId: created.id,
        leaseToken,
      });
    } catch {
      await failCreateAfterCompensation(
        ctx,
        scope,
        args.operationId,
        leaseToken,
        created,
        "Local ownership registration failed",
      );
      throw new Error(
        "API key could not be finalized. Created key was revoked.",
      );
    }
    return {
      id: created.id,
      name: created.name,
      secret: created.secret,
      createdAt: created.createdAt,
    };
  },
});

export const setCap = action({
  args: {
    keyId: v.string(),
    monthlyCapCredits: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args): Promise<BrokerKeySettingView> => {
    const scope = await freshScope(ctx);
    await ownedKey(scope, args.keyId);
    return (await ctx.runMutation(internal.keySettings.setCapVerified, {
      clerkOrgId: scope.clerkOrgId,
      userId: scope.userId,
      ...args,
    })) as BrokerKeySettingView;
  },
});

export const setDisabled = action({
  args: { keyId: v.string(), disabled: v.boolean() },
  handler: async (ctx, args): Promise<BrokerKeySettingView> => {
    const scope = await freshScope(ctx);
    await ownedKey(scope, args.keyId);
    return (await ctx.runMutation(internal.keySettings.setDisabledVerified, {
      clerkOrgId: scope.clerkOrgId,
      userId: scope.userId,
      ...args,
    })) as BrokerKeySettingView;
  },
});

export const revokeManagedKey = action({
  args: { operationId: v.string(), keyId: v.string() },
  handler: async (ctx, args): Promise<{ id: string }> => {
    const scope = await freshScope(ctx);
    const key = await ownedKey(scope, args.keyId);
    await observeKeys(ctx, scope, [key]);
    const operation = (await ctx.runMutation(
      internal.keySettings.beginRevokeVerified,
      {
        clerkOrgId: scope.clerkOrgId,
        userId: scope.userId,
        operationId: args.operationId,
        keyId: args.keyId,
      },
    )) as OperationResult;
    if (operation?.status === "completed") return { id: args.keyId };
    if (operation?.status !== "reserved") {
      throw new Error("This revocation attempt expired. Start a new one.");
    }
    try {
      await revokeProviderKey(
        scope.client,
        key,
        "Revoked by owner from settings",
      );
    } catch {
      await ctx.runMutation(internal.keySettings.failRevokeVerified, {
        clerkOrgId: scope.clerkOrgId,
        userId: scope.userId,
        operationId: args.operationId,
        message: "Clerk revocation failed",
      });
      throw new Error("API key revocation is still in progress.");
    }
    try {
      await ctx.runMutation(internal.keySettings.completeRevokeVerified, {
        clerkOrgId: scope.clerkOrgId,
        userId: scope.userId,
        operationId: args.operationId,
      });
    } catch {
      throw new Error("API key was revoked; confirmation is still pending.");
    }
    return { id: args.keyId };
  },
});

/** Rotation derives grace server-side and inherits family budget/cap atomically. */
export const rotateManagedKey = action({
  args: { operationId: v.string(), oldKeyId: v.string(), name: v.string() },
  handler: async (ctx, args): Promise<BrokerRotatedKey> => {
    const scope = await freshScope(ctx);
    const keys = await listScopedKeys(scope, { reserveProviderSlot: true });
    await observeKeys(ctx, scope, keys);
    if (keys.length > MAX_ACTIVE_KEYS_PER_ORG) {
      throw new Error("Too many active API keys. Revoke old keys first.");
    }
    const old = keys.find((key) => key.id === args.oldKeyId);
    if (!old || old.revoked || old.expired) throw new Error("Key unavailable");
    if (keys.some((key) => key.id !== args.oldKeyId)) {
      throw new Error("Revoke the previous grace key before rotating again");
    }

    const requestedName =
      args.name.trim().length > 0 ? args.name.trim() : `${old.name} (rotated)`;
    const membershipVerifiedAt = await requireFreshMembership(scope);
    const leaseToken = crypto.randomUUID();
    const operation = (await ctx.runMutation(
      internal.keySettings.beginRotationVerified,
      {
        clerkOrgId: scope.clerkOrgId,
        userId: scope.userId,
        operationId: args.operationId,
        oldKeyId: old.id,
        requestedName,
        membershipVerifiedAt,
        leaseToken,
      },
    )) as OperationResult;
    if (operation?.status === "completed") {
      throw new Error(
        "This rotation already completed. Its one-time secret cannot be shown again.",
      );
    }
    if (operation?.status === "failed") {
      throw new Error("This rotation previously failed. Start a new rotation.");
    }
    if (operation?.status !== "reserved" || operation.acquired !== true) {
      throw new Error("A rotation is already in progress for this key");
    }

    let created: APIKey;
    try {
      created = await scope.client.apiKeys.create({
        name: requestedName,
        subject: scope.userId,
        createdBy: scope.userId,
        claims: sagaClaims(scope, args.operationId, leaseToken, "rotation"),
      });
    } catch {
      await ctx.runMutation(internal.keySettings.failRotationVerified, {
        clerkOrgId: scope.clerkOrgId,
        userId: scope.userId,
        operationId: args.operationId,
        leaseToken,
        message: "Clerk replacement creation failed",
      });
      throw new Error("Replacement key could not be created. Try again.");
    }
    if (typeof created.secret !== "string" || created.secret.length === 0) {
      await failRotationAfterCompensation(
        ctx,
        scope,
        args.operationId,
        leaseToken,
        old.id,
        created,
        "Rotation secret was not returned",
      );
      throw new Error("Key created but secret missing. Contact support.");
    }
    if (
      !(await hasFreshMembership(scope.client, scope.clerkOrgId, scope.userId))
    ) {
      await projectFreshMembershipLoss(ctx, scope, args.operationId);
      await failRotationAfterCompensation(
        ctx,
        scope,
        args.operationId,
        leaseToken,
        old.id,
        created,
        "Organization membership changed during rotation",
      );
      throw new Error("API key management authorization changed");
    }
    try {
      const completed = (await ctx.runMutation(
        internal.keySettings.completeRotationVerified,
        {
          clerkOrgId: scope.clerkOrgId,
          userId: scope.userId,
          operationId: args.operationId,
          oldKeyId: old.id,
          newKeyId: created.id,
          leaseToken,
        },
      )) as OperationResult;
      if (!completed?.graceUntil) {
        throw new Error("Rotation grace could not be established");
      }
      return {
        id: created.id,
        name: created.name,
        secret: created.secret,
        createdAt: created.createdAt,
        graceUntil: completed.graceUntil,
      };
    } catch {
      await failRotationAfterCompensation(
        ctx,
        scope,
        args.operationId,
        leaseToken,
        old.id,
        created,
        "Rotation lineage recording failed",
      );
      throw new Error(
        "Replacement key could not be finalized. Created key was revoked.",
      );
    }
  },
});

async function reconcileExpiredSaga(
  ctx: ActionCtx,
  args: {
    clerkOrgId: string;
    userId: string;
    operationId: string;
    leaseToken: string;
    kind: "create" | "rotation";
    attempt: number;
  },
): Promise<void> {
  const expired =
    args.kind === "create"
      ? await ctx.runMutation(internal.keySettings.expireCreateVerified, {
          clerkOrgId: args.clerkOrgId,
          userId: args.userId,
          operationId: args.operationId,
          leaseToken: args.leaseToken,
        })
      : await ctx.runMutation(internal.keySettings.expireRotationVerified, {
          clerkOrgId: args.clerkOrgId,
          userId: args.userId,
          operationId: args.operationId,
          leaseToken: args.leaseToken,
        });
  if (expired === null) return;
  try {
    const clerk = client();
    const scope: FreshScope = {
      clerkOrgId: args.clerkOrgId,
      userId: args.userId,
      client: clerk,
    };
    const keys = await listScopedKeys(scope);
    for (const key of keys) {
      if (matchesSaga(key, args.operationId, args.leaseToken, args.kind)) {
        await revokeProviderKey(
          clerk,
          key,
          "Expired Zevium key lifecycle operation",
        );
      }
    }
    await ctx.runMutation(internal.keySettings.markSagaReconciled, {
      clerkOrgId: args.clerkOrgId,
      userId: args.userId,
      operationId: args.operationId,
      leaseToken: args.leaseToken,
      kind: args.kind,
    });
  } catch (error) {
    if (args.attempt + 1 >= MAX_RECONCILE_ATTEMPTS) throw error;
    const target =
      args.kind === "create"
        ? internal.keyBroker.reconcileCreateOperation
        : internal.keyBroker.reconcileRotationOperation;
    await ctx.scheduler.runAfter(2 ** args.attempt * 60_000, target, {
      clerkOrgId: args.clerkOrgId,
      userId: args.userId,
      operationId: args.operationId,
      leaseToken: args.leaseToken,
      attempt: args.attempt + 1,
    });
  }
}

export const reconcileCreateOperation = internalAction({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    leaseToken: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> =>
    await reconcileExpiredSaga(ctx, {
      ...args,
      kind: "create",
      attempt: args.attempt ?? 0,
    }),
});

export const reconcileRotationOperation = internalAction({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    leaseToken: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> =>
    await reconcileExpiredSaga(ctx, {
      ...args,
      kind: "rotation",
      attempt: args.attempt ?? 0,
    }),
});

/** Ambiguous revoke responses never restore authority; retry physical cleanup. */
export const reconcileRevokedKey = internalAction({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    keyId: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const claimed = await ctx.runMutation(
      internal.keySettings.claimRevokeReconciliation,
      {
        clerkOrgId: args.clerkOrgId,
        userId: args.userId,
        operationId: args.operationId,
        keyId: args.keyId,
      },
    );
    if (claimed === null) return;
    const attempt = args.attempt ?? 0;
    try {
      const clerk = client();
      let key: APIKey;
      try {
        key = await clerk.apiKeys.get(args.keyId);
      } catch (error) {
        if (providerStatus(error) === 404) {
          await ctx.runMutation(internal.keySettings.completeRevokeVerified, {
            clerkOrgId: args.clerkOrgId,
            userId: args.userId,
            operationId: args.operationId,
          });
          return;
        }
        throw error;
      }
      const scope: FreshScope = {
        clerkOrgId: args.clerkOrgId,
        userId: args.userId,
        client: clerk,
      };
      if (!belongsToScope(key, scope)) throw new Error("Key unavailable");
      await revokeProviderKey(clerk, key, "Zevium revoke reconciliation");
      await ctx.runMutation(internal.keySettings.completeRevokeVerified, {
        clerkOrgId: args.clerkOrgId,
        userId: args.userId,
        operationId: args.operationId,
      });
    } catch (error) {
      if (attempt + 1 >= MAX_RECONCILE_ATTEMPTS) throw error;
      await ctx.scheduler.runAfter(
        2 ** attempt * 60_000,
        internal.keyBroker.reconcileRevokedKey,
        { ...args, attempt: attempt + 1 },
      );
    }
  },
});

export const revokeExpiredRotation = internalAction({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const claimed = await ctx.runMutation(
      internal.keySettings.claimExpiredRotationRevoke,
      args,
    );
    if (!claimed) return;
    try {
      const clerk = client();
      let old: APIKey;
      try {
        old = await clerk.apiKeys.get(claimed.oldKeyId);
      } catch (error) {
        if (providerStatus(error) === 404) {
          await ctx.runMutation(
            internal.keySettings.completeExpiredRotationRevoke,
            { ...args, oldKeyId: claimed.oldKeyId },
          );
          return;
        }
        throw error;
      }
      await revokeProviderKey(
        clerk,
        old,
        "Zevium rotation grace period expired",
      );
      await ctx.runMutation(
        internal.keySettings.completeExpiredRotationRevoke,
        { ...args, oldKeyId: claimed.oldKeyId },
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Clerk revoke failed";
      await ctx.runMutation(internal.keySettings.retryExpiredRotationRevoke, {
        ...args,
        message,
      });
    }
  },
});

/** Physical cleanup follows fail-closed membership projection; retries bounded. */
export const revokeMembershipKeys = internalAction({
  args: {
    clerkOrgId: v.string(),
    userId: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    try {
      const scope: FreshScope = {
        clerkOrgId: args.clerkOrgId,
        userId: args.userId,
        client: client(),
      };
      const keys = await listScopedKeys(scope);
      for (const key of keys) {
        await revokeProviderKey(
          scope.client,
          key,
          "Clerk organization membership deleted",
        );
      }
    } catch (error) {
      const attempt = args.attempt ?? 0;
      if (attempt + 1 >= MAX_RECONCILE_ATTEMPTS) throw error;
      await ctx.scheduler.runAfter(
        2 ** attempt * 60_000,
        internal.keyBroker.revokeMembershipKeys,
        { ...args, attempt: attempt + 1 },
      );
    }
  },
});
