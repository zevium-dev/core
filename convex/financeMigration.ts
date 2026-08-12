import { signTransferCorrelation } from "@zevium/shared";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import {
  ACCOUNTING_ATOMS_PER_USD_CENT,
  PUBLISHER_RISK_HOLD_MS,
  publisherEarningSplit,
} from "./accounting";
import {
  commitFundingAllocation,
  commitPaymentReversal,
  getFundingState,
  preflightFundingAllocation,
  preflightPaymentReversal,
} from "./lib/funding";
import { requireAdmin } from "./lib/auth";
import { getOrCreatePublisherBalance } from "./lib/publisherLedger";

const MIGRATION_KEY = "finance-v2-universal-funding";
const MIGRATION_BATCH = 25;

async function audit(
  ctx: MutationCtx,
  jobId: Id<"financialMigrationJobs">,
  phase: string,
  scopeRef: string,
  result: "checkpoint" | "verified",
  facts: Record<string, unknown>,
): Promise<void> {
  await ctx.db.insert("financialMigrationAudits", {
    migrationJobId: jobId,
    phase,
    scopeRef,
    result,
    facts: JSON.stringify(facts),
    createdAt: Date.now(),
  });
}

async function scheduleNext(
  ctx: MutationCtx,
  jobId: Id<"financialMigrationJobs">,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.financeMigration.runChunk, {
    jobId,
  });
}

async function ensureMigrationFundingState(
  ctx: MutationCtx,
  wallet: Doc<"wallets">,
): Promise<Doc<"walletFundingStates">> {
  const existing = await getFundingState(ctx, wallet._id);
  if (existing !== null) return existing;
  const id = await ctx.db.insert("walletFundingStates", {
    walletId: wallet._id,
    organizationId: wallet.organizationId,
    nonrefundableAvailableCredits: 0,
    refundableAvailableCredits: 0,
    allocatedCredits: 0,
    reversedCredits: 0,
    sequence: 0,
    updatedAt: Date.now(),
  });
  const state = await ctx.db.get(id);
  if (state === null)
    throw new Error("Migration funding state creation failed");
  return state;
}

async function migratePositiveEntry(
  ctx: MutationCtx,
  wallet: Doc<"wallets">,
  entry: Doc<"walletEntries">,
): Promise<boolean> {
  const existing = await ctx.db
    .query("walletFundingLots")
    .withIndex("by_source_ref", (q) => q.eq("sourceRef", entry.refId))
    .unique();
  if (existing !== null) return false;
  const state = await ensureMigrationFundingState(ctx, wallet);
  const sourceKind =
    entry.kind === "payment_grant"
      ? ("stripe_payment" as const)
      : entry.kind === "dispute_restoration"
        ? ("restoration" as const)
        : entry.refId.startsWith("promo:")
          ? ("promotion" as const)
          : ("admin_adjustment" as const);
  const refundable =
    sourceKind === "stripe_payment" || sourceKind === "restoration";
  await ctx.db.insert("walletFundingLots", {
    walletId: wallet._id,
    organizationId: wallet.organizationId,
    sourceKind,
    sourceRef: entry.refId,
    paymentId: entry.paymentId,
    refundable,
    grantedCredits: entry.amount,
    availableCredits: entry.amount,
    allocatedCredits: 0,
    reversedCredits: 0,
    state: "available",
    createdAt: entry.createdAt,
    updatedAt: entry.createdAt,
  });
  await ctx.db.patch(state._id, {
    nonrefundableAvailableCredits:
      state.nonrefundableAvailableCredits + (refundable ? 0 : entry.amount),
    refundableAvailableCredits:
      state.refundableAvailableCredits + (refundable ? entry.amount : 0),
    reversedCredits:
      sourceKind === "restoration"
        ? Math.max(0, state.reversedCredits - entry.amount)
        : state.reversedCredits,
    sequence: state.sequence + 1,
    updatedAt: entry.createdAt,
  });
  return true;
}

async function earningForUsage(
  ctx: MutationCtx,
  usage: Doc<"usageEvents">,
  settleRefId: string,
): Promise<Doc<"publisherEarnings">> {
  const existing = await ctx.db
    .query("publisherEarnings")
    .withIndex("by_settlement", (q) =>
      q.eq("usageSettlementRefId", settleRefId),
    )
    .unique();
  if (existing !== null) return existing;
  const project = await ctx.db.get(usage.projectId);
  if (project === null) throw new Error("Migration usage project is missing");
  const split = publisherEarningSplit(usage.credits);
  const id = await ctx.db.insert("publisherEarnings", {
    publisherOrganizationId: project.organizationId,
    consumerOrganizationId: usage.organizationId,
    projectId: project._id,
    usageSettlementRefId: settleRefId,
    grossCredits: split.grossCredits,
    platformFeeAtoms: split.platformFeeAtoms,
    publisherNetAtoms: split.publisherNetAtoms,
    platformFeeCredits: split.platformFeeCredits,
    netCredits: split.publisherNetCredits,
    clawedBackGrossCredits: 0,
    clawedBackAtoms: 0,
    releasedAtoms: 0,
    availableAt: usage.at + PUBLISHER_RISK_HOLD_MS,
    status: "pending_risk",
    createdAt: usage.at,
    updatedAt: Date.now(),
  });
  const earning = await ctx.db.get(id);
  if (earning === null) throw new Error("Migration earning creation failed");
  return earning;
}

async function migrateDebitEntry(
  ctx: MutationCtx,
  wallet: Doc<"wallets">,
  entry: Doc<"walletEntries">,
): Promise<boolean> {
  if (entry.kind === "refund_reversal" || entry.kind === "dispute_reversal") {
    if (entry.paymentId === undefined) {
      throw new Error("Payment reversal entry has no payment provenance");
    }
    const existing = await ctx.db
      .query("walletFundingReversals")
      .withIndex("by_wallet_entry", (q) => q.eq("walletEntryId", entry._id))
      .unique();
    if (existing !== null) return false;
    const plan = await preflightPaymentReversal(ctx, {
      wallet,
      paymentId: entry.paymentId,
      requestedCredits: -entry.amount,
    });
    await commitPaymentReversal(ctx, plan, entry.createdAt);
    await ctx.db.insert("walletFundingReversals", {
      walletId: wallet._id,
      organizationId: wallet.organizationId,
      walletEntryId: entry._id,
      paymentId: entry.paymentId,
      grossCredits: plan.walletCredits,
      createdAt: entry.createdAt,
    });
    const payment = await ctx.db.get(entry.paymentId);
    if (payment === null) throw new Error("Migration payment is missing");
    const reversalRows = await ctx.db
      .query("walletFundingReversals")
      .withIndex("by_payment_created", (q) => q.eq("paymentId", payment._id))
      .take(101);
    if (reversalRows.length > 100) {
      throw new Error("Migration payment exceeds 100 reversal sources");
    }
    const walletReversedCredits = reversalRows.reduce(
      (sum, row) => sum + row.grossCredits,
      0,
    );
    if (walletReversedCredits > payment.reversedCredits) {
      throw new Error("Migration payment wallet reversal exceeds exposure");
    }
    await ctx.db.patch(payment._id, {
      walletReversedCredits,
      publisherClawbackTargetCredits:
        payment.reversedCredits - walletReversedCredits,
    });
    return plan.walletCredits > 0;
  }

  const existing = await ctx.db
    .query("walletFundingAllocations")
    .withIndex("by_wallet_entry", (q) => q.eq("walletEntryId", entry._id))
    .first();
  if (existing !== null) return false;
  const plan = await preflightFundingAllocation(ctx, {
    wallet,
    credits: -entry.amount,
    allowReservationDebt: entry.kind === "usage_settlement",
  });
  if (entry.kind === "usage_settlement") {
    if (entry.usageEventId === undefined) {
      throw new Error("Usage settlement entry has no usage linkage");
    }
    const usage = await ctx.db.get(entry.usageEventId);
    if (usage === null) throw new Error("Migration usage event is missing");
    const earning = await earningForUsage(ctx, usage, entry.refId);
    await getOrCreatePublisherBalance(ctx, earning.publisherOrganizationId);
    await commitFundingAllocation(ctx, {
      plan,
      walletEntryId: entry._id,
      walletId: wallet._id,
      organizationId: wallet.organizationId,
      kind: "usage",
      usageEventId: usage._id,
      earningId: earning._id,
      publisherOrganizationId: earning.publisherOrganizationId,
      createdAt: entry.createdAt,
    });
  } else {
    await commitFundingAllocation(ctx, {
      plan,
      walletEntryId: entry._id,
      walletId: wallet._id,
      organizationId: wallet.organizationId,
      kind: "negative_adjustment",
      createdAt: entry.createdAt,
    });
  }
  return true;
}

async function runWalletChunk(
  ctx: MutationCtx,
  job: Doc<"financialMigrationJobs">,
): Promise<void> {
  if (job.activeWalletId === undefined) {
    const page = await ctx.db
      .query("wallets")
      .order("asc")
      .paginate({
        cursor: job.tableCursor ?? null,
        numItems: 1,
        maximumRowsRead: 2,
      });
    const wallet = page.page[0];
    if (wallet === undefined) {
      await ctx.db.patch(job._id, {
        phase: "clawbacks",
        tableCursor: undefined,
        detailCursor: undefined,
        subphase: "entries",
        activeSequence: 0,
        accumulatorA: 0,
        accumulatorB: 0,
        accumulatorC: 0,
        accumulatorD: 0,
        accumulatorE: 0,
        accumulatorF: 0,
        updatedAt: Date.now(),
      });
      await scheduleNext(ctx, job._id);
      return;
    }
    await ensureMigrationFundingState(ctx, wallet);
    await ctx.db.patch(job._id, {
      activeWalletId: wallet._id,
      activeSequence: 0,
      tableCursor: page.continueCursor,
      chunks: job.chunks + 1,
      updatedAt: Date.now(),
    });
    await scheduleNext(ctx, job._id);
    return;
  }

  const wallet = await ctx.db.get(job.activeWalletId);
  if (wallet === null) throw new Error("Migration wallet disappeared");
  const entries = await ctx.db
    .query("walletEntries")
    .withIndex("by_wallet_sequence", (q) =>
      q.eq("walletId", wallet._id).gt("sequence", job.activeSequence ?? 0),
    )
    .order("asc")
    .take(MIGRATION_BATCH);
  let written = 0;
  for (const entry of entries) {
    if (entry.amount > 0) {
      if (await migratePositiveEntry(ctx, wallet, entry)) written += 1;
    } else if (entry.amount < 0) {
      if (await migrateDebitEntry(ctx, wallet, entry)) written += 1;
    }
  }
  if (entries.length === MIGRATION_BATCH) {
    await ctx.db.patch(job._id, {
      activeSequence: entries.at(-1)!.sequence,
      rowsRead: job.rowsRead + entries.length,
      rowsWritten: job.rowsWritten + written,
      chunks: job.chunks + 1,
      updatedAt: Date.now(),
    });
    await scheduleNext(ctx, job._id);
    return;
  }
  const state = await getFundingState(ctx, wallet._id);
  if (state === null)
    throw new Error("Migrated wallet funding state is missing");
  const available =
    state.nonrefundableAvailableCredits + state.refundableAvailableCredits;
  const expectedAvailable = Math.max(0, wallet.balance);
  if (available !== expectedAvailable) {
    throw new Error(
      `Wallet conservation failed: available=${available} balance=${wallet.balance}`,
    );
  }
  await ctx.db.patch(wallet._id, { debtCredits: Math.max(0, -wallet.balance) });
  await audit(ctx, job._id, "wallets", wallet._id, "verified", {
    balance: wallet.balance,
    available,
    debtCredits: Math.max(0, -wallet.balance),
    allocatedCredits: state.allocatedCredits,
    reversedCredits: state.reversedCredits,
    lastSequence: entries.at(-1)?.sequence ?? job.activeSequence ?? 0,
  });
  await ctx.db.patch(job._id, {
    activeWalletId: undefined,
    activeSequence: 0,
    rowsRead: job.rowsRead + entries.length,
    rowsWritten: job.rowsWritten + written + 1,
    chunks: job.chunks + 1,
    updatedAt: Date.now(),
  });
  await scheduleNext(ctx, job._id);
}

async function legacyWalletCreditsForSource(
  ctx: MutationCtx,
  paymentId: Id<"payments">,
  sourceRef: string,
): Promise<number> {
  const reversals = await ctx.db
    .query("walletFundingReversals")
    .withIndex("by_payment_created", (q) => q.eq("paymentId", paymentId))
    .take(101);
  if (reversals.length > 100) {
    throw new Error("Migration payment exceeds 100 reversal sources");
  }
  let credits = 0;
  for (const reversal of reversals) {
    const entry = await ctx.db.get(reversal.walletEntryId);
    if (entry !== null && entry.refId.startsWith(sourceRef)) {
      credits += reversal.grossCredits;
    }
  }
  return credits;
}

async function runClawbackChunk(
  ctx: MutationCtx,
  job: Doc<"financialMigrationJobs">,
): Promise<void> {
  const page = await ctx.db
    .query("publisherClawbacks")
    .order("asc")
    .paginate({
      cursor: job.tableCursor ?? null,
      numItems: MIGRATION_BATCH,
      maximumRowsRead: MIGRATION_BATCH * 2,
    });
  let written = 0;
  for (const row of page.page) {
    const restoredGrossCredits = row.restoredGrossCredits ?? 0;
    const restoredAtoms = row.restoredAtoms ?? 0;
    const activeGrossCredits = row.grossCredits - restoredGrossCredits;
    if (
      restoredGrossCredits < 0 ||
      activeGrossCredits < 0 ||
      restoredAtoms < 0 ||
      restoredAtoms > row.amountAtoms
    ) {
      throw new Error("Legacy publisher clawback conservation failed");
    }
    let allocationId = row.allocationId;
    if (allocationId === undefined && activeGrossCredits > 0) {
      const candidates = await ctx.db
        .query("walletFundingAllocations")
        .withIndex("by_earning", (q) => q.eq("earningId", row.earningId))
        .take(17);
      if (candidates.length > 16) {
        throw new Error(
          "Legacy clawback exceeds bounded earning allocation fan-out",
        );
      }
      const allocation = candidates.find(
        (candidate) =>
          candidate.paymentId === row.paymentId &&
          candidate.grossCredits - candidate.clawedBackGrossCredits >=
            activeGrossCredits,
      );
      if (allocation === undefined) {
        throw new Error("Legacy clawback has no matching funding allocation");
      }
      allocationId = allocation._id;
      await ctx.db.patch(allocation._id, {
        clawedBackGrossCredits:
          allocation.clawedBackGrossCredits + activeGrossCredits,
      });
      if (allocation.fundingLotId === undefined) {
        throw new Error("Legacy clawback allocation has no funding lot");
      }
      const earning = await ctx.db.get(row.earningId);
      if (earning === null)
        throw new Error("Legacy clawback earning is missing");
      const rollup = await ctx.db
        .query("fundingAllocationRollups")
        .withIndex("by_lot_publisher", (q) =>
          q
            .eq("fundingLotId", allocation.fundingLotId!)
            .eq("publisherOrganizationId", earning.publisherOrganizationId),
        )
        .unique();
      if (rollup === null) throw new Error("Legacy funding rollup is missing");
      await ctx.db.patch(rollup._id, {
        clawedBackGrossCredits:
          rollup.clawedBackGrossCredits + activeGrossCredits,
        updatedAt: Date.now(),
      });
    }
    await ctx.db.patch(row._id, {
      allocationId,
      restoredGrossCredits,
      restoredAtoms,
      state: activeGrossCredits === 0 ? "restored" : "active",
      updatedAt: Date.now(),
    });

    const payment = await ctx.db.get(row.paymentId);
    if (payment === null) throw new Error("Legacy clawback payment is missing");
    const existingExposure = await ctx.db
      .query("paymentExposures")
      .withIndex("by_source", (q) => q.eq("sourceRef", row.sourceRef))
      .unique();
    if (existingExposure === null) {
      const walletCredits = await legacyWalletCreditsForSource(
        ctx,
        row.paymentId,
        row.sourceRef,
      );
      const disputeId = row.sourceRef.startsWith("stripe:dispute:")
        ? row.sourceRef.slice("stripe:dispute:".length)
        : null;
      const dispute =
        disputeId === null
          ? null
          : await ctx.db
              .query("paymentDisputes")
              .withIndex("by_stripe_dispute", (q) =>
                q.eq("stripeDisputeId", disputeId),
              )
              .unique();
      const active =
        row.sourceKind === "refund" ||
        (dispute?.fundsWithdrawn === true && dispute.fundsReinstated === false);
      const effectiveCredits = active ? walletCredits + activeGrossCredits : 0;
      await ctx.db.insert("paymentExposures", {
        paymentId: row.paymentId,
        organizationId: row.consumerOrganizationId,
        sourceKind: row.sourceKind,
        sourceRef: row.sourceRef,
        sourceAmount: dispute?.amount ?? payment.refundedAmount,
        sourceAmountExact: dispute !== null,
        migrationBackfilled: true,
        requestedCredits: effectiveCredits,
        effectiveCredits,
        walletCredits: active ? walletCredits : 0,
        publisherCredits: active ? activeGrossCredits : 0,
        appliedPublisherCredits: active ? activeGrossCredits : 0,
        active,
        createdAt: row.createdAt,
        updatedAt: Date.now(),
      });
    } else if (existingExposure.migrationBackfilled === true) {
      await ctx.db.patch(existingExposure._id, {
        requestedCredits:
          existingExposure.requestedCredits + activeGrossCredits,
        effectiveCredits:
          existingExposure.effectiveCredits + activeGrossCredits,
        publisherCredits:
          existingExposure.publisherCredits + activeGrossCredits,
        appliedPublisherCredits:
          existingExposure.appliedPublisherCredits + activeGrossCredits,
        updatedAt: Date.now(),
      });
    }
    written += 1;
  }
  if (!page.isDone) {
    await ctx.db.patch(job._id, {
      tableCursor: page.continueCursor,
      rowsRead: job.rowsRead + page.page.length,
      rowsWritten: job.rowsWritten + written,
      chunks: job.chunks + 1,
      updatedAt: Date.now(),
    });
    await scheduleNext(ctx, job._id);
    return;
  }
  await audit(ctx, job._id, "clawbacks", "all", "verified", {
    rows: job.rowsRead + page.page.length,
    rule: "active gross equals immutable gross minus restored gross",
  });
  await ctx.db.patch(job._id, {
    phase: "publishers",
    tableCursor: undefined,
    rowsRead: job.rowsRead + page.page.length,
    rowsWritten: job.rowsWritten + written,
    chunks: job.chunks + 1,
    updatedAt: Date.now(),
  });
  await scheduleNext(ctx, job._id);
}

async function runPublisherChunk(
  ctx: MutationCtx,
  job: Doc<"financialMigrationJobs">,
): Promise<void> {
  if (job.activePublisherOrganizationId === undefined) {
    const page = await ctx.db
      .query("publisherBalances")
      .order("asc")
      .paginate({
        cursor: job.tableCursor ?? null,
        numItems: 1,
        maximumRowsRead: 2,
      });
    const balance = page.page[0];
    if (balance === undefined) {
      await ctx.db.patch(job._id, {
        phase: "transfers",
        tableCursor: undefined,
        detailCursor: undefined,
        subphase: "entries",
        activeSequence: 0,
        accumulatorA: 0,
        accumulatorB: 0,
        accumulatorC: 0,
        accumulatorD: 0,
        accumulatorE: 0,
        accumulatorF: 0,
        updatedAt: Date.now(),
      });
      await scheduleNext(ctx, job._id);
      return;
    }
    await ctx.db.patch(job._id, {
      activePublisherOrganizationId: balance.publisherOrganizationId,
      tableCursor: page.continueCursor,
      detailCursor: undefined,
      subphase: "entries",
      activeSequence: 0,
      accumulatorA: 0,
      accumulatorB: 0,
      accumulatorC: 0,
      accumulatorD: 0,
      accumulatorE: 0,
      accumulatorF: 0,
      chunks: job.chunks + 1,
      updatedAt: Date.now(),
    });
    await scheduleNext(ctx, job._id);
    return;
  }
  const orgId = job.activePublisherOrganizationId;
  const balance = await ctx.db
    .query("publisherBalances")
    .withIndex("by_publisher", (q) => q.eq("publisherOrganizationId", orgId))
    .unique();
  if (balance === null)
    throw new Error("Migration publisher balance disappeared");

  if ((job.subphase ?? "entries") === "entries") {
    const entries = await ctx.db
      .query("publisherSettlementEntries")
      .withIndex("by_publisher", (q) =>
        q
          .eq("publisherOrganizationId", orgId)
          .gt("sequence", job.activeSequence ?? 0),
      )
      .order("asc")
      .take(MIGRATION_BATCH);
    const available =
      job.accumulatorA +
      entries.reduce((sum, row) => sum + row.availableDeltaAtoms, 0);
    const allocated =
      job.accumulatorB +
      entries.reduce((sum, row) => sum + row.allocatedDeltaAtoms, 0);
    const paid =
      job.accumulatorC +
      entries.reduce((sum, row) => sum + row.paidDeltaAtoms, 0);
    await ctx.db.patch(job._id, {
      accumulatorA: available,
      accumulatorB: allocated,
      accumulatorC: paid,
      activeSequence: entries.at(-1)?.sequence ?? job.activeSequence ?? 0,
      subphase: entries.length === MIGRATION_BATCH ? "entries" : "earnings",
      detailCursor:
        entries.length === MIGRATION_BATCH ? job.detailCursor : undefined,
      rowsRead: job.rowsRead + entries.length,
      chunks: job.chunks + 1,
      updatedAt: Date.now(),
    });
    await scheduleNext(ctx, job._id);
    return;
  }

  if (job.subphase === "earnings") {
    const page = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_publisher", (q) => q.eq("publisherOrganizationId", orgId))
      .order("asc")
      .paginate({
        cursor: job.detailCursor ?? null,
        numItems: MIGRATION_BATCH,
        maximumRowsRead: MIGRATION_BATCH * 2,
      });
    let pending = job.accumulatorD ?? 0;
    let reversed = job.accumulatorE ?? 0;
    for (const earning of page.page) {
      if (earning.status === "pending_risk") {
        pending += earning.publisherNetAtoms - earning.clawedBackAtoms;
      }
      reversed += earning.clawedBackAtoms;
    }
    await ctx.db.patch(job._id, {
      accumulatorD: pending,
      accumulatorE: reversed,
      detailCursor: page.isDone ? undefined : page.continueCursor,
      subphase: page.isDone ? "publisher_transfers" : "earnings",
      rowsRead: job.rowsRead + page.page.length,
      chunks: job.chunks + 1,
      updatedAt: Date.now(),
    });
    await scheduleNext(ctx, job._id);
    return;
  }

  const page = await ctx.db
    .query("publisherTransfers")
    .withIndex("by_publisher", (q) => q.eq("publisherOrganizationId", orgId))
    .order("asc")
    .paginate({
      cursor: job.detailCursor ?? null,
      numItems: MIGRATION_BATCH,
      maximumRowsRead: MIGRATION_BATCH * 2,
    });
  let failed = job.accumulatorF ?? 0;
  for (const transfer of page.page) {
    if (transfer.status === "failed") failed += transfer.amountAtoms;
  }
  if (!page.isDone) {
    await ctx.db.patch(job._id, {
      accumulatorF: failed,
      detailCursor: page.continueCursor,
      rowsRead: job.rowsRead + page.page.length,
      chunks: job.chunks + 1,
      updatedAt: Date.now(),
    });
    await scheduleNext(ctx, job._id);
    return;
  }
  await ctx.db.patch(balance._id, {
    availableAtoms: job.accumulatorA,
    allocatedAtoms: job.accumulatorB,
    paidAtoms: job.accumulatorC,
    pendingRiskAtoms: job.accumulatorD ?? 0,
    reversedAtoms: job.accumulatorE ?? 0,
    failedAtoms: failed,
    sequence: job.activeSequence ?? 0,
    updatedAt: Date.now(),
  });
  await audit(ctx, job._id, "publishers", orgId, "verified", {
    availableAtoms: job.accumulatorA,
    allocatedAtoms: job.accumulatorB,
    paidAtoms: job.accumulatorC,
    pendingRiskAtoms: job.accumulatorD ?? 0,
    reversedAtoms: job.accumulatorE ?? 0,
    failedAtoms: failed,
    ledgerSequence: job.activeSequence ?? 0,
  });
  await ctx.db.patch(job._id, {
    activePublisherOrganizationId: undefined,
    detailCursor: undefined,
    subphase: "entries",
    activeSequence: 0,
    accumulatorA: 0,
    accumulatorB: 0,
    accumulatorC: 0,
    accumulatorD: 0,
    accumulatorE: 0,
    accumulatorF: 0,
    rowsRead: job.rowsRead + page.page.length,
    rowsWritten: job.rowsWritten + 1,
    chunks: job.chunks + 1,
    updatedAt: Date.now(),
  });
  await scheduleNext(ctx, job._id);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function runTransferChunk(
  ctx: MutationCtx,
  job: Doc<"financialMigrationJobs">,
): Promise<void> {
  if (job.activeTransferId === undefined) {
    const page = await ctx.db
      .query("publisherTransfers")
      .order("asc")
      .paginate({
        cursor: job.tableCursor ?? null,
        numItems: 1,
        maximumRowsRead: 2,
      });
    const transfer = page.page[0];
    if (transfer === undefined) {
      await ctx.db.patch(job._id, {
        phase: "conservation",
        tableCursor: undefined,
        activeSequence: 0,
        accumulatorA: 0,
        updatedAt: Date.now(),
      });
      await scheduleNext(ctx, job._id);
      return;
    }
    await ctx.db.patch(job._id, {
      activeTransferId: transfer._id,
      tableCursor: page.continueCursor,
      activeSequence: 0,
      accumulatorA: 0,
      chunks: job.chunks + 1,
      updatedAt: Date.now(),
    });
    await scheduleNext(ctx, job._id);
    return;
  }
  const transfer = await ctx.db.get(job.activeTransferId);
  if (transfer === null) throw new Error("Migration transfer disappeared");
  const entries = await ctx.db
    .query("publisherSettlementEntries")
    .withIndex("by_transfer_sequence", (q) =>
      q.eq("transferId", transfer._id).gt("sequence", job.activeSequence ?? 0),
    )
    .order("asc")
    .take(MIGRATION_BATCH);
  let reversedAtoms = job.accumulatorA;
  for (const entry of entries) {
    if (entry.kind === "transfer_reversal") {
      reversedAtoms += Math.max(0, -entry.paidDeltaAtoms);
    }
  }
  if (entries.length === MIGRATION_BATCH) {
    await ctx.db.patch(job._id, {
      activeSequence: entries.at(-1)!.sequence,
      accumulatorA: reversedAtoms,
      rowsRead: job.rowsRead + entries.length,
      chunks: job.chunks + 1,
      updatedAt: Date.now(),
    });
    await scheduleNext(ctx, job._id);
    return;
  }
  const reversedAmount = Math.floor(
    reversedAtoms / ACCOUNTING_ATOMS_PER_USD_CENT,
  );
  const platformAccountId = process.env.STRIPE_PLATFORM_ACCOUNT_ID;
  const secret = process.env.STRIPE_TRANSFER_CORRELATION_SECRET;
  if (
    platformAccountId === undefined ||
    secret === undefined ||
    secret.length < 32
  ) {
    throw new Error(
      "Stripe transfer correlation migration secrets are missing",
    );
  }
  const correlationNonce =
    transfer.correlationNonce ??
    (await sha256Hex(`${MIGRATION_KEY}:${secret}:${transfer._id}`));
  const correlationHmac = await signTransferCorrelation(secret, {
    publisherTransferId: transfer._id,
    nonce: correlationNonce,
    platformAccountId,
    destination: transfer.stripeConnectedAccountId,
    currency: transfer.currency,
    amount: transfer.amount,
  });
  await ctx.db.patch(transfer._id, {
    reversedAmount,
    correlationNonce,
    correlationHmac,
    platformAccountId,
    status: reversedAmount === transfer.amount ? "reversed" : transfer.status,
    updatedAt: Date.now(),
  });
  await audit(ctx, job._id, "transfers", transfer._id, "verified", {
    reversedAmount,
    ledgerReversedAtoms: reversedAtoms,
    destination: transfer.stripeConnectedAccountId,
    currency: transfer.currency,
    amount: transfer.amount,
    platformAccountId,
  });
  await ctx.db.patch(job._id, {
    activeTransferId: undefined,
    activeSequence: 0,
    accumulatorA: 0,
    rowsRead: job.rowsRead + entries.length,
    rowsWritten: job.rowsWritten + 1,
    chunks: job.chunks + 1,
    updatedAt: Date.now(),
  });
  await scheduleNext(ctx, job._id);
}

export const start = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("financialMigrationJobs")
      .withIndex("by_migration_key", (q) => q.eq("migrationKey", MIGRATION_KEY))
      .unique();
    if (existing !== null) {
      if (existing.status !== "verified") {
        await ctx.db.patch(existing._id, {
          status: "running",
          lastError: undefined,
          updatedAt: Date.now(),
        });
        await scheduleNext(ctx, existing._id);
      }
      return existing._id;
    }
    const now = Date.now();
    const jobId = await ctx.db.insert("financialMigrationJobs", {
      migrationKey: MIGRATION_KEY,
      status: "running",
      phase: "wallets",
      accumulatorA: 0,
      accumulatorB: 0,
      accumulatorC: 0,
      rowsRead: 0,
      rowsWritten: 0,
      chunks: 0,
      createdAt: now,
      updatedAt: now,
    });
    await audit(ctx, jobId, "wallets", "start", "checkpoint", {
      migrationKey: MIGRATION_KEY,
      batchSize: MIGRATION_BATCH,
    });
    await scheduleNext(ctx, jobId);
    return jobId;
  },
});

export const runChunk = internalMutation({
  args: { jobId: v.id("financialMigrationJobs") },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.status === "verified") return;
    if (job.phase === "wallets") await runWalletChunk(ctx, job);
    else if (job.phase === "clawbacks") await runClawbackChunk(ctx, job);
    else if (job.phase === "publishers") await runPublisherChunk(ctx, job);
    else if (job.phase === "transfers") await runTransferChunk(ctx, job);
    else if (job.phase === "conservation") {
      await audit(ctx, job._id, "conservation", MIGRATION_KEY, "verified", {
        rowsRead: job.rowsRead,
        rowsWritten: job.rowsWritten,
        chunks: job.chunks,
        walletRule: "available=max(balance,0); debt=max(-balance,0)",
        publisherRule: "materialized buckets=sum(immutable settlement ledger)",
        transferRule: "reversed cents=sum(transfer reversal ledger atoms)",
      });
      await ctx.db.patch(job._id, {
        phase: "complete",
        status: "verified",
        updatedAt: Date.now(),
      });
    }
  },
});

export const status = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db
      .query("financialMigrationJobs")
      .withIndex("by_migration_key", (q) => q.eq("migrationKey", MIGRATION_KEY))
      .unique();
  },
});
