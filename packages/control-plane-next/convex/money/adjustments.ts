import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { add, money, getWallet } from "./walletLedger";
import { requestClose, requireDrained, finishClose } from "./barrier";
import { reverseSource, restoreSource } from "./sourceAdjustments";
import { reverseEarning, restoreEarning } from "./publisherLedger";
import { fingerprint } from "../../contracts/transport";
import { openCase } from "./reconciliationCases";
export const FINANCE_PAGE_SIZE = 8;
export type AdjustmentFact =
  | {
      kind: "refund";
      status:
        "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
      sourceRef: string;
      amountCents: number;
    }
  | {
      kind: "dispute";
      status: "open" | "won" | "lost";
      sourceRef: string;
      amountCents: number;
      movement?: "withdrawal" | "reinstatement";
      fundsWithdrawn?: boolean;
      fundsReinstated?: boolean;
    };
export function principalForCumulative(
  cents: number,
  payment: Pick<Doc<"payments">, "amountPaidCents" | "creditFaceValueCents">,
) {
  money(cents);
  if (cents > payment.amountPaidCents)
    throw new ConvexError("Refund exceeds payment");
  return Number(
    (BigInt(cents) * BigInt(payment.creditFaceValueCents)) /
      BigInt(payment.amountPaidCents),
  );
}
/** Canonical provider fetch is fenced by the revision read before network I/O. */
export async function projectAdjustment(
  ctx: MutationCtx,
  paymentId: Id<"payments">,
  expectedRevision: number,
  fact: AdjustmentFact,
) {
  const p = await ctx.db.get(paymentId);
  if (!p) throw new ConvexError("Payment not found");
  if (
    !fact.sourceRef ||
    fact.sourceRef.length > 200 ||
    !money(fact.amountCents) ||
    fact.amountCents > p.amountPaidCents
  )
    throw new ConvexError("Invalid adjustment amount");
  const old = await ctx.db
    .query("paymentAdjustments")
    .withIndex("by_source", (q) =>
      q.eq("kind", fact.kind).eq("providerSourceRef", fact.sourceRef),
    )
    .unique();
  if (
    old &&
    (old.paymentId !== paymentId ||
      (old.amountCents !== undefined && old.amountCents !== fact.amountCents))
  )
    throw new ConvexError("Adjustment identity conflict");
  const fundsWithdrawn =
    old?.fundsWithdrawn === true ||
    (fact.kind === "dispute" &&
      (fact.fundsWithdrawn === true || fact.movement === "withdrawal"));
  const fundsReinstated =
    old?.fundsReinstated === true ||
    (fact.kind === "dispute" &&
      (fact.fundsReinstated === true || fact.movement === "reinstatement"));
  if (
    old &&
    old.status === fact.status &&
    old.fundsWithdrawn === fundsWithdrawn &&
    old.fundsReinstated === fundsReinstated
  )
    return old._id;
  if (p.revision !== expectedRevision)
    throw new ConvexError("Payment changed; refetch provider facts");
  const active = (a: {
    kind: "refund" | "dispute";
    status: string;
    fundsWithdrawn: boolean;
    fundsReinstated: boolean;
  }) =>
    a.kind === "refund"
      ? !["failed", "canceled"].includes(a.status)
      : a.fundsWithdrawn && !a.fundsReinstated;
  // Source identity and amount are immutable. Only membership in the active set can change exposure.
  const exposureChanged =
    (old ? active(old) : false) !==
    active({ ...fact, fundsWithdrawn, fundsReinstated });
  const row = {
    paymentId,
    providerSourceRef: fact.sourceRef,
    amountCents: fact.amountCents,
    kind: fact.kind,
    status: fact.status,
    principalCents: old?.principalCents ?? 0,
    feeCents: old?.feeCents ?? 0,
    requestedCredits: old?.requestedCredits ?? 0,
    effectiveCredits: old?.effectiveCredits ?? 0,
    fundsWithdrawn,
    fundsReinstated,
    revision: add(old?.revision ?? 0, 1),
    observedRevision: p.revision,
    appliedWalletCredits: old?.appliedWalletCredits ?? 0,
    appliedPublisherCredits: old?.appliedPublisherCredits ?? 0,
    createdAt: old?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  // The discriminated input guarantees status belongs to kind; preserve that union in storage.
  const value = {
    ...row,
    ...(fact.kind === "refund"
      ? { kind: fact.kind, status: fact.status }
      : { kind: fact.kind, status: fact.status }),
  };
  const id = old ? old._id : await ctx.db.insert("paymentAdjustments", value);
  if (old) await ctx.db.patch(id, value);
  if (!exposureChanged) {
    await ctx.db.patch(paymentId, {
      revision: add(p.revision, 1),
      updatedAt: Date.now(),
    });
    return id;
  }
  const generation = add(p.reconciliation.generation, 1);
  const closeId =
    p.reconciliation.state !== "complete" && p.reconciliation.closeId
      ? p.reconciliation.closeId
      : `payment:${paymentId}:${generation}`;
  await ctx.db.patch(paymentId, {
    revision: add(p.revision, 1),
    updatedAt: Date.now(),
    reconciliation: {
      state: "pending",
      attempts: 0,
      generation,
      closeId,
      phase: "restore_publisher",
      targetCredits: 0,
      walletReversedCredits: 0,
      publisherTargetCredits: 0,
      nextAttemptAt: Date.now(),
    },
  });
  const wallet = await getWallet(ctx, p.walletId);
  if (
    wallet.gateState === "open" ||
    wallet.gateState === "closed" ||
    wallet.close?.id === closeId
  )
    await requestClose(ctx, p.walletId, closeId, "refund");
  return id;
}
/** Each call commits at most eight source/journal rows with its cursor. No whole-payment scans. */
export async function reconcilePaymentPage(
  ctx: MutationCtx,
  paymentId: Id<"payments">,
  generation: number,
) {
  const p = await ctx.db.get(paymentId);
  if (
    !p ||
    p.reconciliation.generation !== generation ||
    p.reconciliation.state === "complete" ||
    p.reconciliation.state === "needs_review"
  )
    return "done";
  let job = p.reconciliation;
  const closeId = job.closeId!;
  let wallet = await getWallet(ctx, p.walletId);
  if (
    wallet.close?.id !== closeId &&
    wallet.gateState !== "open" &&
    wallet.gateState !== "closed"
  ) {
    await ctx.db.patch(paymentId, {
      reconciliation: {
        ...job,
        state: "retry",
        nextAttemptAt: Date.now() + 60_000,
      },
    });
    return "waiting";
  }
  wallet = await requestClose(ctx, p.walletId, closeId, "refund");
  if (wallet.close?.ackAt === undefined) {
    await ctx.db.patch(paymentId, {
      reconciliation: {
        ...job,
        state: "retry",
        nextAttemptAt: Date.now() + 60_000,
      },
    });
    return "waiting";
  }
  await requireDrained(ctx, p.walletId, closeId);
  const advance = async (patch: Partial<typeof job>) => {
    job = {
      ...job,
      ...patch,
      state: "processing",
      nextAttemptAt: Date.now() + 300_000,
    };
    await ctx.db.patch(paymentId, {
      reconciliation: job,
      updatedAt: Date.now(),
    });
    return "more";
  };
  const phase = job.phase ?? "restore_publisher";
  if (phase === "unlock") {
    const page = await ctx.db
      .query("financeReconciliationCases")
      .withIndex("by_payment", (q) =>
        q.eq("rowKind", "case").eq("paymentId", paymentId),
      )
      .paginate({ numItems: FINANCE_PAGE_SIZE, cursor: job.cursor ?? null });
    for (const row of page.page)
      if (
        row.rowKind === "case" &&
        (row.kind === "publisher_hold" || row.kind === "payment")
      )
        await ctx.db.patch(row._id, {
          status: "resolved",
          updatedAt: Date.now(),
        });
    if (!page.isDone) return advance({ cursor: page.continueCursor });
    await ctx.db.patch(paymentId, {
      reconciliation: { ...job, state: "complete", nextAttemptAt: undefined },
    });
    await finishClose(ctx, p.walletId, closeId);
    return "done";
  }
  if (phase === "restore_publisher") {
    const rows = await ctx.db
      .query("publisherLedgerEntries")
      .withIndex("by_unrestored", (q) =>
        q
          .eq("paymentId", paymentId)
          .eq("kind", "reversal")
          .eq("restoredAt", undefined),
      )
      .take(FINANCE_PAGE_SIZE);
    for (const entry of rows) await restoreEarning(ctx, entry);
    return advance({
      phase: rows.length < FINANCE_PAGE_SIZE ? "restore_wallet" : phase,
    });
  }
  if (phase === "restore_wallet") {
    const rows = await ctx.db
      .query("walletEntries")
      .withIndex("by_unrestored", (q) =>
        q
          .eq("paymentId", paymentId)
          .eq("kind", "reversal")
          .eq("restoredAt", undefined),
      )
      .take(FINANCE_PAGE_SIZE);
    for (const entry of rows) {
      if (entry.kind !== "reversal" || entry.adjustment.kind !== "payment")
        throw new ConvexError("Invalid payment reversal");
      // A later generation may restore an earlier journal, but only under its own drained close.
      await ctx.db.patch(entry.adjustment.id, {
        closeId,
        closeGeneration: generation,
      });
      await restoreSource(ctx, entry, `restore:${entry.refId}`, closeId);
    }
    return advance({
      phase: rows.length < FINANCE_PAGE_SIZE ? "targets" : phase,
    });
  }
  if (phase === "targets") {
    const page = await ctx.db
      .query("paymentAdjustments")
      .withIndex("by_payment", (q) => q.eq("paymentId", paymentId))
      .paginate({ numItems: 1, cursor: job.cursor ?? null });
    const a = page.page[0];
    if (!a) {
      await ctx.db.patch(paymentId, {
        effectiveReversedCredits: job.targetCredits,
        refundedCredits: (job.allocatedPrincipalCents ?? 0) * 100,
        disputedCredits: job.disputedCredits ?? 0,
        status:
          (job.disputedCredits ?? 0) > 0
            ? "disputed"
            : job.targetCredits === p.credits
              ? "refunded"
              : job.targetCredits
                ? "partially_refunded"
                : "paid",
        updatedAt: Date.now(),
      });
      return advance({ phase: "unlock", cursor: undefined });
    }
    let principal = 0,
      fee = 0,
      refunded = job.refundedCents ?? 0,
      allocated = job.allocatedPrincipalCents ?? 0;
    const active =
      a.kind === "refund"
        ? !["failed", "canceled"].includes(a.status)
        : a.fundsWithdrawn && !a.fundsReinstated;
    if (active) {
      const cents = money(a.amountCents ?? a.principalCents + a.feeCents);
      if (a.kind === "refund") {
        refunded = add(refunded, cents);
        if (refunded > p.amountPaidCents)
          throw new ConvexError("Refunds exceed paid amount");
        const cumulative = principalForCumulative(refunded, p);
        principal = cumulative - allocated;
        allocated = cumulative;
      } else principal = principalForCumulative(cents, p);
      fee = cents - principal;
    }
    const requested = money(principal * 100),
      effective = Math.min(requested, p.credits - job.targetCredits);
    await ctx.db.patch(a._id, {
      principalCents: principal,
      feeCents: fee,
      requestedCredits: requested,
      effectiveCredits: effective,
      appliedWalletCredits: 0,
      appliedPublisherCredits: 0,
      closeId,
      closeGeneration: generation,
      updatedAt: Date.now(),
    });
    return advance({
      phase: effective ? "wallet" : "targets",
      cursor: page.continueCursor,
      adjustmentId: a._id,
      sourceCursor: undefined,
      earningsState: "pending",
      remainingCredits: effective,
      targetCredits: add(job.targetCredits, effective),
      refundedCents: refunded,
      allocatedPrincipalCents: allocated,
      disputedCredits: add(
        job.disputedCredits ?? 0,
        a.kind === "dispute" ? effective : 0,
      ),
    });
  }
  const a = await ctx.db.get(job.adjustmentId!);
  if (!a || a.closeGeneration !== generation)
    throw new ConvexError("Adjustment generation conflict");
  let remaining = job.remainingCredits ?? 0;
  if (phase === "wallet") {
    const page = await ctx.db
      .query("fundingLotSources")
      .withIndex("by_payment", (q) => q.eq("paymentId", paymentId))
      .paginate({
        numItems: FINANCE_PAGE_SIZE,
        cursor: job.sourceCursor ?? null,
      });
    let applied = 0;
    for (const s of page.page) {
      const credits = Math.min(remaining, s.remainingCredits);
      if (!credits) continue;
      const refId = `payment:${paymentId}:${generation}:${a._id}:${s._id}`;
      await reverseSource(ctx, {
        walletId: p.walletId,
        closeId,
        refId,
        slice: {
          lotId: s.lotId,
          originLotId: s.originLotId,
          sourceRef: s.sourceRef,
          paymentId,
          credits,
        },
        adjustment: { kind: "payment", id: a._id },
        requestFingerprint: await fingerprint({
          generation,
          adjustmentId: a._id,
          effective: a.effectiveCredits,
        }),
      });
      remaining -= credits;
      applied += credits;
    }
    await ctx.db.patch(a._id, {
      appliedWalletCredits: add(a.appliedWalletCredits, applied),
    });
    return advance({
      remainingCredits: remaining,
      walletReversedCredits: add(job.walletReversedCredits, applied),
      phase: remaining === 0 ? "targets" : page.isDone ? "earnings" : "wallet",
      sourceCursor:
        remaining === 0 || page.isDone ? undefined : page.continueCursor,
    });
  }
  const earningsState = job.earningsState ?? "pending";
  const page = await ctx.db
    .query("publisherEarnings")
    .withIndex("by_payment_state_day", (q) =>
      q.eq("paymentId", paymentId).eq("state", earningsState),
    )
    .order("desc")
    .paginate({
      numItems: FINANCE_PAGE_SIZE,
      cursor: job.sourceCursor ?? null,
    });
  let applied = 0;
  for (const e of page.page) {
    const credits = Math.min(
      remaining,
      e.grossCredits - e.clawedBackGrossCredits,
    );
    if (!credits) continue;
    await reverseEarning(
      ctx,
      e,
      credits,
      a._id,
      `payment:${paymentId}:${generation}:${a._id}:${e._id}`,
    );
    remaining -= credits;
    applied += credits;
  }
  await ctx.db.patch(a._id, {
    appliedPublisherCredits: add(a.appliedPublisherCredits, applied),
  });
  if (page.isDone && remaining && earningsState === "released") {
    await openCase(
      ctx,
      {
        kind: "payment",
        paymentId,
        operationId: `${closeId}:${a._id}`,
        reason: "Original source exposure exceeds recoverable inventory",
      },
      a.providerSourceRef,
    );
    await ctx.db.patch(paymentId, {
      reconciliation: {
        ...job,
        state: "needs_review",
        publisherTargetCredits: add(job.publisherTargetCredits, applied),
        remainingCredits: remaining,
        nextAttemptAt: undefined,
      },
    });
    return "done";
  }
  return advance({
    remainingCredits: remaining,
    publisherTargetCredits: add(job.publisherTargetCredits, applied),
    phase: remaining === 0 ? "targets" : "earnings",
    earningsState: page.isDone ? "released" : earningsState,
    sourceCursor:
      remaining === 0 || page.isDone ? undefined : page.continueCursor,
  });
}
