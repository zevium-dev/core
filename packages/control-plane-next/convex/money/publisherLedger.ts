import { holdPublisher } from "./reconciliationCases";
import { ConvexError } from "convex/values";
import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fingerprint } from "../../contracts/transport";
import { add, facts, money } from "./walletLedger";
import { publisherEarningSplit } from "../accounting";
import { financialRollup } from "./financialRollups";

export function signed(value: number) {
  if (!Number.isSafeInteger(value))
    throw new ConvexError("Invalid accounting amount");
  return value;
}
export async function publisherBalance(
  ctx: MutationCtx,
  publisherOrganizationId: Id<"organizations">,
) {
  let row = await ctx.db
    .query("publisherBalances")
    .withIndex("by_publisher", (q) =>
      q.eq("publisherOrganizationId", publisherOrganizationId),
    )
    .unique();
  if (!row) {
    const id = await ctx.db.insert("publisherBalances", {
      publisherOrganizationId,
      availableAtoms: 0,
      allocatedAtoms: 0,
      paidAtoms: 0,
      reversedAtoms: 0,
      sequence: 0,
      transferSequence: 0,
      updatedAt: Date.now(),
    });
    row = (await ctx.db.get(id))!;
  }
  return row;
}
type Input = Omit<
  WithoutSystemFields<Doc<"publisherLedgerEntries">>,
  "sequence" | "createdAt" | "immutableFingerprint"
>;
export async function appendPublisherEntry(ctx: MutationCtx, input: Input) {
  const hash = await fingerprint(facts(input));
  const prior = await ctx.db
    .query("publisherLedgerEntries")
    .withIndex("by_ref", (q) => q.eq("refId", input.refId))
    .unique();
  if (prior) {
    if (prior.immutableFingerprint !== hash)
      throw new ConvexError("Publisher reference facts changed");
    return false;
  }
  const balance = await publisherBalance(ctx, input.publisherOrganizationId);
  const sequence = add(balance.sequence, 1);
  await ctx.db.insert("publisherLedgerEntries", {
    ...input,
    sequence,
    immutableFingerprint: hash,
    createdAt: Date.now(),
  });
  await ctx.db.patch(balance._id, {
    availableAtoms: signed(
      balance.availableAtoms + signed(input.availableDeltaAtoms),
    ),
    allocatedAtoms: add(
      balance.allocatedAtoms,
      signed(input.allocatedDeltaAtoms),
    ),
    paidAtoms: add(balance.paidAtoms, signed(input.paidDeltaAtoms)),
    reversedAtoms: add(
      balance.reversedAtoms,
      signed(input.reversedDeltaAtoms ?? 0),
    ),
    failedAtoms: add(
      balance.failedAtoms ?? 0,
      input.kind === "failure" ? input.availableDeltaAtoms : 0,
    ),
    sequence,
    updatedAt: Date.now(),
  });
  return true;
}
export async function releaseEarning(
  ctx: MutationCtx,
  id: Id<"publisherEarnings">,
) {
  const e = await ctx.db.get(id);
  if (!e || e.state === "released" || e.availableAt > Date.now()) return false;
  const payment = e.paymentId ? await ctx.db.get(e.paymentId) : null;
  if (payment && payment.reconciliation.state !== "complete") {
    await ctx.db.patch(id, { releaseAfter: Date.now() + 60_000 });
    return false;
  }
  const atoms = add(e.netAtoms, -e.clawedBackAtoms);
  await appendPublisherEntry(ctx, {
    publisherOrganizationId: e.publisherOrganizationId,
    refId: `release:${id}`,
    kind: "release",
    availableDeltaAtoms: atoms,
    allocatedDeltaAtoms: 0,
    paidDeltaAtoms: 0,
    earningId: id,
    paymentId: e.paymentId,
  });
  await ctx.db.patch(id, {
    state: "released",
    releasedAtoms: atoms,
    updatedAt: Date.now(),
  });
  await financialRollup(ctx, e, -atoms, 0, 0);
  return true;
}
/** Immutable gross/net remain earned totals; current held/released plus reversed equals earned. */
export async function reverseEarning(
  ctx: MutationCtx,
  e: Doc<"publisherEarnings">,
  credits: number,
  adjustmentId: Id<"paymentAdjustments">,
  refId: string,
) {
  money(credits);
  if (
    !credits ||
    credits > e.grossCredits - e.clawedBackGrossCredits ||
    !e.paymentId
  )
    throw new ConvexError("Invalid earning reversal");
  const split = publisherEarningSplit(credits);
  const atoms = split.publisherNetAtoms;
  const applied = await appendPublisherEntry(ctx, {
    publisherOrganizationId: e.publisherOrganizationId,
    refId,
    kind: "reversal",
    availableDeltaAtoms: e.state === "released" ? -atoms : 0,
    allocatedDeltaAtoms: 0,
    paidDeltaAtoms: 0,
    reversedDeltaAtoms: atoms,
    earningId: e._id,
    paymentId: e.paymentId,
    adjustmentId,
    grossReversedCredits: credits,
    platformDeltaAtoms: -split.platformFeeAtoms,
  });
  if (!applied) return;
  await ctx.db.patch(e._id, {
    clawedBackGrossCredits: add(e.clawedBackGrossCredits, credits),
    clawedBackAtoms: add(e.clawedBackAtoms, atoms),
    releasedAtoms: e.state === "released" ? add(e.releasedAtoms, -atoms) : 0,
    updatedAt: Date.now(),
  });
  await financialRollup(
    ctx,
    e,
    e.state === "pending" ? -atoms : 0,
    atoms,
    split.platformFeeAtoms,
  );
}
export async function restoreEarning(
  ctx: MutationCtx,
  entry: Doc<"publisherLedgerEntries">,
) {
  if (entry.kind !== "reversal" || !entry.earningId || !entry.adjustmentId)
    throw new ConvexError("Invalid earning restoration");
  const refId = `restore:${entry.refId}`;
  if (
    await ctx.db
      .query("publisherLedgerEntries")
      .withIndex("by_ref", (q) => q.eq("refId", refId))
      .unique()
  )
    return false;
  const e = (await ctx.db.get(entry.earningId))!;
  await holdPublisher(ctx, e.paymentId!, e.publisherOrganizationId);
  const credits = money(entry.grossReversedCredits!),
    atoms = money(entry.reversedDeltaAtoms!);
  await appendPublisherEntry(ctx, {
    publisherOrganizationId: e.publisherOrganizationId,
    refId,
    kind: "restoration",
    availableDeltaAtoms: e.state === "released" ? atoms : 0,
    allocatedDeltaAtoms: 0,
    paidDeltaAtoms: 0,
    reversedDeltaAtoms: -atoms,
    earningId: e._id,
    paymentId: e.paymentId,
    adjustmentId: entry.adjustmentId,
    grossReversedCredits: -credits,
    platformDeltaAtoms: -(entry.platformDeltaAtoms ?? 0),
  });
  await ctx.db.patch(e._id, {
    clawedBackGrossCredits: add(e.clawedBackGrossCredits, -credits),
    clawedBackAtoms: add(e.clawedBackAtoms, -atoms),
    releasedAtoms: e.state === "released" ? add(e.releasedAtoms, atoms) : 0,
    updatedAt: Date.now(),
  });
  await financialRollup(
    ctx,
    e,
    e.state === "pending" ? atoms : 0,
    -atoms,
    entry.platformDeltaAtoms ?? 0,
  );
  return true;
}
