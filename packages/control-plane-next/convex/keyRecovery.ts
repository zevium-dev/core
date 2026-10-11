import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { ownedKey, requireKeyManager } from "./lib/keys";
export const verificationTarget = internalQuery({
  args: { keyId: v.string() },
  handler: async (ctx, args) => {
    const { key, claims } = await ownedKey(ctx, args.keyId);
    requireKeyManager(claims.subject, claims.orgRole, key);
    return { ownerUserId: key.ownerUserId, clerkOrgId: key.clerkOrgId };
  },
});
async function cleanupTarget(ctx: Pick<QueryCtx, "db">, keyId: string) {
  const key = await ctx.db
    .query("apiKeys")
    .withIndex("by_key", (q) => q.eq("keyId", keyId))
    .unique();
  if (key?.kind === "key") return key.revokedAt !== undefined ? key : null;
  const rotation = await ctx.db
    .query("apiKeys")
    .withIndex("by_new_key", (q) => q.eq("newKeyId", keyId))
    .unique();
  return rotation?.kind === "rotation" && rotation.state === "failed"
    ? rotation
    : null;
}
export const claim = internalMutation({
  args: { keyId: v.string() },
  handler: async (ctx, args) => {
    const key = await cleanupTarget(ctx, args.keyId);
    if (!key?.providerRevoke) return null;
    const job = key.providerRevoke;
    if (
      job.state === "complete" ||
      job.state === "needs_review" ||
      job.nextAttemptAt > Date.now() ||
      (job.state === "processing" && (job.leaseUntil ?? 0) > Date.now())
    )
      return null;
    if (job.attempts >= 6) {
      await ctx.db.patch(key._id, {
        providerRevoke: {
          ...job,
          state: "needs_review",
          leaseUntil: undefined,
        },
      });
      return null;
    }
    const attempt = job.attempts + 1;
    await ctx.db.patch(key._id, {
      providerRevoke: {
        state: "processing",
        attempts: attempt,
        leaseUntil: Date.now() + 60_000,
        nextAttemptAt: Date.now() + 60_000,
      },
    });
    await ctx.scheduler.runAfter(
      60_001,
      internal.keyVerification.revokeWithRetry,
      args,
    );
    return attempt;
  },
});
export const finish = internalMutation({
  args: { keyId: v.string(), attempt: v.number(), success: v.boolean() },
  handler: async (ctx, args) => {
    const key = await cleanupTarget(ctx, args.keyId);
    if (
      !key ||
      key.providerRevoke?.state !== "processing" ||
      key.providerRevoke.attempts !== args.attempt
    )
      return;
    const nextAttemptAt = Date.now() + 60_000 * 2 ** Math.min(args.attempt, 6);
    const state = args.success
      ? "complete"
      : args.attempt >= 6
        ? "needs_review"
        : "retry";
    await ctx.db.patch(key._id, {
      providerRevoke: { state, attempts: args.attempt, nextAttemptAt },
    });
    if (state === "retry")
      await ctx.scheduler.runAt(
        nextAttemptAt,
        internal.keyVerification.revokeWithRetry,
        { keyId: args.keyId },
      );
  },
});

/** Recover dispatch lost before claim as well as expired action leases. */
export const recoverDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const state of ["pending", "retry", "processing"] as const) {
      const due = await ctx.db
        .query("apiKeys")
        .withIndex("by_revoke", (q) =>
          q
            .eq("providerRevoke.state", state)
            .lte("providerRevoke.nextAttemptAt", Date.now()),
        )
        .take(50);
      for (const key of due) {
        const keyId =
          key.kind === "key" && key.revokedAt !== undefined
            ? key.keyId
            : key.kind === "rotation" && key.state === "failed"
              ? key.newKeyId
              : undefined;
        if (keyId)
          await ctx.scheduler.runAfter(
            0,
            internal.keyVerification.revokeWithRetry,
            { keyId },
          );
      }
    }
  },
});
