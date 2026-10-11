import { createNotification } from "../lib/notifications";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fingerprint } from "../../contracts/transport";
import { add, money } from "./walletLedger";
import { appendPublisherEntry, publisherBalance } from "./publisherLedger";
import {
  ACCOUNTING_ATOMS_PER_USD_CENT,
  atomsToUsdCents,
  PUBLISHER_MINIMUM_PAYOUT_CENTS,
} from "../accounting";
import { openCase, caseEvidence } from "./reconciliationCases";
export const SAFE_TRANSFER_REPLAY_MS = 23 * 60 * 60 * 1000;
export const LEASE_MS = 5 * 60 * 1000;
export async function prepareTransfer(
  ctx: MutationCtx,
  org: Doc<"organizations">,
) {
  if (
    !org.connect ||
    org.connect.status !== "active" ||
    org.connect.livemode ||
    org.archivedAt !== undefined
  )
    throw new ConvexError("Publisher payouts are not ready");
  const blocked = await ctx.db
    .query("financeReconciliationCases")
    .withIndex("by_org_hold", (q) =>
      q
        .eq("rowKind", "case")
        .eq("organizationId", org._id)
        .eq("kind", "publisher_hold")
        .eq("status", "open"),
    )
    .first();
  if (blocked) throw new ConvexError("Publisher reconciliation is pending");
  const b = await publisherBalance(ctx, org._id);
  const cents = atomsToUsdCents(Math.max(0, b.availableAtoms));
  if (cents < PUBLISHER_MINIMUM_PAYOUT_CENTS)
    throw new ConvexError("Minimum payout is $10");
  const sequence = add(b.transferSequence, 1),
    amountAtoms = money(cents * ACCOUNTING_ATOMS_PER_USD_CENT);
  const base = {
    publisherOrganizationId: org._id,
    destination: org.connect.accountId,
    platformAccountId: org.connect.platformAccountId,
    livemode: false,
    currency: "usd" as const,
    amountCents: cents,
    amountAtoms,
    idempotencyKey: `publisher-transfer:${org._id}:${sequence}`,
    operationNonce: crypto.randomUUID() + crypto.randomUUID(),
  };
  const id = await ctx.db.insert("publisherTransfers", {
    ...base,
    requestFingerprint: await fingerprint(base),
    reversedCents: 0,
    status: "created",
    dispatchState: "prepared",
    attempts: 0,
    nextAttemptAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await appendPublisherEntry(ctx, {
    publisherOrganizationId: org._id,
    refId: `allocate:${id}`,
    kind: "allocate",
    availableDeltaAtoms: -amountAtoms,
    allocatedDeltaAtoms: amountAtoms,
    paidDeltaAtoms: 0,
    transferId: id,
  });
  await ctx.db.patch(b._id, { transferSequence: sequence });
  return id;
}
export async function claimTransfer(
  ctx: MutationCtx,
  id: Id<"publisherTransfers">,
) {
  const t = await ctx.db.get(id);
  if (
    !t ||
    ["succeeded", "failed", "needs_review"].includes(t.dispatchState) ||
    (t.leaseUntil ?? 0) > Date.now()
  )
    return null;
  const immutable = {
    publisherOrganizationId: t.publisherOrganizationId,
    destination: t.destination,
    platformAccountId: t.platformAccountId,
    livemode: t.livemode,
    currency: t.currency,
    amountCents: t.amountCents,
    amountAtoms: t.amountAtoms,
    idempotencyKey: t.idempotencyKey,
    operationNonce: t.operationNonce,
  };
  if (
    t.amountAtoms !== money(t.amountCents * ACCOUNTING_ATOMS_PER_USD_CENT) ||
    (await fingerprint(immutable)) !== t.requestFingerprint
  )
    throw new ConvexError("Transfer request integrity failure");
  const balance = await publisherBalance(ctx, t.publisherOrganizationId);
  if (t.attempts === 0 && balance.availableAtoms < 0) {
    await appendPublisherEntry(ctx, {
      publisherOrganizationId: t.publisherOrganizationId,
      refId: `failure:${id}`,
      kind: "failure",
      availableDeltaAtoms: t.amountAtoms,
      allocatedDeltaAtoms: -t.amountAtoms,
      paidDeltaAtoms: 0,
      transferId: id,
    });
    await createNotification(ctx, {
      organizationId: t.publisherOrganizationId,
      kind: "transfer_failed",
      title: "Publisher transfer failed",
      body: "The provider rejected this transfer. Funds are available for a new transfer.",
      refId: `transfer-failed:${id}`,
    });
    await ctx.db.patch(id, {
      status: "failed",
      dispatchState: "failed",
      failureCode: "publisher_liability",
      nextAttemptAt: undefined,
      updatedAt: Date.now(),
    });
    return null;
  }
  const now = Date.now(),
    token = crypto.randomUUID();
  await ctx.db.patch(id, {
    status: "pending",
    dispatchState: "dispatching",
    attempts: add(t.attempts, 1),
    leaseToken: token,
    leaseUntil: now + LEASE_MS,
    firstAttemptAt: t.firstAttemptAt ?? now,
    safeRetryUntil: t.safeRetryUntil ?? now + SAFE_TRANSFER_REPLAY_MS,
    nextAttemptAt: now + LEASE_MS,
    updatedAt: now,
  });
  return (await ctx.db.get(id))!;
}
export type TransferFact = {
  id: string;
  amount: number;
  currency: string;
  destination: string;
  livemode: boolean;
  platformAccountId: string;
  nonce: string;
  fingerprint: string;
  reversedCents: number;
};
export async function projectTransfer(
  ctx: MutationCtx,
  id: Id<"publisherTransfers">,
  fact: TransferFact,
  token?: string,
) {
  const t = await ctx.db.get(id);
  if (!t || (token && t.leaseToken !== token))
    throw new ConvexError("Stale transfer worker");
  const owner = await ctx.db
    .query("publisherTransfers")
    .withIndex("by_stripe", (q) => q.eq("stripeTransferId", fact.id))
    .unique();
  if (
    (owner && owner._id !== id) ||
    fact.amount !== t.amountCents ||
    fact.currency !== t.currency ||
    fact.destination !== t.destination ||
    fact.livemode !== t.livemode ||
    fact.platformAccountId !== t.platformAccountId ||
    fact.nonce !== t.operationNonce ||
    fact.fingerprint !== t.requestFingerprint ||
    (t.stripeTransferId && t.stripeTransferId !== fact.id) ||
    money(fact.reversedCents) > t.amountCents
  )
    throw new ConvexError("Transfer evidence mismatch");
  if (t.status === "failed")
    throw new ConvexError("Failed transfer has external side effect");
  await appendPublisherEntry(ctx, {
    publisherOrganizationId: t.publisherOrganizationId,
    refId: `paid:${id}`,
    kind: "paid",
    availableDeltaAtoms: 0,
    allocatedDeltaAtoms: -t.amountAtoms,
    paidDeltaAtoms: t.amountAtoms,
    transferId: id,
  });
  const reversed = Math.max(t.reversedCents, fact.reversedCents),
    delta = (reversed - t.reversedCents) * ACCOUNTING_ATOMS_PER_USD_CENT;
  if (delta)
    await appendPublisherEntry(ctx, {
      publisherOrganizationId: t.publisherOrganizationId,
      refId: `transfer-reversal:${id}:${reversed}`,
      kind: "transfer_reversal",
      availableDeltaAtoms: delta,
      allocatedDeltaAtoms: 0,
      paidDeltaAtoms: -delta,
      transferId: id,
    });
  await createNotification(ctx, {
    organizationId: t.publisherOrganizationId,
    kind: "transfer_sent",
    title: "Publisher transfer recorded",
    body: "Your transfer was confirmed by the payment provider.",
    refId: `transfer-paid:${id}`,
  });
  await ctx.db.patch(id, {
    stripeTransferId: fact.id,
    reversedCents: reversed,
    status: reversed === t.amountCents ? "reversed" : "succeeded",
    dispatchState: "succeeded",
    leaseToken: undefined,
    leaseUntil: undefined,
    nextAttemptAt: undefined,
    updatedAt: Date.now(),
  });
}
export async function transferFailure(
  ctx: MutationCtx,
  id: Id<"publisherTransfers">,
  token: string,
  definitive: boolean,
) {
  const t = await ctx.db.get(id);
  if (!t || t.leaseToken !== token || t.dispatchState !== "dispatching")
    return false;
  if (definitive && !t.stripeTransferId) {
    await appendPublisherEntry(ctx, {
      publisherOrganizationId: t.publisherOrganizationId,
      refId: `failure:${id}`,
      kind: "failure",
      availableDeltaAtoms: t.amountAtoms,
      allocatedDeltaAtoms: -t.amountAtoms,
      paidDeltaAtoms: 0,
      transferId: id,
    });
    await createNotification(ctx, {
      organizationId: t.publisherOrganizationId,
      kind: "transfer_failed",
      title: "Publisher transfer failed",
      body: "The provider rejected this transfer. Funds are available for a new transfer.",
      refId: `transfer-failed:${id}`,
    });
    await ctx.db.patch(id, {
      status: "failed",
      dispatchState: "failed",
      failureCode: "provider_rejected",
      leaseToken: undefined,
      leaseUntil: undefined,
      nextAttemptAt: undefined,
      updatedAt: Date.now(),
    });
  } else
    await ctx.db.patch(id, {
      dispatchState: "reconciling",
      leaseToken: undefined,
      leaseUntil: undefined,
      nextAttemptAt: Date.now() + 60000,
      failureCode: "outcome_unknown",
      updatedAt: Date.now(),
    });
  return true;
}
export async function transferScan(
  ctx: MutationCtx,
  id: Id<"publisherTransfers">,
  token: string,
  cursor: string | undefined,
  candidates: string[],
  done: boolean,
) {
  const t = await ctx.db.get(id);
  if (!t || t.leaseToken !== token) return;
  const caseId = await openCase(ctx, {
    kind: "transfer",
    operationId: t.idempotencyKey,
    transferId: id,
    organizationId: t.publisherOrganizationId,
    reason: "Provider outcome requires reconciliation",
  });
  for (const candidate of candidates)
    await caseEvidence(ctx, caseId, "candidate", candidate);
  await ctx.db.patch(caseId, { providerCursor: cursor, updatedAt: Date.now() });
  await ctx.db.patch(id, {
    providerCursor: cursor,
    dispatchState: done ? "needs_review" : "reconciling",
    nextAttemptAt: done ? undefined : Date.now(),
    leaseToken: undefined,
    leaseUntil: undefined,
    updatedAt: Date.now(),
  });
}
