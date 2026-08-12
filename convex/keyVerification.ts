"use node";

import { createClerkClient } from "@clerk/backend";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";

function claimString(claims: unknown, name: string): string | undefined {
  if (claims === null || typeof claims !== "object") return undefined;
  const value = (claims as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

/** Clerk is queried at write time; browser-supplied ids never become owners. */
export const syncVerifiedKey = action({
  args: { keyId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) throw new Error("Not authenticated");
    const clerkOrgId = claimString(identity, "org_id");
    if (clerkOrgId === undefined || args.keyId.trim() === "") {
      throw new Error("Active organization required");
    }
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (secretKey === undefined || secretKey.trim() === "") {
      throw new Error("Provider key verification is not configured");
    }
    const key = await createClerkClient({ secretKey }).apiKeys.get(args.keyId);
    if (
      key.revoked ||
      key.expired ||
      key.subject !== identity.subject ||
      claimString(key.claims, "org_id") !== clerkOrgId
    ) {
      throw new Error("Provider key ownership could not be verified");
    }
    await ctx.runMutation(internal.keySettings.recordProviderVerifiedKey, {
      keyId: key.id,
      ownerUserId: key.subject,
      clerkOrgId,
    });
  },
});
