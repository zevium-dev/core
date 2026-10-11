import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  compatibleLots,
  DEFAULT_DUST_THRESHOLD_CREDITS,
  MAX_FUNDING_SLICES,
} from "../../contracts/money";
import { add, appendWalletEntry, getWallet, money } from "./walletLedger";
import { lotState, sourceRow } from "./lots";
import { finishClose, requestClose, requireDrained } from "./barrier";
export async function beginDustMerge(
  ctx: MutationCtx,
  lotId: Id<"fundingLots">,
  threshold = DEFAULT_DUST_THRESHOLD_CREDITS,
) {
  money(threshold);
  const lot = await ctx.db.get(lotId);
  if (!lot) throw new ConvexError("Funding lot not found");
  if (lot.merge && lot.merge.state !== "complete") return lot;
  if (
    !lot.remainingCredits ||
    lot.remainingCredits >= threshold ||
    (lot.expiresAt !== undefined && lot.expiresAt <= Date.now())
  )
    return null;
  // A container holding only review-locked balances has nothing movable; never freeze for it.
  const movable = await ctx.db
    .query("fundingLotSources")
    .withIndex("by_lot_spend", (q) =>
      q.eq("lotId", lot._id).eq("state", "available"),
    )
    .first();
  if (!movable) return null;
  const target = await ctx.db
    .query("fundingLots")
    .withIndex("by_merge_target", (q) =>
      q
        .eq("walletId", lot.walletId)
        .eq("expiryClass", lot.expiryClass)
        .eq("sourceKind", lot.sourceKind)
        .eq("refundable", lot.refundable)
        .eq("priority", lot.priority)
        .eq("state", "available"),
    )
    .order("desc")
    .first();
  if (
    !target ||
    !compatibleLots(lot, target) ||
    target._id === lot._id ||
    target.createdAt < lot.createdAt ||
    (target.createdAt === lot.createdAt && target._id <= lot._id)
  )
    return null;
  const generation = add(lot.merge?.generation ?? 0, 1),
    id = `merge:${lot._id}:${generation}`;
  await requestClose(ctx, lot.walletId, id, "dust_merge");
  await ctx.db.patch(lot._id, {
    merge: { id, toLotId: target._id, state: "pending", generation },
  });
  return (await ctx.db.get(lotId))!;
}
/** At most 32 source rows and 32 zero-delta journal entries per transaction. */
export async function moveDustPage(
  ctx: MutationCtx,
  lotId: Id<"fundingLots">,
  generation: number,
) {
  const lot = await ctx.db.get(lotId);
  if (
    !lot?.merge ||
    lot.merge.generation !== generation ||
    lot.merge.state === "complete"
  )
    return { complete: true, waiting: false };
  const wallet = await getWallet(ctx, lot.walletId);
  if (wallet.close?.id !== lot.merge.id)
    throw new ConvexError("Merge closure conflict");
  if (wallet.close.ackAt === undefined)
    return { complete: false, waiting: true };
  await requireDrained(ctx, lot.walletId, lot.merge.id, "dust_merge");
  const target = await ctx.db.get(lot.merge.toLotId);
  if (!target || !compatibleLots(lot, target))
    throw new ConvexError("Incompatible funding lots");
  const page = await ctx.db
    .query("fundingLotSources")
    .withIndex("by_lot_origin", (q) => q.eq("lotId", lotId))
    .paginate({
      cursor: lot.merge.cursor ?? null,
      numItems: MAX_FUNDING_SLICES,
    });
  for (const source of page.page) {
    const amount = source.remainingCredits;
    if (!amount || source.state === "locked") continue;
    const result = await appendWalletEntry(ctx, {
      walletId: lot.walletId,
      kind: "lot_move",
      amount: 0,
      refId: `${lot.merge.id}:${source.originLotId}`,
      mergeId: lot.merge.id,
      fromLotId: lotId,
      toLotId: target._id,
      originLotId: source.originLotId,
      sourceRef: source.sourceRef,
      paymentId: source.paymentId,
      movedCredits: amount,
      reason: "dust_merge",
    });
    if (!result.applied)
      throw new ConvexError("Merge cursor conflicts with journal");
    const existing = await sourceRow(ctx, target._id, source.originLotId);
    // Locks cover every row of a payment at once; a mixed origin would unlock silently.
    if (existing?.state === "locked")
      throw new ConvexError("Locked funding source cannot merge");
    if (existing) {
      await ctx.db.patch(existing._id, {
        creditsIn: add(existing.creditsIn, amount),
        remainingCredits: add(existing.remainingCredits, amount),
        state: "available",
      });
    } else {
      await ctx.db.insert("fundingLotSources", {
        walletId: lot.walletId,
        lotId: target._id,
        originLotId: source.originLotId,
        sourceRef: source.sourceRef,
        paymentId: source.paymentId,
        sourceCreatedAt: source.sourceCreatedAt,
        creditsIn: amount,
        creditsOut: 0,
        remainingCredits: amount,
        consumedCredits: 0,
        reversedCredits: 0,
        expiredCredits: 0,
        state: "available",
      });
    }
    await ctx.db.patch(source._id, {
      remainingCredits: 0,
      creditsOut: add(source.creditsOut, amount),
      state: "depleted",
    });
    const from = (await ctx.db.get(lotId))!,
      to = (await ctx.db.get(target._id))!;
    const left = add(from.remainingCredits, -amount);
    await ctx.db.patch(lotId, {
      remainingCredits: left,
      movedOutCredits: add(from.movedOutCredits, amount),
      state: lotState(left),
    });
    await ctx.db.patch(target._id, {
      remainingCredits: add(to.remainingCredits, amount),
      movedInCredits: add(to.movedInCredits, amount),
      state: "available",
    });
  }
  await ctx.db.patch(lotId, {
    merge: {
      ...lot.merge,
      state: page.isDone ? "complete" : "moving",
      cursor: page.continueCursor,
    },
  });
  if (page.isDone) await finishClose(ctx, lot.walletId, lot.merge.id);
  return { complete: page.isDone, waiting: false };
}
