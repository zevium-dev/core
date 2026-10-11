import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { MAX_FUNDING_SLICES } from "../../contracts/money";
import { add, appendWalletEntry, getWallet, money } from "./walletLedger";

export type Slice = Doc<"usageEvents">["fundingSlices"][number];
export const lotState = (remaining: number) =>
  remaining > 0 ? ("available" as const) : ("depleted" as const);
export async function sourceRow(
  ctx: Pick<QueryCtx, "db">,
  lotId: Id<"fundingLots">,
  originLotId: Id<"fundingLots">,
) {
  return ctx.db
    .query("fundingLotSources")
    .withIndex("by_lot_origin", (q) =>
      q.eq("lotId", lotId).eq("originLotId", originLotId),
    )
    .unique();
}
/** Maintain the indexed container flag in the same transaction as source changes.
 * The source index makes this one bounded read, even for a large mixed container.
 */
export async function lotSpendable(
  ctx: Pick<QueryCtx, "db">,
  lotId: Id<"fundingLots">,
) {
  const available = await ctx.db
    .query("fundingLotSources")
    .withIndex("by_lot_spend", (q) =>
      q.eq("lotId", lotId).eq("state", "available"),
    )
    .first();
  return available !== null;
}
/** Trusted provider/admin/signup callers supply a canonical source. No public mint endpoint. */
export async function grantLot(
  ctx: MutationCtx,
  input: {
    walletId: Id<"wallets">;
    sourceRef: string;
    credits: number;
    sourceKind: "payment" | "promo" | "admin";
    paymentId?: Id<"payments">;
  },
) {
  money(input.credits);
  if (
    !input.credits ||
    !input.sourceRef ||
    input.sourceRef.length > 512 ||
    (input.sourceKind === "payment") !== !!input.paymentId
  )
    throw new ConvexError("Invalid funding source");
  let lot = await ctx.db
    .query("fundingLots")
    .withIndex("by_source", (q) => q.eq("sourceRef", input.sourceRef))
    .unique();
  if (input.paymentId) {
    const payment = await ctx.db.get(input.paymentId);
    if (
      !payment ||
      payment.walletId !== input.walletId ||
      payment.credits !== input.credits ||
      (!lot && payment.status !== "paid")
    )
      throw new ConvexError("Payment does not back grant");
  }
  if (
    lot &&
    (lot.walletId !== input.walletId ||
      lot.grantedCredits !== input.credits ||
      lot.sourceKind !== input.sourceKind ||
      lot.paymentId !== input.paymentId)
  )
    throw new ConvexError("Funding reference facts changed");
  if (!lot) {
    await getWallet(ctx, input.walletId);
    const now = Date.now();
    const id = await ctx.db.insert("fundingLots", {
      walletId: input.walletId,
      sourceRef: input.sourceRef,
      sourceKind: input.sourceKind,
      paymentId: input.paymentId,
      spendable: true,
      grantedCredits: input.credits,
      movedInCredits: 0,
      movedOutCredits: 0,
      remainingCredits: input.credits,
      consumedCredits: 0,
      reversedCredits: 0,
      expiredCredits: 0,
      refundable: input.sourceKind === "payment",
      priority:
        input.sourceKind === "promo" ? 0 : input.sourceKind === "admin" ? 1 : 2,
      createdAt: now,
      expiryClass: "never",
      state: "available",
    });
    await ctx.db.patch(id, { orderKey: id });
    lot = (await ctx.db.get(id))!;
    await ctx.db.insert("fundingLotSources", {
      walletId: input.walletId,
      lotId: id,
      originLotId: id,
      sourceRef: input.sourceRef,
      paymentId: input.paymentId,
      sourceCreatedAt: now,
      creditsIn: input.credits,
      creditsOut: 0,
      remainingCredits: input.credits,
      consumedCredits: 0,
      reversedCredits: 0,
      expiredCredits: 0,
      state: "available",
    });
  }
  const result = await appendWalletEntry(
    ctx,
    {
      walletId: input.walletId,
      refId: input.sourceRef,
      kind: input.sourceKind === "promo" ? "promo" : "grant",
      amount: input.credits,
      lotId: lot._id,
      originLotId: lot._id,
      paymentId: input.paymentId,
    },
    input.sourceKind === "promo" ? input.credits : 0,
  );
  return { ...result, lot: (await ctx.db.get(lot._id))! };
}
/** Reference allocator for the DO/checkpoint consumer and drained admin operations.
 * Bounded container/source reads; merging never hides original sources from this cap.
 */
export async function allocate(
  ctx: Pick<QueryCtx, "db">,
  walletId: Id<"wallets">,
  credits: number,
  now = Date.now(),
): Promise<Slice[]> {
  money(credits);
  const wallet = await getWallet(ctx, walletId);
  const spendable = wallet.balance - (wallet.lockedCredits ?? 0);
  if (spendable === 0 || spendable < credits)
    throw new ConvexError("Insufficient credits");
  if (!credits) return [];
  const containers = await ctx.db
    .query("fundingLots")
    .withIndex("by_spend", (q) =>
      q.eq("walletId", walletId).eq("spendable", true),
    )
    .take(MAX_FUNDING_SLICES + 1);
  const slices: Slice[] = [];
  let remaining = credits;
  for (const lot of containers) {
    if (lot.expiresAt !== undefined && lot.expiresAt <= now)
      throw new ConvexError("Funding maintenance required");
    const sources = await ctx.db
      .query("fundingLotSources")
      .withIndex("by_lot_spend", (q) =>
        q.eq("lotId", lot._id).eq("state", "available"),
      )
      .take(MAX_FUNDING_SLICES - slices.length + 1);
    for (const source of sources) {
      if (slices.length === MAX_FUNDING_SLICES)
        throw new ConvexError("Funding capacity exceeded");
      const amount = Math.min(remaining, money(source.remainingCredits));
      if (!amount) throw new ConvexError("Invalid funding inventory");
      slices.push({
        lotId: lot._id,
        originLotId: source.originLotId,
        sourceRef: source.sourceRef,
        ...(source.paymentId ? { paymentId: source.paymentId } : {}),
        credits: amount,
      });
      remaining -= amount;
      if (!remaining) return slices;
    }
  }
  throw new ConvexError("Funding capacity exceeded");
}
export async function validateSlices(
  ctx: Pick<QueryCtx, "db">,
  walletId: Id<"wallets">,
  slices: Slice[],
  admittedAt: number,
  consume: boolean,
) {
  if (slices.length > MAX_FUNDING_SLICES)
    throw new ConvexError("Funding capacity exceeded");
  const totals = new Map<Id<"fundingLots">, number>();
  const seen = new Set<string>();
  for (const slice of slices) {
    const id = `${slice.lotId}:${slice.originLotId}`;
    if (seen.has(id) || !money(slice.credits))
      throw new ConvexError("Invalid funding slices");
    seen.add(id);
    const lot = await ctx.db.get(slice.lotId),
      source = await sourceRow(ctx, slice.lotId, slice.originLotId);
    if (
      !lot ||
      !source ||
      lot.walletId !== walletId ||
      source.walletId !== walletId ||
      source.sourceRef !== slice.sourceRef ||
      source.paymentId !== slice.paymentId ||
      (lot.expiresAt !== undefined && lot.expiresAt <= admittedAt) ||
      (consume &&
        (source.state === "locked" || source.remainingCredits < slice.credits))
    )
      throw new ConvexError("Funding evidence rejected");
    totals.set(lot._id, add(totals.get(lot._id) ?? 0, slice.credits));
    if (consume && lot.remainingCredits < totals.get(lot._id)!)
      throw new ConvexError("Funding evidence rejected");
  }
}
export async function consumeSlices(ctx: MutationCtx, slices: Slice[]) {
  let promo = 0;
  for (const slice of slices) {
    const lot = (await ctx.db.get(slice.lotId))!,
      source = (await sourceRow(ctx, slice.lotId, slice.originLotId))!;
    const remainingCredits = add(lot.remainingCredits, -slice.credits);
    const left = add(source.remainingCredits, -slice.credits);
    await ctx.db.patch(source._id, {
      remainingCredits: left,
      consumedCredits: add(source.consumedCredits, slice.credits),
      state: lotState(left),
    });
    await ctx.db.patch(lot._id, {
      spendable: await lotSpendable(ctx, lot._id),
      remainingCredits,
      consumedCredits: add(lot.consumedCredits, slice.credits),
      state: lotState(remainingCredits),
    });
    if (lot.sourceKind === "promo") promo = add(promo, slice.credits);
  }
  return promo;
}
