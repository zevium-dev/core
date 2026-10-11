import { recordBreakage } from "./financialRollups";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fingerprint } from "../../contracts/transport";
import { MAX_FUNDING_SLICES } from "../../contracts/money";
import {
  add,
  appendWalletEntry,
  facts,
  getWallet,
  money,
} from "./walletLedger";
import {
  allocate,
  lotState,
  lotSpendable,
  sourceRow,
  type Slice,
} from "./lots";
import {
  abandonClose,
  finishClose,
  requestClose,
  requireDrained,
} from "./barrier";
type Adjustment = Extract<
  Doc<"walletEntries">,
  { kind: "reversal" | "restoration" }
>["adjustment"];
/** PR 4 supplies verified canonical payment adjustments; source identity is never inferred from the container. */
export async function reverseSource(
  ctx: MutationCtx,
  input: {
    walletId: Id<"wallets">;
    closeId: string;
    refId: string;
    slice: Slice;
    adjustment: Adjustment;
    requestFingerprint: string;
  },
) {
  const { slice } = input;
  const lot = await ctx.db.get(slice.lotId),
    source = await sourceRow(ctx, slice.lotId, slice.originLotId);
  if (
    !lot ||
    !source ||
    lot.walletId !== input.walletId ||
    source.sourceRef !== slice.sourceRef ||
    source.paymentId !== slice.paymentId ||
    !money(slice.credits)
  )
    throw new ConvexError("Funding evidence rejected");
  const prior = await ctx.db
    .query("walletEntries")
    .withIndex("by_ref", (q) => q.eq("refId", input.refId))
    .unique();
  if (prior)
    return appendWalletEntry(
      ctx,
      {
        walletId: input.walletId,
        kind: "reversal",
        refId: input.refId,
        amount: -slice.credits,
        lotId: slice.lotId,
        originLotId: slice.originLotId,
        paymentId: slice.paymentId,
        adjustment: input.adjustment,
        requestFingerprint: input.requestFingerprint,
        closeId: input.closeId,
      },
      lot.sourceKind === "promo" ? -slice.credits : 0,
    );
  const wallet = await requireDrained(ctx, input.walletId, input.closeId);
  if (
    input.adjustment.kind === "admin"
      ? wallet.close?.reason !== "admin" ||
        input.closeId !== input.adjustment.ref
      : wallet.close?.reason !== "refund" && wallet.close?.reason !== "dispute"
  )
    throw new ConvexError("Adjustment does not own wallet closure");
  if (input.adjustment.kind === "payment") {
    const adjustment = await ctx.db.get(input.adjustment.id);
    const payment = slice.paymentId ? await ctx.db.get(slice.paymentId) : null;
    if (
      !adjustment ||
      adjustment.paymentId !== slice.paymentId ||
      !lot.refundable ||
      adjustment.closeId !== input.closeId ||
      !payment ||
      adjustment.closeGeneration !== payment.reconciliation.generation
    )
      throw new ConvexError("Adjustment source mismatch");
  }
  const result = await appendWalletEntry(
    ctx,
    {
      walletId: input.walletId,
      kind: "reversal",
      refId: input.refId,
      amount: -slice.credits,
      lotId: slice.lotId,
      originLotId: slice.originLotId,
      paymentId: slice.paymentId,
      adjustment: input.adjustment,
      requestFingerprint: input.requestFingerprint,
      closeId: input.closeId,
    },
    lot.sourceKind === "promo" ? -slice.credits : 0,
  );
  if (result.applied) {
    const remainingCredits = add(lot.remainingCredits, -slice.credits),
      left = add(source.remainingCredits, -slice.credits);
    await ctx.db.patch(source._id, {
      remainingCredits: left,
      reversedCredits: add(source.reversedCredits, slice.credits),
      state: source.state === "locked" ? "locked" : lotState(left),
    });
    await ctx.db.patch(lot._id, {
      spendable: await lotSpendable(ctx, lot._id),
      remainingCredits,
      reversedCredits: add(lot.reversedCredits, slice.credits),
      state: lotState(remainingCredits),
    });
    if (source.state === "locked")
      await ctx.db.patch(input.walletId, {
        lockedCredits: add(wallet.lockedCredits ?? 0, -slice.credits),
      });
  }
  return result;
}
/** Restore exactly this journal fact; deterministic restoration/expiry refs survive repeated moves. */
export async function restoreSource(
  ctx: MutationCtx,
  entry: Doc<"walletEntries">,
  refId: string,
  closeId: string,
) {
  if (entry.kind !== "reversal" || refId !== `restore:${entry.refId}`)
    throw new ConvexError("Reversal not found");
  const lot = (await ctx.db.get(entry.lotId))!,
    source = (await sourceRow(ctx, entry.lotId, entry.originLotId))!;
  if (!lot || !source) throw new ConvexError("Funding source not found");
  const amount = -entry.amount;
  const prior = await ctx.db
    .query("walletEntries")
    .withIndex("by_ref", (q) => q.eq("refId", refId))
    .unique();
  if (prior) {
    await ctx.db.patch(entry._id, {
      restoredAt: entry.restoredAt ?? Date.now(),
    });
    return appendWalletEntry(
      ctx,
      {
        walletId: entry.walletId,
        kind: "restoration",
        refId,
        amount,
        lotId: entry.lotId,
        originLotId: entry.originLotId,
        paymentId: entry.paymentId,
        adjustment: entry.adjustment,
        requestFingerprint: entry.immutableFingerprint,
        closeId,
      },
      lot.sourceKind === "promo" ? amount : 0,
    );
  }
  const wallet = await requireDrained(ctx, entry.walletId, closeId);
  if (
    entry.adjustment.kind === "admin"
      ? wallet.close?.reason !== "admin" || wallet.close.command !== undefined
      : wallet.close?.reason !== "refund" && wallet.close?.reason !== "dispute"
  )
    throw new ConvexError("Restoration does not own wallet closure");
  if (entry.adjustment.kind === "payment") {
    const adjustment = await ctx.db.get(entry.adjustment.id);
    const payment = entry.paymentId ? await ctx.db.get(entry.paymentId) : null;
    if (
      !adjustment ||
      adjustment.closeId !== closeId ||
      !payment ||
      adjustment.closeGeneration !== payment.reconciliation.generation
    )
      throw new ConvexError("Restoration does not own payment generation");
  }
  const result = await appendWalletEntry(
    ctx,
    {
      walletId: entry.walletId,
      kind: "restoration",
      refId,
      amount,
      lotId: entry.lotId,
      originLotId: entry.originLotId,
      paymentId: entry.paymentId,
      adjustment: entry.adjustment,
      requestFingerprint: entry.immutableFingerprint,
      closeId,
    },
    lot.sourceKind === "promo" ? amount : 0,
  );
  if (!result.applied) return result;
  await ctx.db.patch(entry._id, { restoredAt: Date.now() });
  const expired = lot.expiresAt !== undefined && lot.expiresAt <= Date.now();
  await ctx.db.patch(source._id, {
    reversedCredits: add(source.reversedCredits, -amount),
    remainingCredits: add(source.remainingCredits, expired ? 0 : amount),
    expiredCredits: add(source.expiredCredits, expired ? amount : 0),
    state:
      source.state === "locked" ? "locked" : expired ? "expired" : "available",
  });
  await ctx.db.patch(lot._id, {
    spendable: await lotSpendable(ctx, lot._id),
    reversedCredits: add(lot.reversedCredits, -amount),
    remainingCredits: add(lot.remainingCredits, expired ? 0 : amount),
    expiredCredits: add(lot.expiredCredits, expired ? amount : 0),
    state: expired ? "expired" : "available",
  });
  if (source.state === "locked" && !expired)
    await ctx.db.patch(entry.walletId, {
      lockedCredits: add(wallet.lockedCredits ?? 0, amount),
    });
  if (expired) {
    await appendWalletEntry(
      ctx,
      {
        walletId: entry.walletId,
        kind: "expiry",
        refId: `expiry:${refId}`,
        amount: -amount,
        breakageCredits: amount,
        lotId: entry.lotId,
        originLotId: entry.originLotId,
      },
      lot.sourceKind === "promo" ? -amount : 0,
    );
    await recordBreakage(ctx, `expiry:${refId}`, amount);
  }
  return { ...result, wallet: await getWallet(ctx, entry.walletId) };
}
export async function adminEntries(
  ctx: MutationCtx,
  walletId: Id<"wallets">,
  ref: string,
) {
  const entries = await ctx.db
    .query("walletEntries")
    .withIndex("by_admin_adjustment", (q) =>
      q
        .eq("walletId", walletId)
        .eq("adjustment.kind", "admin")
        .eq("adjustment.ref", ref),
    )
    .take(MAX_FUNDING_SLICES * 2 + 1);
  if (entries.length > MAX_FUNDING_SLICES * 2)
    throw new ConvexError("Adjustment exceeds source bound");
  return entries;
}
export async function beginAdminDecrease(
  ctx: MutationCtx,
  walletId: Id<"wallets">,
  credits: number,
  operationId: string,
) {
  if (!operationId || operationId.length > 200)
    throw new ConvexError("Invalid operation ID");
  if (!money(credits)) throw new ConvexError("Adjustment must be positive");
  const wallet = await getWallet(ctx, walletId);
  const ref = `admin:${walletId}:${operationId}`;
  const command = {
    credits,
    fingerprint: await fingerprint({
      walletId,
      credits,
      kind: "admin_decrease",
      ref,
    }),
  };
  const prior = await adminEntries(ctx, walletId, ref);
  if (prior.length) {
    if (
      prior.some(
        (e) =>
          e.kind === "reversal" && e.requestFingerprint !== command.fingerprint,
      )
    )
      throw new ConvexError("Adjustment facts changed");
    return wallet;
  }
  if (
    wallet.gateState === "closing" &&
    wallet.close?.reason === "admin" &&
    wallet.close.command?.fingerprint === command.fingerprint
  )
    return wallet;
  return requestClose(ctx, walletId, ref, "admin", command);
}
export async function applyAdminDecrease(
  ctx: MutationCtx,
  walletId: Id<"wallets">,
  ref: string,
  credits: number,
) {
  const requestFingerprint = await fingerprint({
    walletId,
    credits: money(credits),
    kind: "admin_decrease",
    ref,
  });
  const prior = await adminEntries(ctx, walletId, ref);
  if (prior.length) {
    if (
      prior.some(
        (e) =>
          e.kind === "reversal" && e.requestFingerprint !== requestFingerprint,
      )
    )
      throw new ConvexError("Adjustment facts changed");
    return {
      wallet: await getWallet(ctx, walletId),
      status: "applied" as const,
    };
  }
  const current = await getWallet(ctx, walletId);
  if (current.close?.id === ref && current.close.abandoned) {
    if (current.close.command?.fingerprint !== requestFingerprint)
      throw new ConvexError("Adjustment facts changed");
    return { wallet: current, status: "abandoned" as const };
  }
  const wallet = await requireDrained(ctx, walletId, ref, "admin");
  if (wallet.close?.command?.fingerprint !== requestFingerprint)
    throw new ConvexError("Adjustment facts changed");
  let slices: Slice[];
  try {
    slices = await allocate(ctx, walletId, credits);
  } catch (error) {
    if (!(error instanceof ConvexError)) throw error;
    return {
      wallet: await abandonClose(ctx, walletId, ref),
      status: "abandoned" as const,
    };
  }
  for (const slice of slices)
    await reverseSource(ctx, {
      walletId,
      closeId: ref,
      refId: `${ref}:${slice.lotId}:${slice.originLotId}`,
      slice: facts(slice),
      adjustment: { kind: "admin", ref },
      requestFingerprint,
    });
  return {
    wallet: await finishClose(ctx, walletId, ref),
    status: "applied" as const,
  };
}
export async function restoreAdminDecrease(
  ctx: MutationCtx,
  walletId: Id<"wallets">,
  ref: string,
  closeId: string,
) {
  const prior = await adminEntries(ctx, walletId, ref);
  const reversals = prior.filter((e) => e.kind === "reversal");
  if (!reversals.length) throw new ConvexError("Adjustment not found");
  if (prior.filter((e) => e.kind === "restoration").length === reversals.length)
    return getWallet(ctx, walletId);
  await requireDrained(ctx, walletId, closeId, "admin");
  for (const entry of reversals)
    await restoreSource(ctx, entry, `restore:${entry.refId}`, closeId);
  return finishClose(ctx, walletId, closeId);
}
