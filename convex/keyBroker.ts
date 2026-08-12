"use node";

import { createClerkClient, type APIKey } from "@clerk/backend";
import { v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireIdentity } from "./lib/auth";

type FreshScope = {
  clerkOrgId: string;
  userId: string;
  client: ReturnType<typeof createClerkClient>;
};

type KeySettingResult = {
  keyId: string;
  monthlyCapCredits?: number;
  disabled: boolean;
  rotatedFromKeyId?: string;
  graceUntil?: number;
  updatedAt: number;
};

type OperationResult = {
  status: "reserved" | "completed" | "failed";
  operationId: string;
  keyId?: string;
  oldKeyId?: string;
  newKeyId?: string;
  graceUntil?: number;
} | null;

function client() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey)
    throw new Error("API key management is temporarily unavailable");
  return createClerkClient({ secretKey });
}

/** Backend API membership lookup closes the roughly one-minute JWT role lag. */
async function freshScope(ctx: ActionCtx): Promise<FreshScope> {
  const claims = await requireIdentity(ctx);
  if (!claims.orgId) {
    throw new Error("Select an organization before managing API keys");
  }
  const clerk = client();
  try {
    const memberships = await clerk.organizations.getOrganizationMembershipList(
      {
        organizationId: claims.orgId,
        userId: [claims.subject],
        limit: 1,
      },
    );
    const current = memberships.data.some(
      (membership) => membership.publicUserData?.userId === claims.subject,
    );
    if (!current) throw new Error("not a member");
  } catch {
    throw new Error("API key management authorization could not be verified");
  }
  return { clerkOrgId: claims.orgId, userId: claims.subject, client: clerk };
}

function belongsToScope(key: APIKey, scope: FreshScope): boolean {
  return (
    key.subject === scope.userId &&
    key.claims !== null &&
    typeof key.claims.org_id === "string" &&
    key.claims.org_id === scope.clerkOrgId
  );
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

async function register(
  ctx: ActionCtx,
  scope: FreshScope,
  keyId: string,
): Promise<KeySettingResult> {
  return await ctx.runMutation(internal.keySettings.registerVerified, {
    clerkOrgId: scope.clerkOrgId,
    userId: scope.userId,
    keyId,
  });
}

export const registerOwnedKey = action({
  args: { keyId: v.string() },
  handler: async (ctx, args): Promise<KeySettingResult> => {
    const scope = await freshScope(ctx);
    await ownedKey(scope, args.keyId);
    return await register(ctx, scope, args.keyId);
  },
});

export const setCap = action({
  args: {
    keyId: v.string(),
    monthlyCapCredits: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args): Promise<KeySettingResult> => {
    const scope = await freshScope(ctx);
    await ownedKey(scope, args.keyId);
    await register(ctx, scope, args.keyId);
    return await ctx.runMutation(internal.keySettings.setCapVerified, {
      clerkOrgId: scope.clerkOrgId,
      userId: scope.userId,
      ...args,
    });
  },
});

export const setDisabled = action({
  args: { keyId: v.string(), disabled: v.boolean() },
  handler: async (ctx, args): Promise<KeySettingResult> => {
    const scope = await freshScope(ctx);
    await ownedKey(scope, args.keyId);
    await register(ctx, scope, args.keyId);
    return await ctx.runMutation(internal.keySettings.setDisabledVerified, {
      clerkOrgId: scope.clerkOrgId,
      userId: scope.userId,
      ...args,
    });
  },
});

export const beginCreate = action({
  args: { operationId: v.string() },
  handler: async (ctx, args): Promise<OperationResult> => {
    const scope = await freshScope(ctx);
    return await ctx.runMutation(internal.keySettings.beginCreateVerified, {
      clerkOrgId: scope.clerkOrgId,
      userId: scope.userId,
      operationId: args.operationId,
    });
  },
});

export const completeCreate = action({
  args: { operationId: v.string(), keyId: v.string() },
  handler: async (ctx, args): Promise<OperationResult> => {
    const scope = await freshScope(ctx);
    await ownedKey(scope, args.keyId);
    return await ctx.runMutation(internal.keySettings.completeCreateVerified, {
      clerkOrgId: scope.clerkOrgId,
      userId: scope.userId,
      ...args,
    });
  },
});

export const failCreate = action({
  args: { operationId: v.string(), message: v.string() },
  handler: async (ctx, args): Promise<OperationResult> => {
    const scope = await freshScope(ctx);
    return await ctx.runMutation(internal.keySettings.failCreateVerified, {
      clerkOrgId: scope.clerkOrgId,
      userId: scope.userId,
      ...args,
    });
  },
});

export const beginRevoke = action({
  args: { operationId: v.string(), keyId: v.string() },
  handler: async (ctx, args): Promise<OperationResult> => {
    const scope = await freshScope(ctx);
    await ownedKey(scope, args.keyId);
    await register(ctx, scope, args.keyId);
    return await ctx.runMutation(internal.keySettings.beginRevokeVerified, {
      clerkOrgId: scope.clerkOrgId,
      userId: scope.userId,
      ...args,
    });
  },
});

export const completeRevoke = action({
  args: { operationId: v.string() },
  handler: async (ctx, args): Promise<OperationResult> => {
    const scope = await freshScope(ctx);
    return await ctx.runMutation(internal.keySettings.completeRevokeVerified, {
      clerkOrgId: scope.clerkOrgId,
      userId: scope.userId,
      operationId: args.operationId,
    });
  },
});

export const failRevoke = action({
  args: { operationId: v.string(), message: v.string() },
  handler: async (ctx, args): Promise<OperationResult> => {
    const scope = await freshScope(ctx);
    return await ctx.runMutation(internal.keySettings.failRevokeVerified, {
      clerkOrgId: scope.clerkOrgId,
      userId: scope.userId,
      ...args,
    });
  },
});

export const beginRotation = action({
  args: { operationId: v.string(), oldKeyId: v.string() },
  handler: async (ctx, args): Promise<OperationResult> => {
    const scope = await freshScope(ctx);
    const key = await ownedKey(scope, args.oldKeyId);
    if (key.revoked || key.expired) throw new Error("Key unavailable");
    await register(ctx, scope, args.oldKeyId);
    return await ctx.runMutation(internal.keySettings.beginRotationVerified, {
      clerkOrgId: scope.clerkOrgId,
      userId: scope.userId,
      ...args,
    });
  },
});

export const completeRotation = action({
  args: {
    operationId: v.string(),
    oldKeyId: v.string(),
    newKeyId: v.string(),
    graceUntil: v.number(),
  },
  handler: async (ctx, args): Promise<OperationResult> => {
    const scope = await freshScope(ctx);
    await ownedKey(scope, args.newKeyId);
    return await ctx.runMutation(
      internal.keySettings.completeRotationVerified,
      { clerkOrgId: scope.clerkOrgId, userId: scope.userId, ...args },
    );
  },
});

export const failRotation = action({
  args: { operationId: v.string(), message: v.string() },
  handler: async (ctx, args): Promise<OperationResult> => {
    const scope = await freshScope(ctx);
    return await ctx.runMutation(internal.keySettings.failRotationVerified, {
      clerkOrgId: scope.clerkOrgId,
      userId: scope.userId,
      ...args,
    });
  },
});
