import { v } from "convex/values";
import { internalMutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { beginDustMerge } from "./money/dust";
import { finishClose } from "./money/barrier";
import { applyAdminDecrease } from "./money/sourceAdjustments";

export const wakeWallet = internalAction({
  args: { clerkOrgId: v.string(), attempt: v.optional(v.number()) },
  handler: async (ctx, { clerkOrgId, attempt = 0 }): Promise<void> => {
    const origin = process.env.NEXT_GATEWAY_URL;
    if (
      !origin ||
      !process.env.GATEWAY_INTERNAL_SECRET ||
      !process.env.NEXT_DEPLOYMENT_ID
    )
      return;
    try {
      const response = await fetch(new URL("/internal/next-wake", origin), {
        method: "POST",
        headers: {
          "x-internal-secret": process.env.GATEWAY_INTERNAL_SECRET,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clerkOrgId,
          deploymentId: process.env.NEXT_DEPLOYMENT_ID,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("Wallet wake unavailable");
    } catch {
      // Open wallets no longer appear in the closing scan. Bound retries for both paths.
      if (attempt < 3)
        await ctx.scheduler.runAfter(
          1000 * 2 ** attempt,
          internal.edgeMaintenance.wakeWallet,
          {
            clerkOrgId,
            attempt: attempt + 1,
          },
        );
    }
  },
});
/** Recover only positively acknowledged closures. Payment and dust owners retain
 * their own page/generation machinery; no elapsed-time drain inference. */
export const recover = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("wallets")
      .withIndex("by_gate", (q) => q.eq("gateState", "closing"))
      .paginate({ cursor: args.cursor, numItems: 32 });
    for (const wallet of page.page) {
      const close = wallet.close;
      if (close?.ackAt === undefined) {
        if (process.env.NEXT_GATEWAY_URL)
          await ctx.scheduler.runAfter(0, internal.edgeMaintenance.wakeWallet, {
            clerkOrgId: wallet.owner.clerkOrgId,
          });
        continue;
      }
      if (close.reason === "archive")
        await finishClose(ctx, wallet._id, close.id);
      if (close.reason === "admin" && close.command)
        await applyAdminDecrease(
          ctx,
          wallet._id,
          close.id,
          close.command.credits,
        );
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(1000, internal.edgeMaintenance.recover, {
        cursor: page.continueCursor,
      });
  },
});
export const discoverDust = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("fundingLots")
      .withIndex("by_dust", (q) =>
        q
          .eq("state", "available")
          .gt("remainingCredits", 0)
          .lt("remainingCredits", 1000),
      )
      .paginate({ cursor: args.cursor, numItems: 16 });
    for (const lot of page.page) {
      if (lot.merge) continue;
      const wallet = await ctx.db.get(lot.walletId);
      if (wallet?.gateState !== "open") continue;
      await beginDustMerge(ctx, lot._id);
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(
        1000,
        internal.edgeMaintenance.discoverDust,
        { cursor: page.continueCursor },
      );
  },
});
