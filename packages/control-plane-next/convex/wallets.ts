import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireActiveOrg } from "./lib/auth";
import { checkpoint, getWallet } from "./money/walletLedger";
import { settleOne, type Outcome } from "./money/settle";
import { ingestUsage } from "../contracts/settlement";
import { acknowledgeDrain, finishClose, requestClose } from "./money/barrier";
import { beginDustMerge, moveDustPage } from "./money/dust";
import {
  applyAdminDecrease,
  beginAdminDecrease,
  restoreAdminDecrease,
} from "./money/sourceAdjustments";

export const getMyWallet = query({
  args: { orgSlug: v.string() },
  handler: async (ctx) => {
    const { org } = await requireActiveOrg(ctx);
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_owner", (q) => q.eq("ownerKey", `org:${org.clerkOrgId}`))
      .unique();
    if (!wallet) return { balance: 0, sequence: 0, entries: [] };
    const entries = await ctx.db
      .query("walletEntries")
      .withIndex("by_wallet_sequence", (q) => q.eq("walletId", wallet._id))
      .order("desc")
      .take(20);
    return {
      balance: wallet.balance,
      sequence: wallet.sequence,
      entries: entries.map((e) => ({
        id: e._id,
        kind: e.kind,
        amount: e.amount,
        sequence: e.sequence,
        createdAt: e.createdAt,
      })),
    };
  },
});
export const getCheckpoint = internalQuery({
  args: { walletId: v.id("wallets") },
  handler: async (ctx, args) => checkpoint(await getWallet(ctx, args.walletId)),
});
export const settleEvent = internalMutation({
  args: { eventJson: v.string() },
  handler: async (ctx, args): Promise<Outcome> => {
    if (args.eventJson.length > 1_048_576)
      throw new Error("Settlement too large");
    return settleOne(ctx, JSON.parse(args.eventJson));
  },
});
/** HTTP batch orchestration; per-event mutation rollback isolates poisoned refs and bounds writes. */
export const recordUsage = internalAction({
  args: { bodyJson: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ results: Outcome[]; wallet: ReturnType<typeof checkpoint> }> => {
    if (args.bodyJson.length > 1_048_576)
      throw new Error("Settlement too large");
    const { events } = ingestUsage.parse(JSON.parse(args.bodyJson));
    const results: Outcome[] = [];
    // Sorting advances the contiguous watermark even if the transport reordered finals.
    for (const event of [...events].sort(
      (a, b) => a.epoch - b.epoch || a.edgeSequence - b.edgeSequence,
    )) {
      try {
        results.push(
          await ctx.runMutation(internal.wallets.settleEvent, {
            eventJson: JSON.stringify(event),
          }),
        );
      } catch {
        results.push({
          refId: event.settleRefId,
          status: "rejected",
          reason: "Settlement temporarily unavailable",
          retryable: true,
        });
      }
    }
    const wallet = await ctx.runQuery(internal.wallets.getCheckpoint, {
      walletId: events[0]
        .walletId as import("./_generated/dataModel").Id<"wallets">,
    });
    return { results, wallet };
  },
});
export const ackDrain = internalMutation({
  args: { ackJson: v.string() },
  handler: async (ctx, args) =>
    checkpoint(await acknowledgeDrain(ctx, JSON.parse(args.ackJson))),
});
export const closeWallet = internalMutation({
  args: {
    walletId: v.id("wallets"),
    closeId: v.string(),
    reason: v.union(
      v.literal("refund"),
      v.literal("dispute"),
      v.literal("expiry"),
      v.literal("archive"),
      v.literal("admin"),
    ),
  },
  handler: async (ctx, args) =>
    checkpoint(
      await requestClose(ctx, args.walletId, args.closeId, args.reason),
    ),
});
export const finishArchive = internalMutation({
  args: { walletId: v.id("wallets"), closeId: v.string() },
  handler: async (ctx, args) => {
    const wallet = await getWallet(ctx, args.walletId);
    if (wallet.gateState === "closed" && wallet.close?.id === args.closeId)
      return checkpoint(wallet);
    if (wallet.close?.reason !== "archive")
      throw new Error("Archive closure required");
    return checkpoint(await finishClose(ctx, args.walletId, args.closeId));
  },
});
export const beginDecrease = internalMutation({
  args: { walletId: v.id("wallets"), credits: v.number() },
  handler: async (ctx, args) =>
    checkpoint(await beginAdminDecrease(ctx, args.walletId, args.credits)),
});
export const applyDecrease = internalMutation({
  args: { walletId: v.id("wallets"), ref: v.string(), credits: v.number() },
  handler: async (ctx, args) =>
    checkpoint(
      await applyAdminDecrease(ctx, args.walletId, args.ref, args.credits),
    ),
});
export const restoreDecrease = internalMutation({
  args: { walletId: v.id("wallets"), ref: v.string(), closeId: v.string() },
  handler: async (ctx, args) =>
    checkpoint(
      await restoreAdminDecrease(ctx, args.walletId, args.ref, args.closeId),
    ),
});
export const beginMerge = internalMutation({
  args: { lotId: v.id("fundingLots"), threshold: v.optional(v.number()) },
  handler: async (ctx, args) => beginDustMerge(ctx, args.lotId, args.threshold),
});
export const mergePage = internalMutation({
  args: { lotId: v.id("fundingLots"), generation: v.number() },
  handler: async (ctx, args) => {
    const result = await moveDustPage(ctx, args.lotId, args.generation);
    if (!result.complete && !result.waiting)
      await ctx.scheduler.runAfter(0, internal.wallets.mergePage, args);
    return result;
  },
});
export const recoverMerges = internalMutation({
  args: {
    state: v.union(v.literal("pending"), v.literal("moving")),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("fundingLots")
      .withIndex("by_merge_due", (q) => q.eq("merge.state", args.state))
      .paginate({ cursor: args.cursor, numItems: 32 });
    for (const lot of page.page)
      await ctx.scheduler.runAfter(0, internal.wallets.mergePage, {
        lotId: lot._id,
        generation: lot.merge!.generation,
      });
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.wallets.recoverMerges, {
        ...args,
        cursor: page.continueCursor,
      });
  },
});
