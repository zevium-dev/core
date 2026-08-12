import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { publisherEarningSplit } from "../accounting";
import { internal } from "../_generated/api";
import {
  assertFinanceMigrationAllowsRuntime,
  assertFinanceMigrationJobActive,
} from "./financeMigrationGate";

type SettlementKind = Doc<"publisherSettlementEntries">["kind"];

function safeAtomDelta(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer number of atoms`);
  }
}

export async function getOrCreatePublisherBalance(
  ctx: MutationCtx,
  publisherOrganizationId: Id<"organizations">,
  migrationJobId?: Id<"financialMigrationJobs">,
): Promise<Doc<"publisherBalances">> {
  if (migrationJobId === undefined) {
    await assertFinanceMigrationAllowsRuntime(ctx);
  } else {
    await assertFinanceMigrationJobActive(ctx, migrationJobId);
  }
  const existing = await ctx.db
    .query("publisherBalances")
    .withIndex("by_publisher", (q) =>
      q.eq("publisherOrganizationId", publisherOrganizationId),
    )
    .unique();
  if (existing !== null) {
    assertPublisherBalanceReady(existing, migrationJobId);
    return existing;
  }

  const now = Date.now();
  const id = await ctx.db.insert("publisherBalances", {
    publisherOrganizationId,
    availableAtoms: 0,
    allocatedAtoms: 0,
    paidAtoms: 0,
    pendingRiskAtoms: 0,
    reversedAtoms: 0,
    failedAtoms: 0,
    sequence: 0,
    migrationStatus: migrationJobId === undefined ? "verified" : "building",
    migrationJobId,
    migrationWatermarkSequence: 0,
    updatedAt: now,
  });
  const created = await ctx.db.get(id);
  if (created === null) throw new Error("Failed to create publisher balance");
  return created;
}

export function assertPublisherBalanceReady(
  balance: Doc<"publisherBalances">,
  migrationJobId?: Id<"financialMigrationJobs">,
): asserts balance is Doc<"publisherBalances"> & {
  pendingRiskAtoms: number;
  reversedAtoms: number;
  failedAtoms: number;
} {
  const fenced =
    migrationJobId !== undefined &&
    ((balance.migrationStatus === "building" &&
      balance.migrationJobId === migrationJobId) ||
      (balance.migrationStatus === "verified" &&
        balance.migrationJobId === undefined &&
        balance.migrationWatermarkSequence === balance.sequence));
  const verified =
    migrationJobId === undefined &&
    balance.migrationStatus === "verified" &&
    balance.migrationWatermarkSequence === balance.sequence;
  if (
    (!fenced && !verified) ||
    balance.pendingRiskAtoms === undefined ||
    balance.reversedAtoms === undefined ||
    balance.failedAtoms === undefined ||
    !Number.isSafeInteger(balance.availableAtoms) ||
    !Number.isSafeInteger(balance.allocatedAtoms) ||
    !Number.isSafeInteger(balance.paidAtoms) ||
    !Number.isSafeInteger(balance.pendingRiskAtoms) ||
    !Number.isSafeInteger(balance.reversedAtoms) ||
    !Number.isSafeInteger(balance.failedAtoms) ||
    balance.allocatedAtoms < 0 ||
    balance.paidAtoms < 0 ||
    balance.pendingRiskAtoms < 0 ||
    balance.reversedAtoms < 0 ||
    balance.failedAtoms < 0
  ) {
    throw new Error("Publisher finance migration is not verified");
  }
}

export async function adjustPublisherBalanceAggregates(
  ctx: MutationCtx,
  balance: Doc<"publisherBalances">,
  deltas: {
    pendingRiskAtoms?: number;
    reversedAtoms?: number;
    failedAtoms?: number;
  },
  migrationJobId?: Id<"financialMigrationJobs">,
): Promise<Doc<"publisherBalances">> {
  if (migrationJobId === undefined) {
    await assertFinanceMigrationAllowsRuntime(ctx);
  } else {
    await assertFinanceMigrationJobActive(ctx, migrationJobId);
  }
  assertPublisherBalanceReady(balance, migrationJobId);
  const pendingRiskAtoms =
    balance.pendingRiskAtoms + (deltas.pendingRiskAtoms ?? 0);
  const reversedAtoms = balance.reversedAtoms + (deltas.reversedAtoms ?? 0);
  const failedAtoms = balance.failedAtoms + (deltas.failedAtoms ?? 0);
  for (const [name, value] of [
    ["Pending-risk aggregate", pendingRiskAtoms],
    ["Reversed aggregate", reversedAtoms],
    ["Failed aggregate", failedAtoms],
  ] as const) {
    safeAtomDelta(value, name);
    if (value < 0) throw new Error(`${name} cannot become negative`);
  }
  const updatedAt = Date.now();
  await ctx.db.patch(balance._id, {
    pendingRiskAtoms,
    reversedAtoms,
    failedAtoms,
    updatedAt,
  });
  return {
    ...balance,
    pendingRiskAtoms,
    reversedAtoms,
    failedAtoms,
    updatedAt,
  };
}

export async function appendPublisherSettlementEntry(
  ctx: MutationCtx,
  args: {
    balance: Doc<"publisherBalances">;
    kind: SettlementKind;
    availableDeltaAtoms: number;
    allocatedDeltaAtoms: number;
    paidDeltaAtoms: number;
    refId: string;
    earningId?: Id<"publisherEarnings">;
    transferId?: Id<"publisherTransfers">;
    paymentId?: Id<"payments">;
    migrationJobId?: Id<"financialMigrationJobs">;
  },
): Promise<{ applied: boolean; balance: Doc<"publisherBalances"> }> {
  if (args.migrationJobId === undefined) {
    await assertFinanceMigrationAllowsRuntime(ctx);
  } else {
    await assertFinanceMigrationJobActive(ctx, args.migrationJobId);
  }
  assertPublisherBalanceReady(args.balance, args.migrationJobId);
  safeAtomDelta(args.availableDeltaAtoms, "Available delta");
  safeAtomDelta(args.allocatedDeltaAtoms, "Allocated delta");
  safeAtomDelta(args.paidDeltaAtoms, "Paid delta");
  if (
    args.availableDeltaAtoms === 0 &&
    args.allocatedDeltaAtoms === 0 &&
    args.paidDeltaAtoms === 0
  ) {
    throw new Error("Publisher settlement entry cannot be empty");
  }
  if (args.refId.trim() === "") {
    throw new Error("Publisher settlement reference is required");
  }

  const existing = await ctx.db
    .query("publisherSettlementEntries")
    .withIndex("by_ref", (q) => q.eq("refId", args.refId))
    .unique();
  if (existing !== null) {
    if (
      existing.publisherBalanceId !== args.balance._id ||
      existing.publisherOrganizationId !==
        args.balance.publisherOrganizationId ||
      existing.kind !== args.kind ||
      existing.availableDeltaAtoms !== args.availableDeltaAtoms ||
      existing.allocatedDeltaAtoms !== args.allocatedDeltaAtoms ||
      existing.paidDeltaAtoms !== args.paidDeltaAtoms ||
      existing.earningId !== args.earningId ||
      existing.transferId !== args.transferId ||
      existing.paymentId !== args.paymentId
    ) {
      throw new Error("Publisher settlement replay changed immutable facts");
    }
    const balance = await ctx.db.get(existing.publisherBalanceId);
    if (balance === null) throw new Error("Publisher balance is missing");
    return { applied: false, balance };
  }

  const availableAtoms = args.balance.availableAtoms + args.availableDeltaAtoms;
  const allocatedAtoms = args.balance.allocatedAtoms + args.allocatedDeltaAtoms;
  const paidAtoms = args.balance.paidAtoms + args.paidDeltaAtoms;
  for (const [name, value] of [
    ["Available balance", availableAtoms],
    ["Allocated balance", allocatedAtoms],
    ["Paid balance", paidAtoms],
  ] as const) {
    safeAtomDelta(value, name);
  }
  if (allocatedAtoms < 0 || paidAtoms < 0) {
    throw new Error("Publisher settlement buckets cannot become negative");
  }

  const sequence = args.balance.sequence + 1;
  const now = Date.now();
  await ctx.db.insert("publisherSettlementEntries", {
    publisherBalanceId: args.balance._id,
    publisherOrganizationId: args.balance.publisherOrganizationId,
    kind: args.kind,
    availableDeltaAtoms: args.availableDeltaAtoms,
    allocatedDeltaAtoms: args.allocatedDeltaAtoms,
    paidDeltaAtoms: args.paidDeltaAtoms,
    refId: args.refId,
    sequence,
    earningId: args.earningId,
    transferId: args.transferId,
    paymentId: args.paymentId,
    createdAt: now,
  });
  await ctx.db.patch(args.balance._id, {
    availableAtoms,
    allocatedAtoms,
    paidAtoms,
    sequence,
    migrationWatermarkSequence: sequence,
    updatedAt: now,
  });
  return {
    applied: true,
    balance: {
      ...args.balance,
      availableAtoms,
      allocatedAtoms,
      paidAtoms,
      sequence,
      migrationWatermarkSequence: sequence,
      updatedAt: now,
    },
  };
}

export async function releasePublisherEarning(
  ctx: MutationCtx,
  earning: Doc<"publisherEarnings">,
): Promise<number> {
  if (earning.status !== "pending_risk" || earning.availableAt > Date.now()) {
    return 0;
  }
  const releasableAtoms = earning.publisherNetAtoms - earning.clawedBackAtoms;
  if (!Number.isSafeInteger(releasableAtoms) || releasableAtoms < 0) {
    throw new Error("Publisher earning has invalid atom accounting");
  }

  if (releasableAtoms > 0) {
    const balance = await getOrCreatePublisherBalance(
      ctx,
      earning.publisherOrganizationId,
    );
    const released = await appendPublisherSettlementEntry(ctx, {
      balance,
      kind: "earning_release",
      availableDeltaAtoms: releasableAtoms,
      allocatedDeltaAtoms: 0,
      paidDeltaAtoms: 0,
      refId: `publisher:earning:${earning._id}:release`,
      earningId: earning._id,
    });
    await adjustPublisherBalanceAggregates(ctx, released.balance, {
      pendingRiskAtoms: -releasableAtoms,
    });
  } else {
    const balance = await getOrCreatePublisherBalance(
      ctx,
      earning.publisherOrganizationId,
    );
    await adjustPublisherBalanceAggregates(ctx, balance, {
      pendingRiskAtoms: -releasableAtoms,
    });
  }
  await ctx.db.patch(earning._id, {
    releasedAtoms: releasableAtoms,
    status: releasableAtoms === 0 ? "reversed" : "available",
    updatedAt: Date.now(),
  });
  return releasableAtoms;
}

/** At most eight source rows: worst-case publisher reconciliation stays < 80 writes. */
const RECONCILIATION_CHUNK = 8;
const MAX_PAYMENT_EXPOSURES = 100;

/** Durable exact-source reconciliation kick. Repeated calls only bump revision. */
export async function enqueuePaymentPublisherReconciliation(
  ctx: MutationCtx,
  args: {
    paymentId: Id<"payments">;
    consumerOrganizationId: Id<"organizations">;
  },
): Promise<void> {
  const existing = await ctx.db
    .query("publisherReconciliationJobs")
    .withIndex("by_payment", (q) => q.eq("paymentId", args.paymentId))
    .unique();
  const now = Date.now();
  if (existing === null) {
    await ctx.db.insert("publisherReconciliationJobs", {
      paymentId: args.paymentId,
      consumerOrganizationId: args.consumerOrganizationId,
      status: "pending",
      revision: 1,
      processedChunks: 0,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch(existing._id, {
      status: "pending",
      revision: existing.revision + 1,
      lastError: undefined,
      updatedAt: now,
    });
  }
  await ctx.scheduler.runAfter(
    0,
    internal.billing.processPublisherReconciliation,
    { paymentId: args.paymentId },
  );
}

async function updateAllocationRollup(
  ctx: MutationCtx,
  allocation: Doc<"walletFundingAllocations">,
  publisherOrganizationId: Id<"organizations">,
  delta: number,
): Promise<void> {
  if (allocation.fundingLotId === undefined) return;
  const rollup = await ctx.db
    .query("fundingAllocationRollups")
    .withIndex("by_lot_publisher", (q) =>
      q
        .eq("fundingLotId", allocation.fundingLotId!)
        .eq("publisherOrganizationId", publisherOrganizationId),
    )
    .unique();
  if (rollup === null) throw new Error("Funding allocation rollup is missing");
  const clawedBackGrossCredits = rollup.clawedBackGrossCredits + delta;
  if (
    clawedBackGrossCredits < 0 ||
    clawedBackGrossCredits > rollup.allocatedGrossCredits
  ) {
    throw new Error("Funding allocation rollup clawback underflow");
  }
  await ctx.db.patch(rollup._id, {
    clawedBackGrossCredits,
    updatedAt: Date.now(),
  });
}

async function restoreExposureChunk(
  ctx: MutationCtx,
  exposure: Doc<"paymentExposures">,
): Promise<number> {
  let remaining = exposure.appliedPublisherCredits - exposure.publisherCredits;
  const rows = await ctx.db
    .query("publisherClawbacks")
    .withIndex("by_source_state_created", (q) =>
      q.eq("sourceRef", exposure.sourceRef).eq("state", "active"),
    )
    .order("desc")
    .take(RECONCILIATION_CHUNK);
  let restoredTotal = 0;
  for (const row of rows) {
    if (remaining === 0) break;
    const alreadyRestored = row.restoredGrossCredits ?? 0;
    const active = row.grossCredits - alreadyRestored;
    if (active <= 0) continue;
    const grossCredits = Math.min(active, remaining);
    const amountAtoms = publisherEarningSplit(grossCredits).publisherNetAtoms;
    const earning = await ctx.db.get(row.earningId);
    if (earning === null) throw new Error("Clawed-back earning is missing");
    const allocation =
      row.allocationId === undefined
        ? null
        : await ctx.db.get(row.allocationId);
    if (allocation !== null) {
      const clawedBackGrossCredits =
        allocation.clawedBackGrossCredits - grossCredits;
      if (clawedBackGrossCredits < 0) {
        throw new Error("Funding allocation restoration underflow");
      }
      await ctx.db.patch(allocation._id, { clawedBackGrossCredits });
      await updateAllocationRollup(
        ctx,
        allocation,
        earning.publisherOrganizationId,
        -grossCredits,
      );
    }
    const restoredGrossCredits = alreadyRestored + grossCredits;
    const restoredAtoms = (row.restoredAtoms ?? 0) + amountAtoms;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      restoredGrossCredits,
      restoredAtoms,
      state: restoredGrossCredits === row.grossCredits ? "restored" : "active",
      updatedAt: now,
    });
    const earningGross = earning.clawedBackGrossCredits - grossCredits;
    const earningAtoms = earning.clawedBackAtoms - amountAtoms;
    if (earningGross < 0 || earningAtoms < 0) {
      throw new Error("Publisher clawback restoration underflow");
    }
    const wasReleased = earning.status !== "pending_risk";
    await ctx.db.patch(earning._id, {
      clawedBackGrossCredits: earningGross,
      clawedBackAtoms: earningAtoms,
      releasedAtoms: wasReleased
        ? earning.releasedAtoms + amountAtoms
        : earning.releasedAtoms,
      status: wasReleased ? "available" : "pending_risk",
      updatedAt: now,
    });
    const balance = await getOrCreatePublisherBalance(
      ctx,
      earning.publisherOrganizationId,
    );
    if (wasReleased) {
      const restored = await appendPublisherSettlementEntry(ctx, {
        balance,
        kind:
          row.sourceKind === "refund"
            ? "refund_restoration"
            : "dispute_restoration",
        availableDeltaAtoms: amountAtoms,
        allocatedDeltaAtoms: 0,
        paidDeltaAtoms: 0,
        refId: `${row.sourceRef}:restore:${row._id}:${restoredGrossCredits}`,
        earningId: earning._id,
        paymentId: row.paymentId,
      });
      await adjustPublisherBalanceAggregates(ctx, restored.balance, {
        reversedAtoms: -amountAtoms,
      });
    } else {
      await adjustPublisherBalanceAggregates(ctx, balance, {
        pendingRiskAtoms: amountAtoms,
        reversedAtoms: -amountAtoms,
      });
    }
    restoredTotal += grossCredits;
    remaining -= grossCredits;
  }
  if (restoredTotal === 0 && remaining > 0) {
    throw new Error("Source-specific clawback rows are missing");
  }
  await ctx.db.patch(exposure._id, {
    appliedPublisherCredits: exposure.appliedPublisherCredits - restoredTotal,
    allocationCursor: undefined,
    updatedAt: Date.now(),
  });
  return restoredTotal;
}

async function allocateExposureChunk(
  ctx: MutationCtx,
  exposure: Doc<"paymentExposures">,
  consumerOrganizationId: Id<"organizations">,
): Promise<number> {
  let remaining = exposure.publisherCredits - exposure.appliedPublisherCredits;
  const wallet = await ctx.db
    .query("wallets")
    .withIndex("by_organization", (q) =>
      q.eq("organizationId", consumerOrganizationId),
    )
    .unique();
  if (wallet === null) throw new Error("Consumer wallet is missing");
  const page = await ctx.db
    .query("walletFundingAllocations")
    .withIndex("by_wallet_created", (q) => q.eq("walletId", wallet._id))
    .order("asc")
    .paginate({
      cursor: exposure.allocationCursor ?? null,
      numItems: RECONCILIATION_CHUNK,
      maximumRowsRead: RECONCILIATION_CHUNK * 2,
    });
  let allocatedTotal = 0;
  for (const allocation of page.page) {
    if (remaining === 0) break;
    if (allocation.earningId === undefined || allocation.kind !== "usage") {
      continue;
    }
    const paymentGrossCredits =
      allocation.provenance === undefined
        ? allocation.paymentId === exposure.paymentId
          ? allocation.grossCredits
          : 0
        : allocation.provenance
            .filter((slice) => slice.paymentId === exposure.paymentId)
            .reduce((sum, slice) => sum + slice.grossCredits, 0);
    if (paymentGrossCredits === 0) continue;
    const priorRows = await ctx.db
      .query("publisherClawbacks")
      .withIndex("by_allocation", (q) => q.eq("allocationId", allocation._id))
      .take(MAX_PAYMENT_EXPOSURES + 1);
    if (priorRows.length > MAX_PAYMENT_EXPOSURES) {
      throw new Error("Funding allocation exceeds bounded exposure sources");
    }
    const paymentClawedBackCredits = priorRows
      .filter((row) => row.paymentId === exposure.paymentId)
      .reduce(
        (sum, row) => sum + row.grossCredits - (row.restoredGrossCredits ?? 0),
        0,
      );
    const capacity = paymentGrossCredits - paymentClawedBackCredits;
    if (capacity < 0) {
      throw new Error("Payment provenance clawback exceeds allocation");
    }
    if (capacity <= 0) continue;
    const earning = await ctx.db.get(allocation.earningId);
    if (earning === null) throw new Error("Funded earning is missing");
    const grossCredits = Math.min(capacity, remaining);
    const amountAtoms = publisherEarningSplit(grossCredits).publisherNetAtoms;
    const now = Date.now();
    const rowId = await ctx.db.insert("publisherClawbacks", {
      paymentId: exposure.paymentId,
      consumerOrganizationId,
      publisherOrganizationId: earning.publisherOrganizationId,
      earningId: earning._id,
      sourceKind: exposure.sourceKind,
      sourceRef: exposure.sourceRef,
      allocationId: allocation._id,
      grossCredits,
      amountAtoms,
      restoredGrossCredits: 0,
      restoredAtoms: 0,
      state: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(allocation._id, {
      clawedBackGrossCredits: allocation.clawedBackGrossCredits + grossCredits,
    });
    await updateAllocationRollup(
      ctx,
      allocation,
      earning.publisherOrganizationId,
      grossCredits,
    );
    const wasPending = earning.status === "pending_risk";
    await ctx.db.patch(earning._id, {
      clawedBackGrossCredits: earning.clawedBackGrossCredits + grossCredits,
      clawedBackAtoms: earning.clawedBackAtoms + amountAtoms,
      releasedAtoms: wasPending
        ? earning.releasedAtoms
        : earning.releasedAtoms - amountAtoms,
      status: wasPending
        ? "pending_risk"
        : earning.clawedBackGrossCredits + grossCredits === earning.grossCredits
          ? "reversed"
          : earning.status,
      updatedAt: now,
    });
    const balance = await getOrCreatePublisherBalance(
      ctx,
      earning.publisherOrganizationId,
    );
    if (wasPending) {
      await adjustPublisherBalanceAggregates(ctx, balance, {
        pendingRiskAtoms: -amountAtoms,
        reversedAtoms: amountAtoms,
      });
    } else {
      const clawed = await appendPublisherSettlementEntry(ctx, {
        balance,
        kind:
          exposure.sourceKind === "refund"
            ? "refund_clawback"
            : "dispute_clawback",
        availableDeltaAtoms: -amountAtoms,
        allocatedDeltaAtoms: 0,
        paidDeltaAtoms: 0,
        refId: `${exposure.sourceRef}:clawback:${rowId}`,
        earningId: earning._id,
        paymentId: exposure.paymentId,
      });
      await adjustPublisherBalanceAggregates(ctx, clawed.balance, {
        reversedAtoms: amountAtoms,
      });
    }
    allocatedTotal += grossCredits;
    remaining -= grossCredits;
  }
  if (allocatedTotal === 0 && page.isDone && remaining > 0) {
    throw new Error("Publisher exposure exceeds source allocation rollup");
  }
  await ctx.db.patch(exposure._id, {
    appliedPublisherCredits: exposure.appliedPublisherCredits + allocatedTotal,
    allocationCursor: remaining === 0 ? undefined : page.continueCursor,
    updatedAt: Date.now(),
  });
  return allocatedTotal;
}

/** One bounded, crash-retry-safe publisher reconciliation transaction. */
export async function processPaymentPublisherReconciliationChunk(
  ctx: MutationCtx,
  paymentId: Id<"payments">,
): Promise<{ complete: boolean; processed: number }> {
  const job = await ctx.db
    .query("publisherReconciliationJobs")
    .withIndex("by_payment", (q) => q.eq("paymentId", paymentId))
    .unique();
  if (job === null || job.status === "complete") {
    return { complete: true, processed: 0 };
  }
  const exposures = await ctx.db
    .query("paymentExposures")
    .withIndex("by_payment_created", (q) => q.eq("paymentId", paymentId))
    .order("asc")
    .take(MAX_PAYMENT_EXPOSURES + 1);
  if (exposures.length > MAX_PAYMENT_EXPOSURES) {
    await ctx.db.patch(job._id, {
      status: "failed",
      lastError: `Payment exceeds ${MAX_PAYMENT_EXPOSURES} exposure sources`,
      updatedAt: Date.now(),
    });
    return { complete: false, processed: 0 };
  }
  const restore = [...exposures]
    .reverse()
    .find(
      (exposure) =>
        exposure.appliedPublisherCredits > exposure.publisherCredits,
    );
  const allocate = exposures.find(
    (exposure) => exposure.appliedPublisherCredits < exposure.publisherCredits,
  );
  let processed = 0;
  if (restore !== undefined) {
    processed = await restoreExposureChunk(ctx, restore);
  } else if (allocate !== undefined) {
    processed = await allocateExposureChunk(
      ctx,
      allocate,
      job.consumerOrganizationId,
    );
  } else {
    await ctx.db.patch(job._id, {
      status: "complete",
      processedChunks: job.processedChunks + 1,
      lastError: undefined,
      updatedAt: Date.now(),
    });
    return { complete: true, processed: 0 };
  }
  await ctx.db.patch(job._id, {
    status: "running",
    processedChunks: job.processedChunks + 1,
    updatedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(
    0,
    internal.billing.processPublisherReconciliation,
    { paymentId },
  );
  return { complete: false, processed };
}
