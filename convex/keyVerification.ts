"use node";
import { createClerkClient } from "@clerk/backend";
import { v, ConvexError } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
export const syncVerifiedKey = action({
  args: { keyId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const owned = await ctx.runQuery(
      internal.keyRecovery.verificationTarget,
      args,
    );
    try {
      const key = await createClerkClient({
        secretKey: process.env.CLERK_SECRET_KEY,
      }).apiKeys.get(args.keyId);
      const claims = key.claims as Record<string, unknown> | null;
      if (
        key.revoked ||
        key.expired ||
        key.subject !== owned.ownerUserId ||
        claims?.org_id !== owned.clerkOrgId
      )
        throw new Error("identity mismatch");
    } catch {
      throw new ConvexError("Provider key ownership could not be verified");
    }
    // No unknown key creation: possession hash only comes from the signed issuance broker.
  },
});
export const revokeWithRetry = internalAction({
  args: { keyId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const attempt = await ctx.runMutation(internal.keyRecovery.claim, args);
    if (attempt === null) return;
    let success = false;
    try {
      const client = createClerkClient({
        secretKey: process.env.CLERK_SECRET_KEY,
      });
      const key = await client.apiKeys.get(args.keyId);
      if (!key.revoked)
        await client.apiKeys.revoke({
          apiKeyId: args.keyId,
          revocationReason: "Zevium key revoked",
        });
      success = true;
    } catch {
      /* Provider ambiguity leaves durable retry state; never restore local authority. */
    }
    await ctx.runMutation(internal.keyRecovery.finish, {
      ...args,
      attempt,
      success,
    });
  },
});
