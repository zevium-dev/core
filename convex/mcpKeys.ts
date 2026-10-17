import { v, ConvexError } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { getOrganization, isActive } from "./lib/identity";
import {
  currentKey,
  insertKey,
  membershipRemoved,
  MCP_AUTO_KEY_NAME,
} from "./lib/keys";
import { verifiedKeyProjectionValidator } from "./lib/keyProjection";

/** A provisioning action that has not reported back by then is presumed lost. */
const LEASE_MS = 60_000;
const backoff = (attempts: number) =>
  Math.min(60_000 * 2 ** (attempts - 1), 3_600_000);
const args = { userId: v.string(), orgId: v.string() };

async function eligible(
  ctx: Pick<QueryCtx, "db">,
  clerkOrgId: string,
  userId: string,
) {
  const org = await getOrganization(ctx, clerkOrgId);
  if (!org || !(await isActive(ctx, org))) return null;
  // An infinite verifiedAt matches only account deletion, never a removal receipt.
  if (
    await membershipRemoved(
      ctx,
      org.clerkOrgId,
      userId,
      Number.POSITIVE_INFINITY,
    )
  )
    return null;
  const row = await ctx.db
    .query("mcpKeyProvisions")
    .withIndex("by_org_user", (q) =>
      q.eq("organizationId", org._id).eq("userId", userId),
    )
    .unique();
  return { org, row };
}

/**
 * Keyless OAuth identity resolution asks here whether to auto-create the
 * member's key. Only the first connect does: a member who later revokes or
 * disables that key keeps the keyless explanation instead of a silent
 * replacement. The row serializes concurrent connects into one creation.
 * Returns true while a creation is in flight.
 */
export const request = internalMutation({
  args,
  handler: async (ctx, args): Promise<boolean> => {
    const found = await eligible(ctx, args.orgId, args.userId);
    if (!found) return false;
    const { org, row } = found;
    const owned = await ctx.db
      .query("apiKeys")
      .withIndex("by_org_owner", (q) =>
        q
          .eq("kind", "key")
          .eq("organizationId", org._id)
          .eq("ownerUserId", args.userId),
      )
      .collect();
    // A disabled current key still holds the member's one slot.
    if (owned.some((r) => r.kind === "key" && currentKey(r))) return false;
    const now = Date.now();
    if (row?.state === "created") return false;
    if (row?.state === "pending" && row.leaseUntil > now) return true;
    if (row && row.nextAttemptAt > now) return false;
    const attempts = (row?.attempts ?? 0) + 1;
    const claim = {
      state: "pending" as const,
      attempts,
      leaseUntil: now + LEASE_MS,
      nextAttemptAt: now + backoff(attempts),
      updatedAt: now,
    };
    if (row) await ctx.db.patch(row._id, claim);
    else
      await ctx.db.insert("mcpKeyProvisions", {
        organizationId: org._id,
        userId: args.userId,
        ...claim,
      });
    await ctx.scheduler.runAfter(0, internal.mcpKeysNode.provision, {
      ...args,
      attempt: attempts,
    });
    return true;
  },
});

/** Registers the created key as the member's key if this attempt still owns the claim. */
export const complete = internalMutation({
  args: {
    ...args,
    attempt: v.number(),
    projection: verifiedKeyProjectionValidator,
  },
  handler: async (ctx, args): Promise<boolean> => {
    const found = await eligible(ctx, args.orgId, args.userId);
    const row = found?.row;
    if (
      !found ||
      !row ||
      row.state !== "pending" ||
      row.attempts !== args.attempt
    )
      return false;
    const p = args.projection.provision;
    const fail = async () => {
      await ctx.db.patch(row._id, { state: "failed", updatedAt: Date.now() });
      return false;
    };
    if (
      p.clerkOrgId !== found.org.clerkOrgId ||
      p.ownerUserId !== args.userId ||
      p.subjectUserId !== args.userId
    )
      return fail();
    try {
      // Same one-current-key, hash-uniqueness and membership checks as web-created keys.
      await insertKey(
        ctx,
        found.org,
        p,
        args.projection.verifiedAt,
        MCP_AUTO_KEY_NAME,
      );
    } catch (error) {
      // insertKey's domain checks throw before any write.
      if (!(error instanceof ConvexError)) throw error;
      return fail();
    }
    await ctx.db.patch(row._id, {
      state: "created",
      keyId: p.clerkKeyId,
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const fail = internalMutation({
  args: { ...args, attempt: v.number() },
  handler: async (ctx, args) => {
    const row = (await eligible(ctx, args.orgId, args.userId))?.row;
    if (row?.state === "pending" && row.attempts === args.attempt)
      await ctx.db.patch(row._id, { state: "failed", updatedAt: Date.now() });
  },
});

/** Guards provider cleanup: a registered key is revoked only through the key lifecycle. */
export const registered = internalQuery({
  args: { keyId: v.string() },
  handler: async (ctx, args) =>
    (await ctx.db
      .query("apiKeys")
      .withIndex("by_key", (q) => q.eq("keyId", args.keyId))
      .first()) !== null,
});
