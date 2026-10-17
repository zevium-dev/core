"use node";
import { createClerkClient } from "@clerk/backend";
import { v } from "convex/values";
import { isOrgRole, sealOneTimeExecutionKey } from "@zevium/shared";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { MCP_AUTO_KEY_NAME } from "./lib/keys";

const MAX_CLEANUP_ATTEMPTS = 5;

function clerk() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  return secretKey ? createClerkClient({ secretKey }) : null;
}

/** Revoke a created key that never became the member's key. Its secret was
 * never revealed, so the orphan is unusable; this only keeps Clerk tidy. */
async function cleanup(ctx: ActionCtx, keyId: string, attempt: number) {
  if (await ctx.runQuery(internal.mcpKeys.registered, { keyId })) return;
  try {
    await clerk()?.apiKeys.revoke({
      apiKeyId: keyId,
      revocationReason: "Zevium MCP key auto-creation failed",
    });
  } catch {
    if (attempt < MAX_CLEANUP_ATTEMPTS)
      await ctx.scheduler.runAfter(
        60_000 * 2 ** attempt,
        internal.mcpKeysNode.revokeOrphan,
        { keyId, attempt: attempt + 1 },
      );
  }
}

export const revokeOrphan = internalAction({
  args: { keyId: v.string(), attempt: v.number() },
  handler: (ctx, args) => cleanup(ctx, args.keyId, args.attempt),
});

/**
 * Create the member's key exactly as the keys page would (same Clerk claims,
 * budget and scopes, no cap), except the secret: OAuth pays through the key id
 * server-side, so the secret is hashed for the projection and then dropped.
 * It is never stored, logged or shown; rotating the key issues a usable one.
 */
export const provision = internalAction({
  args: { userId: v.string(), orgId: v.string(), attempt: v.number() },
  handler: async (ctx, args) => {
    const client = clerk();
    let keyId: string | undefined;
    try {
      if (!client) throw new Error("Clerk unavailable");
      // Taken before the membership read: insertKey rejects the key if a
      // removal webhook is stamped at or after it, including one that races
      // the Clerk calls below.
      const verifiedAt = Date.now();
      // Clerk is the live membership authority; Convex receipts can lag.
      const { data } = await client.organizations.getOrganizationMembershipList(
        {
          organizationId: args.orgId,
          userId: [args.userId],
          limit: 1,
        },
      );
      const membership = data.find(
        (m) => m.publicUserData?.userId === args.userId,
      );
      if (!isOrgRole(membership?.role)) throw new Error("Not a member");
      const created = await client.apiKeys.create({
        name: MCP_AUTO_KEY_NAME,
        subject: args.userId,
        createdBy: args.userId,
        claims: { org_id: args.orgId },
      });
      keyId = created.id;
      if (typeof created.secret !== "string" || !created.secret)
        throw new Error("Secret missing");
      const { provision } = await sealOneTimeExecutionKey({
        keyId: created.id,
        secret: created.secret,
        clerkOrgId: args.orgId,
        ownerUserId: args.userId,
        subjectUserId: args.userId,
        budgetId: `budget_${crypto.randomUUID().replaceAll("-", "")}`,
        budgetRevision: 1,
        scopes: ["gateway:execute"],
      });
      if (
        await ctx.runMutation(internal.mcpKeys.complete, {
          ...args,
          projection: { schemaVersion: 1, verifiedAt, provision },
        })
      )
        return;
    } catch {
      /* Fall back to the keyless explanation; the claim backs off. */
    }
    await ctx.runMutation(internal.mcpKeys.fail, args);
    if (keyId) await cleanup(ctx, keyId, 1);
  },
});
