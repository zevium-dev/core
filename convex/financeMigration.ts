import {
  signTransferCorrelation,
  verifyTransferCorrelation,
} from "@zevium/shared";
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
  ACCOUNTING_ATOMS_PER_CREDIT,
  ACCOUNTING_ATOMS_PER_USD_CENT,
  PUBLISHER_RISK_HOLD_MS,
  publisherEarningSplit,
} from "./accounting";
import {
  commitFundingAllocation,
  commitPaymentReversal,
  FUNDING_COMPACTION_INPUTS,
  getFundingState,
  preflightFundingAllocation,
  preflightPaymentReversal,
  recordPositiveFundingSource,
} from "./lib/funding";
import { requireAdmin } from "./lib/auth";
import { FINANCE_MIGRATION_KEY } from "./lib/financeMigrationGate";
import { paymentStatusForProjection } from "./lib/paymentStatus";

const MIGRATION_KEY = FINANCE_MIGRATION_KEY;
const SCOPE_BATCH = 1;
// One money-bearing history row per mutation keeps total writes below the
// same transaction budget enforced by live settlement.
const DETAIL_BATCH = 1;
const VERIFY_BATCH = 25;
const MAX_PAYMENT_SOURCES = 100;

type AuditResult = "checkpoint" | "verified" | "failed";

async function audit(
  ctx: MutationCtx,
  jobId: Id<"financialMigrationJobs">,
  phase: string,
  scopeRef: string,
  result: AuditResult,
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

async function assertInitialMigrationQuiescence(
  ctx: MutationCtx,
): Promise<void> {
  for (const status of ["received", "processing", "failed"] as const) {
    const event = await ctx.db
      .query("paymentEvents")
      .withIndex("by_status_next_attempt", (q) => q.eq("status", status))
      .first();
    if (event !== null) {
      throw new Error(
        `Stripe event ${event.stripeEventId} must be drained before finance migration`,
      );
    }
  }
  for (const status of ["pending", "running", "failed"] as const) {
    const reconciliation = await ctx.db
      .query("publisherReconciliationJobs")
      .withIndex("by_status_updated", (q) => q.eq("status", status))
      .first();
    if (reconciliation !== null) {
      throw new Error(
        `Publisher reconciliation ${reconciliation._id} must be complete before finance migration`,
      );
    }
  }
}

function parseState<T>(value: string | undefined, fallback: T): T {
  if (value === undefined) return fallback;
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Migration verification checkpoint is invalid");
  }
  return parsed as T;
}

function safeAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} overflowed safe integer accounting`);
  }
  return value;
}

function transferSecret(): string {
  const secret = process.env.STRIPE_TRANSFER_CORRELATION_SECRET;
  if (secret === undefined || secret.length < 32) {
    throw new Error("Stripe transfer correlation migration secret is missing");
  }
  return secret;
}

function platformAccountId(): string {
  const value = process.env.STRIPE_PLATFORM_ACCOUNT_ID;
  if (value === undefined || !/^acct_[A-Za-z0-9]+$/.test(value)) {
    throw new Error("Stripe platform account id is missing");
  }
  return value;
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

async function ensureWalletFence(
  ctx: MutationCtx,
  job: Doc<"financialMigrationJobs">,
  wallet: Doc<"wallets">,
): Promise<Doc<"walletFundingStates">> {
  const existing = await getFundingState(ctx, wallet._id);
  if (existing === null) {
    const id = await ctx.db.insert("walletFundingStates", {
      walletId: wallet._id,
      organizationId: wallet.organizationId,
      nonrefundableAvailableCredits: 0,
      refundableAvailableCredits: 0,
      allocatedCredits: 0,
      reversedCredits: 0,
      sequence: 0,
      migrationStatus: "building",
      migrationJobId: job._id,
      migrationWatermarkSequence: 0,
      updatedAt: Date.now(),
    });
    const created = await ctx.db.get(id);
    if (created === null) throw new Error("Wallet migration fence disappeared");
    return created;
  }
  if (
    existing.migrationStatus === "building" &&
    existing.migrationJobId !== job._id
  ) {
    throw new Error("Wallet is fenced by another migration job");
  }
  await ctx.db.patch(existing._id, {
    migrationStatus: "building",
    migrationJobId: job._id,
    updatedAt: Date.now(),
  });
  return {
    ...existing,
    migrationStatus: "building",
    migrationJobId: job._id,
  };
}

async function ensurePublisherFence(
  ctx: MutationCtx,
  job: Doc<"financialMigrationJobs">,
  publisherOrganizationId: Id<"organizations">,
): Promise<Doc<"publisherBalances">> {
  const existing = await ctx.db
    .query("publisherBalances")
    .withIndex("by_publisher", (q) =>
      q.eq("publisherOrganizationId", publisherOrganizationId),
    )
    .unique();
  if (existing === null) {
    const id = await ctx.db.insert("publisherBalances", {
      publisherOrganizationId,
      availableAtoms: 0,
      allocatedAtoms: 0,
      paidAtoms: 0,
      pendingRiskAtoms: 0,
      reversedAtoms: 0,
      failedAtoms: 0,
      sequence: 0,
      migrationStatus: "building",
      migrationJobId: job._id,
      migrationWatermarkSequence: 0,
      updatedAt: Date.now(),
    });
    const created = await ctx.db.get(id);
    if (created === null) {
      throw new Error("Publisher migration fence disappeared");
    }
    return created;
  }
  if (
    existing.migrationStatus === "building" &&
    existing.migrationJobId !== job._id
  ) {
    throw new Error("Publisher is fenced by another migration job");
  }
  await ctx.db.patch(existing._id, {
    pendingRiskAtoms: existing.pendingRiskAtoms ?? 0,
    reversedAtoms: existing.reversedAtoms ?? 0,
    failedAtoms: existing.failedAtoms ?? 0,
    migrationStatus: "building",
    migrationJobId: job._id,
    updatedAt: Date.now(),
  });
  return {
    ...existing,
    pendingRiskAtoms: existing.pendingRiskAtoms ?? 0,
    reversedAtoms: existing.reversedAtoms ?? 0,
    failedAtoms: existing.failedAtoms ?? 0,
    migrationStatus: "building",
    migrationJobId: job._id,
  };
}

function positiveSourceKind(
  entry: Doc<"walletEntries">,
): "stripe_payment" | "promotion" | "admin_adjustment" | "restoration" {
  if (entry.kind === "payment_grant") return "stripe_payment";
  if (
    entry.kind === "refund_restoration" ||
    entry.kind === "dispute_restoration"
  ) {
    return "restoration";
  }
  return entry.refId.startsWith("promo:") ? "promotion" : "admin_adjustment";
}

async function earningForUsage(
  ctx: MutationCtx,
  job: Doc<"financialMigrationJobs">,
  usage: Doc<"usageEvents">,
  settleRefId: string,
): Promise<Doc<"publisherEarnings">> {
  const project = await ctx.db.get(usage.projectId);
  if (project === null) throw new Error("Migration usage project is missing");
  await ctx.db.patch(usage._id, {
    projectName: project.name,
    projectSlug: project.slug,
  });
  const existing = await ctx.db
    .query("publisherEarnings")
    .withIndex("by_settlement", (q) =>
      q.eq("usageSettlementRefId", settleRefId),
    )
    .unique();
  if (existing !== null) {
    if (
      existing.consumerOrganizationId !== usage.organizationId ||
      existing.projectId !== project._id ||
      existing.publisherOrganizationId !== project.organizationId
    ) {
      throw new Error("Migration earning linkage changed immutable facts");
    }
    await ctx.db.patch(existing._id, {
      projectName: project.name,
      projectSlug: project.slug,
    });
    await ensurePublisherFence(ctx, job, existing.publisherOrganizationId);
    return existing;
  }
  await ensurePublisherFence(ctx, job, project.organizationId);
  const split = publisherEarningSplit(usage.credits);
  const id = await ctx.db.insert("publisherEarnings", {
    publisherOrganizationId: project.organizationId,
    consumerOrganizationId: usage.organizationId,
    projectId: project._id,
    projectName: project.name,
    projectSlug: project.slug,
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

async function migrateWalletEntry(
  ctx: MutationCtx,
  job: Doc<"financialMigrationJobs">,
  wallet: Doc<"wallets">,
  entry: Doc<"walletEntries">,
): Promise<number> {
  if (entry.amount > 0) {
    const sourceKind = positiveSourceKind(entry);
    await recordPositiveFundingSource(ctx, {
      wallet,
      sourceKind,
      sourceRef: entry.refId,
      amount: entry.amount,
      refundable:
        sourceKind === "stripe_payment" || sourceKind === "restoration",
      paymentId: entry.paymentId,
      createdAt: entry.createdAt,
      migrationJobId: job._id,
    });
    return 1;
  }
  if (entry.amount === 0) return 0;

  if (entry.kind === "refund_reversal" || entry.kind === "dispute_reversal") {
    if (entry.paymentId === undefined) {
      throw new Error("Payment reversal has no payment provenance");
    }
    const existing = await ctx.db
      .query("walletFundingReversals")
      .withIndex("by_wallet_entry", (q) => q.eq("walletEntryId", entry._id))
      .unique();
    if (existing !== null) return 0;
    const plan = await preflightPaymentReversal(ctx, {
      wallet,
      paymentId: entry.paymentId,
      requestedCredits: -entry.amount,
      migrationJobId: job._id,
    });
    if (plan.walletCredits !== -entry.amount) {
      throw new Error("Legacy payment reversal lacks exact funding inventory");
    }
    await commitPaymentReversal(ctx, {
      plan,
      walletSequence: entry.sequence,
      now: entry.createdAt,
      migrationJobId: job._id,
    });
    await ctx.db.insert("walletFundingReversals", {
      walletId: wallet._id,
      organizationId: wallet.organizationId,
      walletEntryId: entry._id,
      paymentId: entry.paymentId,
      grossCredits: plan.walletCredits,
      createdAt: entry.createdAt,
    });
    return 1;
  }

  const existing = await ctx.db
    .query("walletFundingAllocations")
    .withIndex("by_wallet_entry", (q) => q.eq("walletEntryId", entry._id))
    .first();
  if (existing !== null) return 0;
  const plan = await preflightFundingAllocation(ctx, {
    wallet,
    credits: -entry.amount,
    migrationJobId: job._id,
  });
  if (entry.kind === "usage_settlement") {
    if (entry.usageEventId === undefined) {
      throw new Error("Usage settlement has no usage linkage");
    }
    const usage = await ctx.db.get(entry.usageEventId);
    if (usage === null) throw new Error("Migration usage event is missing");
    const earning = await earningForUsage(ctx, job, usage, entry.refId);
    await commitFundingAllocation(ctx, {
      plan,
      walletEntryId: entry._id,
      walletId: wallet._id,
      walletSequence: entry.sequence,
      organizationId: wallet.organizationId,
      kind: "usage",
      usageEventId: usage._id,
      earningId: earning._id,
      publisherOrganizationId: earning.publisherOrganizationId,
      createdAt: entry.createdAt,
      migrationJobId: job._id,
    });
  } else {
    if (entry.kind !== "admin_adjustment") {
      throw new Error("Unsupported negative legacy wallet entry");
    }
    await commitFundingAllocation(ctx, {
      plan,
      walletEntryId: entry._id,
      walletId: wallet._id,
      walletSequence: entry.sequence,
      organizationId: wallet.organizationId,
      kind: "negative_adjustment",
      createdAt: entry.createdAt,
      migrationJobId: job._id,
    });
  }
  return 1;
}

type WalletVerify = {
  stage: "ledger" | "lots" | "allocations" | "reversals";
  cursor: string | null;
  ledgerBalance: number;
  positiveCredits: number;
  allocationDebits: number;
  reversalDebits: number;
  lastLedgerSequence: number;
  rootGranted: number;
  available: number;
  nonrefundableAvailable: number;
  refundableAvailable: number;
  lotAllocated: number;
  lotReversed: number;
  allocationTotal: number;
  reversalTotal: number;
};

const emptyWalletVerify = (): WalletVerify => ({
  stage: "ledger",
  cursor: null,
  ledgerBalance: 0,
  positiveCredits: 0,
  allocationDebits: 0,
  reversalDebits: 0,
  lastLedgerSequence: 0,
  rootGranted: 0,
  available: 0,
  nonrefundableAvailable: 0,
  refundableAvailable: 0,
  lotAllocated: 0,
  lotReversed: 0,
  allocationTotal: 0,
  reversalTotal: 0,
});

async function verifyWalletChunk(
  ctx: MutationCtx,
  job: Doc<"financialMigrationJobs">,
  wallet: Doc<"wallets">,
): Promise<boolean> {
  const state = await getFundingState(ctx, wallet._id);
  if (
    state === null ||
    state.migrationStatus !== "building" ||
    state.migrationJobId !== job._id
  ) {
    throw new Error("Wallet migration fence is missing");
  }
  const verify = parseState(job.verificationState, emptyWalletVerify());
  verify.nonrefundableAvailable ??= 0;
  verify.refundableAvailable ??= 0;
  if (verify.stage === "ledger") {
    const page = await ctx.db
      .query("walletEntries")
      .withIndex("by_wallet_sequence", (q) => q.eq("walletId", wallet._id))
      .order("asc")
      .paginate({
        cursor: verify.cursor,
        numItems: VERIFY_BATCH,
        maximumRowsRead: VERIFY_BATCH * 2,
      });
    for (const entry of page.page) {
      if (entry.sequence !== verify.lastLedgerSequence + 1) {
        throw new Error("Wallet ledger sequence is not contiguous");
      }
      verify.lastLedgerSequence = entry.sequence;
      verify.ledgerBalance = safeAdd(
        verify.ledgerBalance,
        entry.amount,
        "Wallet ledger balance",
      );
      if (entry.amount > 0) {
        verify.positiveCredits = safeAdd(
          verify.positiveCredits,
          entry.amount,
          "Wallet positive sources",
        );
      } else if (entry.amount < 0) {
        if (
          entry.kind === "refund_reversal" ||
          entry.kind === "dispute_reversal"
        ) {
          verify.reversalDebits = safeAdd(
            verify.reversalDebits,
            -entry.amount,
            "Wallet reversal debits",
          );
        } else {
          verify.allocationDebits = safeAdd(
            verify.allocationDebits,
            -entry.amount,
            "Wallet allocation debits",
          );
        }
      }
    }
    verify.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) verify.stage = "lots";
  } else if (verify.stage === "lots") {
    const page = await ctx.db
      .query("walletFundingLots")
      .withIndex("by_wallet_created", (q) => q.eq("walletId", wallet._id))
      .order("asc")
      .paginate({
        cursor: verify.cursor,
        numItems: DETAIL_BATCH,
        maximumRowsRead: DETAIL_BATCH * 2,
      });
    for (const lot of page.page) {
      const compactedCredits = lot.compactedCredits ?? 0;
      if (
        lot.grantedCredits <= 0 ||
        lot.availableCredits < 0 ||
        lot.allocatedCredits < 0 ||
        lot.reversedCredits < 0 ||
        compactedCredits < 0 ||
        lot.grantedCredits !==
          lot.availableCredits +
            lot.allocatedCredits +
            lot.reversedCredits +
            compactedCredits ||
        lot.walletId !== wallet._id ||
        lot.organizationId !== wallet.organizationId ||
        (lot.state === "available" &&
          (lot.availableCredits <= 0 || compactedCredits !== 0)) ||
        (lot.state === "depleted" &&
          (lot.availableCredits !== 0 || compactedCredits !== 0)) ||
        (lot.state === "compacted" &&
          (lot.availableCredits !== 0 || compactedCredits <= 0))
      ) {
        throw new Error("Funding lot conservation failed");
      }
      const outgoing = await ctx.db
        .query("walletFundingLotComponents")
        .withIndex("by_source_lot", (q) => q.eq("sourceLotId", lot._id))
        .take(2);
      if (
        outgoing.length !== (compactedCredits === 0 ? 0 : 1) ||
        outgoing.reduce((sum, row) => sum + row.grossCredits, 0) !==
          compactedCredits
      ) {
        throw new Error("Funding lot compaction lineage is incomplete");
      }
      for (const component of outgoing) {
        const compacted = await ctx.db.get(component.compactedLotId);
        if (
          component.walletId !== wallet._id ||
          component.sourceLotId !== lot._id ||
          component.grossCredits !== compactedCredits ||
          compacted === null ||
          compacted.walletId !== wallet._id ||
          compacted.sourceKind !== "compaction"
        ) {
          throw new Error("Funding lot outgoing lineage is invalid");
        }
      }
      if (lot.sourceKind === "compaction") {
        const incoming = await ctx.db
          .query("walletFundingLotComponents")
          .withIndex("by_compacted_lot", (q) => q.eq("compactedLotId", lot._id))
          .take(9);
        if (
          incoming.length !== FUNDING_COMPACTION_INPUTS ||
          incoming.reduce((sum, row) => sum + row.grossCredits, 0) !==
            lot.grantedCredits ||
          incoming.some((row) => row.walletId !== wallet._id)
        ) {
          throw new Error("Compacted funding lot has invalid lineage");
        }
        for (const component of incoming) {
          const source = await ctx.db.get(component.sourceLotId);
          if (
            component.compactedLotId !== lot._id ||
            component.grossCredits <= 0 ||
            source === null ||
            source.walletId !== wallet._id ||
            source.compactedCredits === undefined ||
            source.compactedCredits < component.grossCredits
          ) {
            throw new Error("Compacted funding lot source is invalid");
          }
        }
      } else {
        const sourceEntry = await ctx.db
          .query("walletEntries")
          .withIndex("by_ref", (q) => q.eq("refId", lot.sourceRef))
          .unique();
        const expectedSourceKind =
          sourceEntry?.kind === "payment_grant"
            ? "stripe_payment"
            : sourceEntry?.kind === "refund_restoration" ||
                sourceEntry?.kind === "dispute_restoration"
              ? "restoration"
              : sourceEntry?.kind === "admin_adjustment" &&
                  sourceEntry.amount > 0 &&
                  sourceEntry.refId.startsWith("promo:")
                ? "promotion"
                : sourceEntry?.kind === "admin_adjustment" &&
                    sourceEntry.amount > 0
                  ? "admin_adjustment"
                  : null;
        if (
          sourceEntry === null ||
          sourceEntry.walletId !== wallet._id ||
          sourceEntry.amount !== lot.grantedCredits ||
          sourceEntry.paymentId !== lot.paymentId ||
          expectedSourceKind !== lot.sourceKind ||
          lot.refundable !==
            (lot.sourceKind === "stripe_payment" ||
              lot.sourceKind === "restoration")
        ) {
          throw new Error("Root funding source lost ledger provenance");
        }
        verify.rootGranted = safeAdd(
          verify.rootGranted,
          lot.grantedCredits,
          "Root funding grants",
        );
      }
      verify.available = safeAdd(
        verify.available,
        lot.availableCredits,
        "Funding availability",
      );
      if (lot.refundable) {
        verify.refundableAvailable = safeAdd(
          verify.refundableAvailable,
          lot.availableCredits,
          "Refundable funding availability",
        );
      } else {
        verify.nonrefundableAvailable = safeAdd(
          verify.nonrefundableAvailable,
          lot.availableCredits,
          "Nonrefundable funding availability",
        );
      }
      verify.lotAllocated = safeAdd(
        verify.lotAllocated,
        lot.allocatedCredits,
        "Lot allocations",
      );
      verify.lotReversed = safeAdd(
        verify.lotReversed,
        lot.reversedCredits,
        "Lot reversals",
      );
    }
    verify.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) verify.stage = "allocations";
  } else if (verify.stage === "allocations") {
    const page = await ctx.db
      .query("walletFundingAllocations")
      .withIndex("by_wallet_created", (q) => q.eq("walletId", wallet._id))
      .order("asc")
      .paginate({
        cursor: verify.cursor,
        numItems: DETAIL_BATCH,
        maximumRowsRead: DETAIL_BATCH * 2,
      });
    for (const allocation of page.page) {
      if (
        allocation.fundingLotId === undefined ||
        allocation.kind === "reservation_debt" ||
        allocation.organizationId !== wallet.organizationId
      ) {
        throw new Error("Wallet allocation lacks funding provenance");
      }
      const lot = await ctx.db.get(allocation.fundingLotId);
      if (lot === null || lot.walletId !== wallet._id) {
        throw new Error("Wallet allocation references another wallet");
      }
      verify.allocationTotal = safeAdd(
        verify.allocationTotal,
        allocation.grossCredits,
        "Funding allocation journal",
      );
    }
    verify.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) verify.stage = "reversals";
  } else {
    const page = await ctx.db
      .query("walletFundingReversals")
      .withIndex("by_wallet_created", (q) => q.eq("walletId", wallet._id))
      .order("asc")
      .paginate({
        cursor: verify.cursor,
        numItems: VERIFY_BATCH,
        maximumRowsRead: VERIFY_BATCH * 2,
      });
    for (const reversal of page.page) {
      const entry = await ctx.db.get(reversal.walletEntryId);
      const linked = await ctx.db
        .query("walletFundingReversals")
        .withIndex("by_wallet_entry", (q) =>
          q.eq("walletEntryId", reversal.walletEntryId),
        )
        .take(2);
      if (
        reversal.organizationId !== wallet.organizationId ||
        reversal.walletId !== wallet._id ||
        reversal.grossCredits <= 0 ||
        linked.length !== 1 ||
        entry === null ||
        entry.walletId !== wallet._id ||
        entry.paymentId !== reversal.paymentId ||
        (entry.kind !== "refund_reversal" &&
          entry.kind !== "dispute_reversal") ||
        entry.amount !== -reversal.grossCredits
      ) {
        throw new Error("Wallet reversal references another organization");
      }
      verify.reversalTotal = safeAdd(
        verify.reversalTotal,
        reversal.grossCredits,
        "Funding reversal journal",
      );
    }
    verify.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) {
      const currentWallet = await ctx.db.get(wallet._id);
      if (currentWallet === null) throw new Error("Wallet disappeared");
      const equations =
        currentWallet.sequence === verify.lastLedgerSequence &&
        currentWallet.balance === verify.ledgerBalance &&
        currentWallet.balance >= 0 &&
        verify.positiveCredits === verify.rootGranted &&
        verify.allocationDebits === verify.allocationTotal &&
        verify.allocationTotal === verify.lotAllocated &&
        verify.reversalDebits === verify.reversalTotal &&
        verify.reversalTotal === verify.lotReversed &&
        verify.available === currentWallet.balance &&
        state.nonrefundableAvailableCredits === verify.nonrefundableAvailable &&
        state.refundableAvailableCredits === verify.refundableAvailable &&
        verify.nonrefundableAvailable + verify.refundableAvailable ===
          verify.available &&
        state.allocatedCredits === verify.allocationTotal &&
        state.reversedCredits === verify.reversalTotal;
      if (!equations)
        throw new Error("Wallet conservation recomputation failed");
      await ctx.db.patch(currentWallet._id, { debtCredits: 0 });
      await ctx.db.patch(state._id, {
        migrationStatus: "verified",
        migrationJobId: undefined,
        migrationWatermarkSequence: currentWallet.sequence,
        updatedAt: Date.now(),
      });
      await audit(ctx, job._id, "wallets", wallet._id, "verified", {
        ledgerSequence: verify.lastLedgerSequence,
        balance: verify.ledgerBalance,
        positiveCredits: verify.positiveCredits,
        nonrefundableAvailableCredits: verify.nonrefundableAvailable,
        refundableAvailableCredits: verify.refundableAvailable,
        allocatedCredits: verify.allocationTotal,
        reversedCredits: verify.reversalTotal,
      });
      return true;
    }
  }
  await ctx.db.patch(job._id, {
    verificationState: JSON.stringify(verify),
    chunks: job.chunks + 1,
    rowsRead: job.rowsRead + 1,
    updatedAt: Date.now(),
  });
  await scheduleNext(ctx, job._id);
  return false;
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
        numItems: SCOPE_BATCH,
        maximumRowsRead: 2,
      });
    const wallet = page.page[0];
    if (wallet === undefined) {
      await ctx.db.patch(job._id, {
        phase: "clawbacks",
        tableCursor: undefined,
        detailCursor: undefined,
        subphase: undefined,
        activeSequence: 0,
        verificationState: undefined,
        updatedAt: Date.now(),
      });
      await scheduleNext(ctx, job._id);
      return;
    }
    const state = await ensureWalletFence(ctx, job, wallet);
    await ctx.db.patch(job._id, {
      activeWalletId: wallet._id,
      activeSequence: state.migrationWatermarkSequence ?? 0,
      tableCursor: page.continueCursor,
      subphase: "replay",
      verificationState: undefined,
      chunks: job.chunks + 1,
      updatedAt: Date.now(),
    });
    await scheduleNext(ctx, job._id);
    return;
  }

  const wallet = await ctx.db.get(job.activeWalletId);
  if (wallet === null) throw new Error("Migration wallet disappeared");
  if (job.subphase === "verify") {
    if (!(await verifyWalletChunk(ctx, job, wallet))) return;
    await ctx.db.patch(job._id, {
      activeWalletId: undefined,
      activeSequence: 0,
      subphase: undefined,
      verificationState: undefined,
      rowsWritten: job.rowsWritten + 2,
      chunks: job.chunks + 1,
      updatedAt: Date.now(),
    });
    await scheduleNext(ctx, job._id);
    return;
  }

  const entries = await ctx.db
    .query("walletEntries")
    .withIndex("by_wallet_sequence", (q) =>
      q.eq("walletId", wallet._id).gt("sequence", job.activeSequence ?? 0),
    )
    .order("asc")
    .take(DETAIL_BATCH);
  let written = 0;
  for (const entry of entries) {
    written += await migrateWalletEntry(ctx, job, wallet, entry);
  }
  const activeSequence = entries.at(-1)?.sequence ?? job.activeSequence ?? 0;
  const currentWallet = await ctx.db.get(wallet._id);
  if (currentWallet === null) throw new Error("Migration wallet disappeared");
  const caughtUp =
    entries.length < DETAIL_BATCH && activeSequence === currentWallet.sequence;
  await ctx.db.patch(job._id, {
    activeSequence,
    subphase: caughtUp ? "verify" : "replay",
    verificationState: caughtUp
      ? JSON.stringify(emptyWalletVerify())
      : undefined,
    rowsRead: job.rowsRead + entries.length,
    rowsWritten: job.rowsWritten + written,
    chunks: job.chunks + 1,
    updatedAt: Date.now(),
  });
  await scheduleNext(ctx, job._id);
}

type PaymentSource = {
  kind: "refund" | "dispute";
  walletCredits: number;
  publisherCredits: number;
  createdAt: number;
  amount?: number;
  requestedCredits?: number;
  status?: Doc<"paymentExposures">["sourceStatus"];
  active?: boolean;
};

type PaymentBuild = {
  stage: "reversals" | "restorations" | "clawbacks" | "finalize";
  cursor: string | null;
  sources: Record<string, PaymentSource>;
  finalizeIndex?: number;
};

function sourceFor(
  state: PaymentBuild,
  sourceRef: string,
  kind: "refund" | "dispute",
  createdAt: number,
): PaymentSource {
  const existing = state.sources[sourceRef];
  if (existing !== undefined) {
    if (existing.kind !== kind) {
      throw new Error("Payment source kind changed during migration");
    }
    existing.createdAt = Math.min(existing.createdAt, createdAt);
    return existing;
  }
  if (Object.keys(state.sources).length >= MAX_PAYMENT_SOURCES) {
    throw new Error("Payment exceeds bounded exposure source cap");
  }
  const created: PaymentSource = {
    kind,
    walletCredits: 0,
    publisherCredits: 0,
    createdAt,
  };
  state.sources[sourceRef] = created;
  return created;
}

function reversalSourceRef(entry: Doc<"walletEntries">): string {
  const marker = entry.refId.indexOf(":wallet:");
  if (marker <= 0) {
    throw new Error("Legacy wallet reversal lacks source-specific reference");
  }
  return entry.refId.slice(0, marker);
}

async function bindLegacyClawbackAllocation(
  ctx: MutationCtx,
  row: Doc<"publisherClawbacks">,
): Promise<Doc<"publisherClawbacks">> {
  const restoredGrossCredits = row.restoredGrossCredits ?? 0;
  const restoredAtoms = row.restoredAtoms ?? 0;
  const expectedAtoms = publisherEarningSplit(
    row.grossCredits,
  ).publisherNetAtoms;
  if (
    row.grossCredits <= 0 ||
    restoredGrossCredits < 0 ||
    restoredGrossCredits > row.grossCredits ||
    row.amountAtoms !== expectedAtoms ||
    restoredAtoms !==
      publisherEarningSplit(restoredGrossCredits).publisherNetAtoms
  ) {
    throw new Error("Legacy publisher clawback has inexact atom provenance");
  }
  if (row.allocationId !== undefined) {
    const allocation = await ctx.db.get(row.allocationId);
    if (
      allocation === null ||
      allocation.paymentId !== row.paymentId ||
      allocation.earningId !== row.earningId ||
      allocation.organizationId !== row.consumerOrganizationId ||
      allocation.kind !== "usage" ||
      row.grossCredits > allocation.grossCredits
    ) {
      throw new Error("Publisher clawback allocation linkage is invalid");
    }
    return row;
  }

  const activeGrossCredits = row.grossCredits - restoredGrossCredits;
  const allocations = await ctx.db
    .query("walletFundingAllocations")
    .withIndex("by_earning", (q) => q.eq("earningId", row.earningId))
    .take(25);
  const candidates = allocations.filter(
    (allocation) =>
      allocation.paymentId === row.paymentId &&
      allocation.organizationId === row.consumerOrganizationId &&
      allocation.kind === "usage" &&
      allocation.fundingLotId !== undefined &&
      allocation.grossCredits >= row.grossCredits &&
      allocation.grossCredits - allocation.clawedBackGrossCredits >=
        activeGrossCredits,
  );
  if (candidates.length !== 1) {
    throw new Error(
      "Legacy publisher clawback allocation requires exact reconciliation",
    );
  }
  const allocation = candidates[0]!;
  const earning = await ctx.db.get(row.earningId);
  if (
    earning === null ||
    earning.publisherOrganizationId !== row.publisherOrganizationId
  ) {
    throw new Error("Publisher clawback earning linkage is invalid");
  }
  const rollup = await ctx.db
    .query("fundingAllocationRollups")
    .withIndex("by_lot_publisher", (q) =>
      q
        .eq("fundingLotId", allocation.fundingLotId!)
        .eq("publisherOrganizationId", row.publisherOrganizationId),
    )
    .unique();
  if (rollup === null) {
    throw new Error("Publisher clawback funding rollup is missing");
  }
  await ctx.db.patch(allocation._id, {
    clawedBackGrossCredits:
      allocation.clawedBackGrossCredits + activeGrossCredits,
  });
  await ctx.db.patch(rollup._id, {
    clawedBackGrossCredits: rollup.clawedBackGrossCredits + activeGrossCredits,
    updatedAt: Date.now(),
  });
  await ctx.db.patch(row._id, {
    allocationId: allocation._id,
    restoredGrossCredits,
    restoredAtoms,
    state: activeGrossCredits === 0 ? "restored" : "active",
    updatedAt: Date.now(),
  });
  return {
    ...row,
    allocationId: allocation._id,
    restoredGrossCredits,
    restoredAtoms,
    state: activeGrossCredits === 0 ? "restored" : "active",
  };
}

async function finalizePaymentMigration(
  ctx: MutationCtx,
  job: Doc<"financialMigrationJobs">,
  payment: Doc<"payments">,
  state: PaymentBuild,
): Promise<boolean> {
  const existingExposures = await ctx.db
    .query("paymentExposures")
    .withIndex("by_payment_created", (q) => q.eq("paymentId", payment._id))
    .order("asc")
    .take(MAX_PAYMENT_SOURCES + 1);
  if (existingExposures.length > MAX_PAYMENT_SOURCES) {
    throw new Error("Payment exceeds bounded exposure source cap");
  }
  for (const exposure of existingExposures) {
    const source = sourceFor(
      state,
      exposure.sourceRef,
      exposure.sourceKind,
      exposure.createdAt,
    );
    if (exposure.sourceAmountExact === true) {
      source.amount = exposure.sourceAmount;
      source.requestedCredits = exposure.requestedCredits;
      source.status = exposure.sourceStatus;
      source.active = exposure.active;
    }
  }

  const disputes = await ctx.db
    .query("paymentDisputes")
    .withIndex("by_payment", (q) => q.eq("paymentId", payment._id))
    .take(MAX_PAYMENT_SOURCES + 1);
  if (disputes.length > MAX_PAYMENT_SOURCES) {
    throw new Error("Payment exceeds bounded dispute source cap");
  }
  for (const dispute of disputes) {
    const source = sourceFor(
      state,
      `stripe:dispute:${dispute.stripeDisputeId}`,
      "dispute",
      dispute.createdAt,
    );
    source.amount = dispute.amount;
    source.requestedCredits = dispute.creditsAtRisk;
    source.active = dispute.fundsWithdrawn && !dispute.fundsReinstated;
  }

  const refunds = Object.entries(state.sources).filter(
    ([, source]) => source.kind === "refund",
  );
  for (const [sourceRef, source] of refunds) {
    if (source.amount === undefined || source.status === undefined) {
      if (refunds.length !== 1 || payment.refundedAmount <= 0) {
        throw new Error(
          `Refund source ${sourceRef} requires Stripe provider reconciliation`,
        );
      }
      source.amount = payment.refundedAmount;
      source.requestedCredits = payment.refundedCredits;
      source.status = "succeeded";
      source.active = true;
    }
  }
  if (payment.refundedAmount > 0 && refunds.length === 0) {
    throw new Error("Refunded payment has no exact source provenance");
  }

  const ordered = Object.entries(state.sources).sort((left, right) => {
    if (left[1].kind !== right[1].kind) {
      return left[1].kind === "refund" ? -1 : 1;
    }
    return (
      left[1].createdAt - right[1].createdAt || left[0].localeCompare(right[0])
    );
  });
  let cap = payment.grantedCredits;
  let activeRefundAmount = 0;
  let activeRefundCredits = 0;
  let reversed = 0;
  let walletReversed = 0;
  let publisherReversed = 0;
  const projections: Array<{
    sourceRef: string;
    source: PaymentSource & {
      amount: number;
      requestedCredits: number;
      active: boolean;
    };
    effective: number;
  }> = [];
  for (const [sourceRef, source] of ordered) {
    if (
      source.amount === undefined ||
      source.requestedCredits === undefined ||
      source.active === undefined ||
      (source.kind === "refund" && source.status === undefined)
    ) {
      throw new Error(`Payment source ${sourceRef} is not exact`);
    }
    let requestedEffective = 0;
    if (source.active && source.kind === "refund") {
      activeRefundAmount = Math.min(
        payment.amount,
        safeAdd(activeRefundAmount, source.amount, "Active refund amount"),
      );
      const cumulativeCredits = Math.min(
        payment.grantedCredits,
        Math.floor(
          (payment.grantedCredits * activeRefundAmount) / payment.amount,
        ),
      );
      requestedEffective = cumulativeCredits - activeRefundCredits;
      activeRefundCredits = cumulativeCredits;
    } else if (source.active) {
      requestedEffective = source.requestedCredits;
    }
    const effective = Math.min(requestedEffective, cap);
    cap -= effective;
    if (effective !== source.walletCredits + source.publisherCredits) {
      throw new Error(`Payment source ${sourceRef} exposure does not conserve`);
    }
    reversed += effective;
    walletReversed += source.walletCredits;
    publisherReversed += source.publisherCredits;
    projections.push({
      sourceRef,
      source: source as PaymentSource & {
        amount: number;
        requestedCredits: number;
        active: boolean;
      },
      effective,
    });
  }
  if (walletReversed + publisherReversed !== reversed) {
    throw new Error("Payment aggregate reversal does not conserve sources");
  }

  const projection = projections[state.finalizeIndex ?? 0];
  if (projection !== undefined) {
    const { sourceRef, source, effective } = projection;
    const existing = existingExposures.find(
      (exposure) => exposure.sourceRef === sourceRef,
    );
    const payload = {
      sourceAmount: source.amount,
      sourceAmountExact: true,
      sourceStatus: source.kind === "refund" ? source.status : undefined,
      migrationBackfilled: false,
      requestedCredits: source.requestedCredits,
      effectiveCredits: effective,
      walletCredits: source.walletCredits,
      publisherCredits: source.publisherCredits,
      appliedPublisherCredits: source.publisherCredits,
      allocationCursor: undefined,
      active: source.active,
      updatedAt: Date.now(),
    } as const;
    if (existing === undefined) {
      await ctx.db.insert("paymentExposures", {
        paymentId: payment._id,
        organizationId: payment.organizationId,
        sourceKind: source.kind,
        sourceRef,
        ...payload,
        createdAt: source.createdAt,
      });
    } else {
      await ctx.db.patch(existing._id, payload);
    }
    state.finalizeIndex = (state.finalizeIndex ?? 0) + 1;
    return false;
  }
  const wallet = await ctx.db
    .query("wallets")
    .withIndex("by_organization", (q) =>
      q.eq("organizationId", payment.organizationId),
    )
    .unique();
  if (wallet === null) throw new Error("Payment wallet is missing");
  await ctx.db.patch(payment._id, {
    refundedAmount: activeRefundAmount,
    refundedCredits: activeRefundCredits,
    reversedCredits: reversed,
    walletReversedCredits: walletReversed,
    publisherClawbackTargetCredits: publisherReversed,
    reversalSequence: Math.max(payment.reversalSequence ?? 0, wallet.sequence),
    financeMigrationStatus: "verified",
    financeMigrationJobId: undefined,
    status: paymentStatusForProjection({
      grantedCredits: payment.grantedCredits,
      refundedCredits: activeRefundCredits,
      disputes,
    }),
    updatedAt: Date.now(),
  });
  await audit(ctx, job._id, "payments", payment._id, "verified", {
    sourceCount: ordered.length,
    reversedCredits: reversed,
    walletReversedCredits: walletReversed,
    publisherCredits: publisherReversed,
  });
  return true;
}

async function runPaymentChunk(
  ctx: MutationCtx,
  job: Doc<"financialMigrationJobs">,
): Promise<void> {
  if (job.activePaymentId === undefined) {
    const page = await ctx.db
      .query("payments")
      .order("asc")
      .paginate({
        cursor: job.tableCursor ?? null,
        numItems: SCOPE_BATCH,
        maximumRowsRead: 2,
      });
    const payment = page.page[0];
    if (payment === undefined) {
      await ctx.db.patch(job._id, {
        phase: "publishers",
        tableCursor: undefined,
        detailCursor: undefined,
        subphase: undefined,
        verificationState: undefined,
        updatedAt: Date.now(),
      });
      await scheduleNext(ctx, job._id);
      return;
    }
    if (
      payment.financeMigrationStatus === "building" &&
      payment.financeMigrationJobId !== job._id
    ) {
      throw new Error("Payment is fenced by another migration job");
    }
    await ctx.db.patch(payment._id, {
      financeMigrationStatus: "building",
      financeMigrationJobId: job._id,
      updatedAt: Date.now(),
    });
    const state: PaymentBuild = {
      stage: "reversals",
      cursor: null,
      sources: {},
    };
    await ctx.db.patch(job._id, {
      activePaymentId: payment._id,
      tableCursor: page.continueCursor,
      verificationState: JSON.stringify(state),
      chunks: job.chunks + 1,
      updatedAt: Date.now(),
    });
    await scheduleNext(ctx, job._id);
    return;
  }
  const payment = await ctx.db.get(job.activePaymentId);
  if (payment === null) throw new Error("Migration payment disappeared");
  const state = parseState<PaymentBuild>(job.verificationState, {
    stage: "reversals",
    cursor: null,
    sources: {},
  });
  if (state.stage === "reversals") {
    const page = await ctx.db
      .query("walletFundingReversals")
      .withIndex("by_payment_created", (q) => q.eq("paymentId", payment._id))
      .order("asc")
      .paginate({
        cursor: state.cursor,
        numItems: DETAIL_BATCH,
        maximumRowsRead: DETAIL_BATCH * 2,
      });
    for (const reversal of page.page) {
      const entry = await ctx.db.get(reversal.walletEntryId);
      if (entry === null || entry.paymentId !== payment._id) {
        throw new Error("Payment reversal journal lost ledger linkage");
      }
      const kind =
        entry.kind === "refund_reversal"
          ? "refund"
          : entry.kind === "dispute_reversal"
            ? "dispute"
            : null;
      if (kind === null) throw new Error("Payment reversal kind is invalid");
      const source = sourceFor(
        state,
        reversalSourceRef(entry),
        kind,
        reversal.createdAt,
      );
      source.walletCredits = safeAdd(
        source.walletCredits,
        reversal.grossCredits,
        "Payment wallet source",
      );
    }
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) state.stage = "restorations";
  } else if (state.stage === "restorations") {
    const page = await ctx.db
      .query("walletFundingLots")
      .withIndex("by_payment_created", (q) => q.eq("paymentId", payment._id))
      .order("asc")
      .paginate({
        cursor: state.cursor,
        numItems: DETAIL_BATCH,
        maximumRowsRead: DETAIL_BATCH * 2,
      });
    for (const lot of page.page) {
      if (lot.sourceKind !== "restoration") continue;
      const entry = await ctx.db
        .query("walletEntries")
        .withIndex("by_ref", (q) => q.eq("refId", lot.sourceRef))
        .unique();
      if (
        entry === null ||
        entry.paymentId !== payment._id ||
        (entry.kind !== "refund_restoration" &&
          entry.kind !== "dispute_restoration") ||
        entry.amount !== lot.grantedCredits
      ) {
        throw new Error("Payment restoration lost exact ledger provenance");
      }
      const source = sourceFor(
        state,
        reversalSourceRef(entry),
        entry.kind === "refund_restoration" ? "refund" : "dispute",
        entry.createdAt,
      );
      source.walletCredits -= lot.grantedCredits;
      if (source.walletCredits < 0) {
        throw new Error("Payment restoration exceeds source wallet reversal");
      }
    }
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) state.stage = "clawbacks";
  } else if (state.stage === "clawbacks") {
    const page = await ctx.db
      .query("publisherClawbacks")
      .withIndex("by_payment", (q) => q.eq("paymentId", payment._id))
      .order("asc")
      .paginate({
        cursor: state.cursor,
        numItems: DETAIL_BATCH,
        maximumRowsRead: DETAIL_BATCH * 2,
      });
    for (const unbound of page.page) {
      const row = await bindLegacyClawbackAllocation(ctx, unbound);
      const restoredGrossCredits = row.restoredGrossCredits ?? 0;
      const restoredAtoms = row.restoredAtoms ?? 0;
      const activeGrossCredits = row.grossCredits - restoredGrossCredits;
      if (
        restoredGrossCredits < 0 ||
        activeGrossCredits < 0 ||
        restoredAtoms < 0 ||
        restoredAtoms > row.amountAtoms ||
        row.consumerOrganizationId !== payment.organizationId
      ) {
        throw new Error("Publisher clawback conservation failed");
      }
      const source = sourceFor(
        state,
        row.sourceRef,
        row.sourceKind,
        row.createdAt,
      );
      source.publisherCredits = safeAdd(
        source.publisherCredits,
        activeGrossCredits,
        "Payment publisher source",
      );
      await ctx.db.patch(row._id, {
        restoredGrossCredits,
        restoredAtoms,
        state: activeGrossCredits === 0 ? "restored" : "active",
        updatedAt: Date.now(),
      });
    }
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) state.stage = "finalize";
  } else {
    if (!(await finalizePaymentMigration(ctx, job, payment, state))) {
      await ctx.db.patch(job._id, {
        verificationState: JSON.stringify(state),
        rowsWritten: job.rowsWritten + 1,
        chunks: job.chunks + 1,
        updatedAt: Date.now(),
      });
      await scheduleNext(ctx, job._id);
      return;
    }
    await ctx.db.patch(job._id, {
      activePaymentId: undefined,
      verificationState: undefined,
      rowsWritten: job.rowsWritten + 1,
      chunks: job.chunks + 1,
      updatedAt: Date.now(),
    });
    await scheduleNext(ctx, job._id);
    return;
  }
  await ctx.db.patch(job._id, {
    verificationState: JSON.stringify(state),
    rowsRead: job.rowsRead + 1,
    chunks: job.chunks + 1,
    updatedAt: Date.now(),
  });
  await scheduleNext(ctx, job._id);
}

type PublisherBuild = {
  stage: "entries" | "earnings" | "transfers";
  cursor: string | null;
  sequence: number;
  available: number;
  allocated: number;
  paid: number;
  pending: number;
  reversed: number;
  failed: number;
};

const emptyPublisherBuild = (): PublisherBuild => ({
  stage: "entries",
  cursor: null,
  sequence: 0,
  available: 0,
  allocated: 0,
  paid: 0,
  pending: 0,
  reversed: 0,
  failed: 0,
});

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
        numItems: SCOPE_BATCH,
        maximumRowsRead: 2,
      });
    const balance = page.page[0];
    if (balance === undefined) {
      await ctx.db.patch(job._id, {
        phase: "transfers",
        tableCursor: undefined,
        detailCursor: undefined,
        verificationState: undefined,
        updatedAt: Date.now(),
      });
      await scheduleNext(ctx, job._id);
      return;
    }
    await ensurePublisherFence(ctx, job, balance.publisherOrganizationId);
    await ctx.db.patch(job._id, {
      activePublisherOrganizationId: balance.publisherOrganizationId,
      tableCursor: page.continueCursor,
      verificationState: JSON.stringify(emptyPublisherBuild()),
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
  if (
    balance === null ||
    balance.migrationStatus !== "building" ||
    balance.migrationJobId !== job._id
  ) {
    throw new Error("Publisher migration fence is missing");
  }
  const state = parseState(job.verificationState, emptyPublisherBuild());
  if (state.stage === "entries") {
    const entries = await ctx.db
      .query("publisherSettlementEntries")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", orgId).gt("sequence", state.sequence),
      )
      .order("asc")
      .take(DETAIL_BATCH);
    for (const entry of entries) {
      if (
        entry.sequence !== state.sequence + 1 ||
        entry.publisherBalanceId !== balance._id
      ) {
        throw new Error("Publisher settlement sequence is not contiguous");
      }
      state.sequence = entry.sequence;
      state.available = safeAdd(
        state.available,
        entry.availableDeltaAtoms,
        "Publisher available ledger",
      );
      state.allocated = safeAdd(
        state.allocated,
        entry.allocatedDeltaAtoms,
        "Publisher allocated ledger",
      );
      state.paid = safeAdd(
        state.paid,
        entry.paidDeltaAtoms,
        "Publisher paid ledger",
      );
    }
    if (entries.length < DETAIL_BATCH) {
      if (balance.sequence !== state.sequence) {
        await ctx.db.patch(job._id, {
          verificationState: JSON.stringify(state),
          chunks: job.chunks + 1,
          updatedAt: Date.now(),
        });
        await scheduleNext(ctx, job._id);
        return;
      }
      state.stage = "earnings";
      state.cursor = null;
    }
  } else if (state.stage === "earnings") {
    const page = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_publisher", (q) => q.eq("publisherOrganizationId", orgId))
      .order("asc")
      .paginate({
        cursor: state.cursor,
        numItems: VERIFY_BATCH,
        maximumRowsRead: VERIFY_BATCH * 2,
      });
    for (const earning of page.page) {
      if (earning.projectId === undefined) {
        throw new Error("Publisher earning lacks project provenance");
      }
      const project = await ctx.db.get(earning.projectId);
      if (
        project === null ||
        project.organizationId !== earning.publisherOrganizationId
      ) {
        throw new Error("Publisher earning project ownership is invalid");
      }
      await ctx.db.patch(earning._id, {
        projectName: project.name,
        projectSlug: project.slug,
      });
      if (
        earning.platformFeeAtoms + earning.publisherNetAtoms !==
          earning.grossCredits * ACCOUNTING_ATOMS_PER_CREDIT ||
        earning.clawedBackGrossCredits < 0 ||
        earning.clawedBackGrossCredits > earning.grossCredits ||
        earning.clawedBackAtoms < 0 ||
        earning.clawedBackAtoms > earning.publisherNetAtoms
      ) {
        throw new Error("Publisher earning atom conservation failed");
      }
      if (earning.status === "pending_risk") {
        state.pending = safeAdd(
          state.pending,
          earning.publisherNetAtoms - earning.clawedBackAtoms,
          "Publisher pending risk",
        );
      }
      state.reversed = safeAdd(
        state.reversed,
        earning.clawedBackAtoms,
        "Publisher reversed aggregate",
      );
    }
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) state.stage = "transfers";
  } else {
    const page = await ctx.db
      .query("publisherTransfers")
      .withIndex("by_publisher", (q) => q.eq("publisherOrganizationId", orgId))
      .order("asc")
      .paginate({
        cursor: state.cursor,
        numItems: VERIFY_BATCH,
        maximumRowsRead: VERIFY_BATCH * 2,
      });
    for (const transfer of page.page) {
      if (transfer.status === "failed") {
        state.failed = safeAdd(
          state.failed,
          transfer.amountAtoms,
          "Publisher failed aggregate",
        );
      }
    }
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) {
      const current = await ctx.db.get(balance._id);
      if (current === null || current.sequence !== state.sequence) {
        throw new Error("Publisher ledger advanced during fenced verification");
      }
      if (state.allocated < 0 || state.paid < 0) {
        throw new Error("Publisher materialized bucket is negative");
      }
      await ctx.db.patch(balance._id, {
        availableAtoms: state.available,
        allocatedAtoms: state.allocated,
        paidAtoms: state.paid,
        pendingRiskAtoms: state.pending,
        reversedAtoms: state.reversed,
        failedAtoms: state.failed,
        sequence: state.sequence,
        migrationStatus: "verified",
        migrationJobId: undefined,
        migrationWatermarkSequence: state.sequence,
        updatedAt: Date.now(),
      });
      await audit(ctx, job._id, "publishers", orgId, "verified", {
        ledgerSequence: state.sequence,
        availableAtoms: state.available,
        allocatedAtoms: state.allocated,
        paidAtoms: state.paid,
        pendingRiskAtoms: state.pending,
        reversedAtoms: state.reversed,
        failedAtoms: state.failed,
      });
      await ctx.db.patch(job._id, {
        activePublisherOrganizationId: undefined,
        verificationState: undefined,
        rowsWritten: job.rowsWritten + 1,
        chunks: job.chunks + 1,
        updatedAt: Date.now(),
      });
      await scheduleNext(ctx, job._id);
      return;
    }
  }
  await ctx.db.patch(job._id, {
    verificationState: JSON.stringify(state),
    rowsRead: job.rowsRead + 1,
    chunks: job.chunks + 1,
    updatedAt: Date.now(),
  });
  await scheduleNext(ctx, job._id);
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
        numItems: SCOPE_BATCH,
        maximumRowsRead: 2,
      });
    const transfer = page.page[0];
    if (transfer === undefined) {
      await ctx.db.patch(job._id, {
        phase: "conservation",
        tableCursor: undefined,
        activeSequence: 0,
        verificationState: undefined,
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
      accumulatorB: 0,
      accumulatorC: 0,
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
    .take(DETAIL_BATCH);
  let reversedAtoms = job.accumulatorA;
  let allocatedAtoms = job.accumulatorB;
  let succeededAtoms = job.accumulatorC;
  for (const entry of entries) {
    if (entry.publisherOrganizationId !== transfer.publisherOrganizationId) {
      throw new Error("Transfer ledger references another publisher");
    }
    if (entry.kind === "transfer_allocation") {
      if (
        allocatedAtoms !== 0 ||
        entry.availableDeltaAtoms !== -transfer.amountAtoms ||
        entry.allocatedDeltaAtoms !== transfer.amountAtoms ||
        entry.paidDeltaAtoms !== 0
      ) {
        throw new Error("Transfer allocation ledger is not exact");
      }
      allocatedAtoms = transfer.amountAtoms;
    } else if (entry.kind === "transfer_succeeded") {
      if (
        succeededAtoms !== 0 ||
        entry.availableDeltaAtoms !== 0 ||
        entry.allocatedDeltaAtoms !== -transfer.amountAtoms ||
        entry.paidDeltaAtoms !== transfer.amountAtoms
      ) {
        throw new Error("Transfer success ledger is not exact");
      }
      succeededAtoms = transfer.amountAtoms;
    } else if (entry.kind === "transfer_failed") {
      if (
        entry.availableDeltaAtoms !== transfer.amountAtoms ||
        entry.allocatedDeltaAtoms !== -transfer.amountAtoms ||
        entry.paidDeltaAtoms !== 0
      ) {
        throw new Error("Transfer failure ledger is not exact");
      }
      if (succeededAtoms !== 0) {
        throw new Error("Failed transfer has a success ledger entry");
      }
    } else if (entry.kind === "transfer_reversal") {
      if (
        entry.availableDeltaAtoms !== -entry.paidDeltaAtoms ||
        entry.allocatedDeltaAtoms !== 0 ||
        entry.paidDeltaAtoms >= 0
      ) {
        throw new Error("Transfer reversal ledger is not exact");
      }
      reversedAtoms = safeAdd(
        reversedAtoms,
        -entry.paidDeltaAtoms,
        "Transfer reversals",
      );
    } else {
      throw new Error("Transfer ledger contains an invalid entry kind");
    }
  }
  if (entries.length === DETAIL_BATCH) {
    await ctx.db.patch(job._id, {
      activeSequence: entries.at(-1)!.sequence,
      accumulatorA: reversedAtoms,
      accumulatorB: allocatedAtoms,
      accumulatorC: succeededAtoms,
      rowsRead: job.rowsRead + entries.length,
      chunks: job.chunks + 1,
      updatedAt: Date.now(),
    });
    await scheduleNext(ctx, job._id);
    return;
  }
  if (
    reversedAtoms % ACCOUNTING_ATOMS_PER_USD_CENT !== 0 ||
    reversedAtoms < 0 ||
    reversedAtoms > transfer.amountAtoms
  ) {
    throw new Error("Transfer reversal is not exact whole-cent conservation");
  }
  const reversedAmount = reversedAtoms / ACCOUNTING_ATOMS_PER_USD_CENT;
  if (
    transfer.amountAtoms !==
    transfer.amount * ACCOUNTING_ATOMS_PER_USD_CENT
  ) {
    throw new Error("Transfer amount atom snapshot is not exact");
  }
  if (
    transfer.remainderAtoms < 0 ||
    transfer.remainderAtoms >= ACCOUNTING_ATOMS_PER_USD_CENT ||
    allocatedAtoms !== transfer.amountAtoms ||
    (transfer.status === "succeeded" || transfer.status === "reversed") !==
      (succeededAtoms === transfer.amountAtoms) ||
    (transfer.status === "reversed" && reversedAmount !== transfer.amount) ||
    (transfer.status !== "reversed" && reversedAmount === transfer.amount)
  ) {
    throw new Error("Transfer ledger does not conserve its exact allocation");
  }

  const secret = transferSecret();
  const platform = platformAccountId();
  let providerCreateMetadataShape = transfer.providerCreateMetadataShape;
  if (providerCreateMetadataShape === undefined) {
    const correlationFieldCount = [
      transfer.correlationNonce,
      transfer.correlationHmac,
      transfer.platformAccountId,
    ].filter((value) => value !== undefined).length;
    if (correlationFieldCount === 0) {
      providerCreateMetadataShape = "publisher_only";
    } else if (correlationFieldCount === 3) {
      providerCreateMetadataShape =
        transfer.metadataRepairVersion === 1
          ? "correlated_v1"
          : "correlated_v0";
    } else {
      throw new Error("Transfer original provider metadata shape is ambiguous");
    }
  }
  let correlationNonce = transfer.correlationNonce;
  let correlationHmac = transfer.correlationHmac;
  let transferPlatform = transfer.platformAccountId;
  if (providerCreateMetadataShape === "publisher_only") {
    correlationNonce ??= await sha256Hex(
      `${MIGRATION_KEY}:${secret}:${transfer._id}`,
    );
    transferPlatform ??= platform;
    if (transferPlatform !== platform) {
      throw new Error("Legacy transfer platform account changed");
    }
    const expectedHmac = await signTransferCorrelation(secret, {
      publisherTransferId: transfer._id,
      nonce: correlationNonce,
      platformAccountId: transferPlatform,
      destination: transfer.stripeConnectedAccountId,
      currency: transfer.currency,
      amount: transfer.amount,
    });
    if (correlationHmac !== undefined && correlationHmac !== expectedHmac) {
      throw new Error("Legacy transfer generated correlation changed");
    }
    correlationHmac = expectedHmac;
  } else if (
    correlationNonce === undefined ||
    correlationHmac === undefined ||
    transferPlatform !== platform ||
    !(await verifyTransferCorrelation(
      secret,
      {
        publisherTransferId: transfer._id,
        nonce: correlationNonce,
        platformAccountId: platform,
        destination: transfer.stripeConnectedAccountId,
        currency: transfer.currency,
        amount: transfer.amount,
      },
      correlationHmac,
    ))
  ) {
    throw new Error("Pre-version transfer correlation is invalid");
  }
  let result: AuditResult = "verified";
  let correlationState = transfer.correlationState;
  let reconciliationCaseId = transfer.reconciliationCaseId;
  if (
    correlationState !== "provider_verified" ||
    transfer.providerMetadataVerifiedAt === undefined
  ) {
    correlationState = "provider_repair_required";
    result = "checkpoint";
    if (reconciliationCaseId === undefined) {
      reconciliationCaseId = await ctx.db.insert("financeReconciliationCases", {
        kind: "transfer",
        status: "open",
        reason: "legacy_transfer_provider_repair_required",
        organizationId: transfer.publisherOrganizationId,
        transferId: transfer._id,
        candidateIds: transfer.stripeTransferId === undefined
          ? []
          : [transfer.stripeTransferId],
        candidateCount: transfer.stripeTransferId === undefined ? 0 : 1,
        providerRequestIds: [],
        attempts: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  } else if (
    correlationNonce === undefined ||
    correlationHmac === undefined ||
    transfer.metadataRepairVersion !== 1 ||
    !(await verifyTransferCorrelation(
      secret,
      {
        publisherTransferId: transfer._id,
        nonce: correlationNonce,
        platformAccountId: platform,
        destination: transfer.stripeConnectedAccountId,
        currency: transfer.currency,
        amount: transfer.amount,
      },
      correlationHmac,
    ))
  ) {
    throw new Error("Verified transfer correlation is invalid");
  }
  await ctx.db.patch(transfer._id, {
    reversedAmount,
    correlationNonce,
    correlationHmac,
    platformAccountId: transferPlatform,
    correlationState,
    metadataRepairVersion: 1,
    providerCreateMetadataShape,
    reconciliationCaseId,
    status: reversedAmount === transfer.amount ? "reversed" : transfer.status,
    updatedAt: Date.now(),
  });
  await audit(ctx, job._id, "transfers", transfer._id, result, {
    allocatedAtoms,
    succeededAtoms,
    reversedAmount,
    ledgerReversedAtoms: reversedAtoms,
    providerMetadata: result === "verified" ? "verified" : "repair_required",
    stripeTransferId: transfer.stripeTransferId ?? null,
  });
  await ctx.db.patch(job._id, {
    activeTransferId: undefined,
    activeSequence: 0,
    accumulatorA: 0,
    accumulatorB: 0,
    accumulatorC: 0,
    rowsRead: job.rowsRead + entries.length,
    rowsWritten: job.rowsWritten + 1,
    chunks: job.chunks + 1,
    updatedAt: Date.now(),
  });
  await scheduleNext(ctx, job._id);
}

type FinalVerify = {
  stage:
    | "wallets"
    | "payments"
    | "publishers"
    | "transfers"
    | "allocations"
    | "rollups"
    | "usage"
    | "earnings"
    | "exposures"
    | "reconciliations";
  cursor: string | null;
  wallets: number;
  payments: number;
  publishers: number;
  transfers: number;
  allocations: number;
  rollups: number;
  usage: number;
  earnings: number;
  exposures: number;
  activeRollupId?: Id<"fundingAllocationRollups">;
  detailCursor?: string | null;
  rollupAllocated?: number;
  rollupClawedBack?: number;
};

const emptyFinalVerify = (): FinalVerify => ({
  stage: "wallets",
  cursor: null,
  wallets: 0,
  payments: 0,
  publishers: 0,
  transfers: 0,
  allocations: 0,
  rollups: 0,
  usage: 0,
  earnings: 0,
  exposures: 0,
});

async function runConservationChunk(
  ctx: MutationCtx,
  job: Doc<"financialMigrationJobs">,
): Promise<void> {
  const state = parseState(job.verificationState, emptyFinalVerify());
  if (state.stage === "wallets") {
    const page = await ctx.db
      .query("wallets")
      .order("asc")
      .paginate({
        cursor: state.cursor,
        numItems: VERIFY_BATCH,
        maximumRowsRead: VERIFY_BATCH * 2,
      });
    for (const wallet of page.page) {
      const funding = await getFundingState(ctx, wallet._id);
      if (
        funding === null ||
        funding.migrationStatus !== "verified" ||
        funding.migrationWatermarkSequence !== wallet.sequence ||
        wallet.balance < 0 ||
        (wallet.debtCredits ?? 0) !== 0 ||
        funding.nonrefundableAvailableCredits +
          funding.refundableAvailableCredits !==
          wallet.balance
      ) {
        throw new Error(`Wallet ${wallet._id} failed final finance gate`);
      }
      state.wallets += 1;
    }
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) state.stage = "payments";
  } else if (state.stage === "payments") {
    const page = await ctx.db
      .query("payments")
      .order("asc")
      .paginate({
        cursor: state.cursor,
        numItems: SCOPE_BATCH,
        maximumRowsRead: SCOPE_BATCH * 2,
      });
    for (const payment of page.page) {
      const exposures = await ctx.db
        .query("paymentExposures")
        .withIndex("by_payment_created", (q) => q.eq("paymentId", payment._id))
        .take(MAX_PAYMENT_SOURCES + 1);
      const disputes = await ctx.db
        .query("paymentDisputes")
        .withIndex("by_payment", (q) => q.eq("paymentId", payment._id))
        .take(MAX_PAYMENT_SOURCES + 1);
      const paymentLots = await ctx.db
        .query("walletFundingLots")
        .withIndex("by_payment_created", (q) => q.eq("paymentId", payment._id))
        .take(MAX_PAYMENT_SOURCES + 1);
      const grantLots = paymentLots.filter(
        (lot) => lot.sourceKind === "stripe_payment",
      );
      if (
        exposures.length > MAX_PAYMENT_SOURCES ||
        disputes.length > MAX_PAYMENT_SOURCES ||
        paymentLots.length > MAX_PAYMENT_SOURCES
      ) {
        throw new Error("Payment exceeds bounded finance source cap");
      }
      const activeRefundAmount = exposures
        .filter(
          (exposure) =>
            exposure.sourceKind === "refund" &&
            exposure.active &&
            exposure.sourceStatus !== "failed" &&
            exposure.sourceStatus !== "canceled",
        )
        .reduce(
          (sum, exposure) =>
            safeAdd(sum, exposure.sourceAmount, "Refund amount verification"),
          0,
        );
      const refundedCredits = Math.min(
        payment.grantedCredits,
        Math.floor(
          (payment.grantedCredits * activeRefundAmount) / payment.amount,
        ),
      );
      const effectiveCredits = exposures.reduce(
        (sum, exposure) =>
          safeAdd(sum, exposure.effectiveCredits, "Exposure verification"),
        0,
      );
      const walletCredits = exposures.reduce(
        (sum, exposure) =>
          safeAdd(sum, exposure.walletCredits, "Wallet exposure verification"),
        0,
      );
      const publisherCredits = exposures.reduce(
        (sum, exposure) =>
          safeAdd(
            sum,
            exposure.publisherCredits,
            "Publisher exposure verification",
          ),
        0,
      );
      if (
        payment.financeMigrationStatus !== "verified" ||
        payment.financeMigrationJobId !== undefined ||
        payment.amount <= 0 ||
        grantLots.length !== 1 ||
        grantLots[0]!.grantedCredits !== payment.grantedCredits ||
        grantLots[0]!.organizationId !== payment.organizationId ||
        grantLots[0]!.paymentId !== payment._id ||
        payment.stripePaymentIntentId === undefined ||
        grantLots[0]!.sourceRef !==
          `stripe:payment_intent:${payment.stripePaymentIntentId}` ||
        activeRefundAmount > payment.amount ||
        payment.walletReversedCredits === undefined ||
        payment.publisherClawbackTargetCredits === undefined ||
        payment.reversalSequence === undefined ||
        payment.walletReversedCredits +
          payment.publisherClawbackTargetCredits !==
          payment.reversedCredits ||
        activeRefundAmount !== payment.refundedAmount ||
        refundedCredits !== payment.refundedCredits ||
        effectiveCredits !== payment.reversedCredits ||
        walletCredits !== payment.walletReversedCredits ||
        publisherCredits !== payment.publisherClawbackTargetCredits ||
        payment.status !==
          paymentStatusForProjection({
            grantedCredits: payment.grantedCredits,
            refundedCredits,
            disputes,
          }) ||
        exposures.some(
          (exposure) =>
            exposure.sourceAmountExact !== true ||
            !Number.isSafeInteger(exposure.sourceAmount) ||
            exposure.sourceAmount <= 0 ||
            !Number.isSafeInteger(exposure.requestedCredits) ||
            exposure.requestedCredits < 0 ||
            !Number.isSafeInteger(exposure.effectiveCredits) ||
            exposure.effectiveCredits < 0 ||
            exposure.walletCredits < 0 ||
            exposure.publisherCredits < 0 ||
            exposure.appliedPublisherCredits < 0 ||
            exposure.effectiveCredits !==
              exposure.walletCredits + exposure.publisherCredits ||
            (!exposure.active && exposure.effectiveCredits !== 0) ||
            (exposure.sourceKind === "refund" &&
              (exposure.sourceStatus === undefined ||
                exposure.active !==
                  (exposure.sourceStatus !== "failed" &&
                    exposure.sourceStatus !== "canceled"))),
        )
      ) {
        throw new Error(`Payment ${payment._id} failed final finance gate`);
      }
      state.payments += 1;
    }
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) state.stage = "publishers";
  } else if (state.stage === "publishers") {
    const page = await ctx.db
      .query("publisherBalances")
      .order("asc")
      .paginate({
        cursor: state.cursor,
        numItems: VERIFY_BATCH,
        maximumRowsRead: VERIFY_BATCH * 2,
      });
    for (const balance of page.page) {
      if (
        balance.migrationStatus !== "verified" ||
        balance.migrationJobId !== undefined ||
        balance.migrationWatermarkSequence !== balance.sequence ||
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
        throw new Error(
          `Publisher ${balance.publisherOrganizationId} failed final finance gate`,
        );
      }
      state.publishers += 1;
    }
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) state.stage = "transfers";
  } else if (state.stage === "transfers") {
    const page = await ctx.db
      .query("publisherTransfers")
      .order("asc")
      .paginate({
        cursor: state.cursor,
        numItems: VERIFY_BATCH,
        maximumRowsRead: VERIFY_BATCH * 2,
      });
    for (const transfer of page.page) {
      const entries = await ctx.db
        .query("publisherSettlementEntries")
        .withIndex("by_transfer_sequence", (q) =>
          q.eq("transferId", transfer._id),
        )
        .order("asc")
        .take(101);
      if (entries.length > 100) {
        throw new Error("Transfer exceeds bounded ledger source cap");
      }
      const allocations = entries.filter(
        (entry) => entry.kind === "transfer_allocation",
      );
      const successes = entries.filter(
        (entry) => entry.kind === "transfer_succeeded",
      );
      const reversals = entries.filter(
        (entry) => entry.kind === "transfer_reversal",
      );
      const failures = entries.filter(
        (entry) => entry.kind === "transfer_failed",
      );
      const publisherBalance = await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", transfer.publisherOrganizationId),
        )
        .unique();
      const ledgerReversedAtoms = reversals.reduce(
        (sum, entry) =>
          safeAdd(sum, -entry.paidDeltaAtoms, "Transfer final reversals"),
        0,
      );
      const definitiveFailure =
        transfer.status === "failed" &&
        transfer.providerOutcome === "definitive_no_side_effect";
      if (
        (!definitiveFailure &&
          (transfer.correlationState !== "provider_verified" ||
            transfer.providerMetadataVerifiedAt === undefined ||
            transfer.stripeTransferId === undefined)) ||
        transfer.correlationNonce === undefined ||
        transfer.correlationHmac === undefined ||
        transfer.platformAccountId === undefined ||
        transfer.platformAccountId !== platformAccountId() ||
        transfer.metadataRepairVersion !== 1 ||
        transfer.providerCreateMetadataShape === undefined ||
        transfer.reversedAmount === undefined ||
        (definitiveFailure &&
          (failures.length !== 1 ||
            failures[0]!.availableDeltaAtoms !== transfer.amountAtoms ||
            failures[0]!.allocatedDeltaAtoms !== -transfer.amountAtoms)) ||
        (!definitiveFailure && failures.length !== 0) ||
        transfer.currency !== "usd" ||
        transfer.amountAtoms !==
          transfer.amount * ACCOUNTING_ATOMS_PER_USD_CENT ||
        transfer.remainderAtoms < 0 ||
        transfer.remainderAtoms >= ACCOUNTING_ATOMS_PER_USD_CENT ||
        publisherBalance === null ||
        entries.some(
          (entry) =>
            entry.publisherBalanceId !== publisherBalance._id ||
            entry.publisherOrganizationId !==
              transfer.publisherOrganizationId ||
            entry.transferId !== transfer._id,
        ) ||
        allocations.length !== 1 ||
        allocations[0]!.availableDeltaAtoms !== -transfer.amountAtoms ||
        allocations[0]!.allocatedDeltaAtoms !== transfer.amountAtoms ||
        allocations[0]!.paidDeltaAtoms !== 0 ||
        successes.length > 1 ||
        successes.some(
          (entry) =>
            entry.availableDeltaAtoms !== 0 ||
            entry.allocatedDeltaAtoms !== -transfer.amountAtoms ||
            entry.paidDeltaAtoms !== transfer.amountAtoms,
        ) ||
        reversals.some(
          (entry) =>
            entry.availableDeltaAtoms !== -entry.paidDeltaAtoms ||
            entry.allocatedDeltaAtoms !== 0 ||
            entry.paidDeltaAtoms >= 0,
        ) ||
        ledgerReversedAtoms !==
          transfer.reversedAmount * ACCOUNTING_ATOMS_PER_USD_CENT ||
        (transfer.status === "succeeded" || transfer.status === "reversed") !==
          (successes.length === 1) ||
        (transfer.status === "reversed") !==
          (transfer.reversedAmount === transfer.amount) ||
        !(await verifyTransferCorrelation(
          transferSecret(),
          {
            publisherTransferId: transfer._id,
            nonce: transfer.correlationNonce,
            platformAccountId: transfer.platformAccountId,
            destination: transfer.stripeConnectedAccountId,
            currency: transfer.currency,
            amount: transfer.amount,
          },
          transfer.correlationHmac,
        ))
      ) {
        throw new Error(
          `Transfer ${transfer._id} requires Stripe provider metadata proof`,
        );
      }
      state.transfers += 1;
    }
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) state.stage = "allocations";
  } else if (state.stage === "allocations") {
    const page = await ctx.db
      .query("walletFundingAllocations")
      .order("asc")
      .paginate({
        cursor: state.cursor,
        numItems: SCOPE_BATCH,
        maximumRowsRead: SCOPE_BATCH * 2,
      });
    for (const allocation of page.page) {
      if (
        allocation.fundingLotId === undefined ||
        allocation.kind === "reservation_debt" ||
        allocation.clawedBackGrossCredits < 0 ||
        allocation.clawedBackGrossCredits > allocation.grossCredits
      ) {
        throw new Error("Active reconciliation debt remains");
      }
      const clawbacks = await ctx.db
        .query("publisherClawbacks")
        .withIndex("by_allocation", (q) => q.eq("allocationId", allocation._id))
        .take(101);
      const lot =
        allocation.fundingLotId === undefined
          ? null
          : await ctx.db.get(allocation.fundingLotId);
      const walletEntry = await ctx.db.get(allocation.walletEntryId);
      const entryAllocations = await ctx.db
        .query("walletFundingAllocations")
        .withIndex("by_wallet_entry", (q) =>
          q.eq("walletEntryId", allocation.walletEntryId),
        )
        .take(25);
      if (clawbacks.length > 100) {
        throw new Error("Allocation exceeds bounded clawback source cap");
      }
      if (
        lot === null ||
        lot.walletId !== allocation.walletId ||
        lot.organizationId !== allocation.organizationId ||
        lot.paymentId !== allocation.paymentId ||
        walletEntry === null ||
        walletEntry.walletId !== allocation.walletId ||
        allocation.grossCredits <= 0 ||
        entryAllocations.length === 0 ||
        entryAllocations.length > 24 ||
        entryAllocations.reduce(
          (sum, row) =>
            safeAdd(sum, row.grossCredits, "Wallet entry allocation"),
          0,
        ) !== -walletEntry.amount ||
        (allocation.kind === "usage") !==
          (walletEntry.kind === "usage_settlement") ||
        (allocation.kind === "negative_adjustment") !==
          (walletEntry.kind === "admin_adjustment") ||
        (allocation.kind === "usage" &&
          (allocation.usageEventId === undefined ||
            allocation.earningId === undefined ||
            walletEntry.usageEventId !== allocation.usageEventId)) ||
        (allocation.kind === "negative_adjustment" &&
          (allocation.usageEventId !== undefined ||
            allocation.earningId !== undefined)) ||
        clawbacks.some(
          (row) =>
            row.paymentId !== allocation.paymentId ||
            row.earningId !== allocation.earningId ||
            row.consumerOrganizationId !== allocation.organizationId ||
            row.grossCredits <= 0 ||
            (row.restoredGrossCredits ?? 0) < 0 ||
            (row.restoredGrossCredits ?? 0) > row.grossCredits ||
            row.amountAtoms !==
              publisherEarningSplit(row.grossCredits).publisherNetAtoms ||
            (row.restoredAtoms ?? 0) !==
              publisherEarningSplit(row.restoredGrossCredits ?? 0)
                .publisherNetAtoms,
        )
      ) {
        throw new Error("Allocation clawback linkage is not exact");
      }
      const activeClawback = clawbacks.reduce(
        (sum, row) =>
          safeAdd(
            sum,
            row.grossCredits - (row.restoredGrossCredits ?? 0),
            "Allocation clawback recomputation",
          ),
        0,
      );
      if (activeClawback !== allocation.clawedBackGrossCredits) {
        throw new Error("Allocation clawback provenance does not conserve");
      }
      if (allocation.earningId !== undefined) {
        const earning = await ctx.db.get(allocation.earningId);
        if (earning === null) throw new Error("Allocation earning is missing");
        const rollup = await ctx.db
          .query("fundingAllocationRollups")
          .withIndex("by_lot_publisher", (q) =>
            q
              .eq("fundingLotId", allocation.fundingLotId!)
              .eq("publisherOrganizationId", earning.publisherOrganizationId),
          )
          .unique();
        if (
          rollup === null ||
          rollup.paymentId !== allocation.paymentId ||
          rollup.allocatedGrossCredits < allocation.grossCredits ||
          rollup.clawedBackGrossCredits < allocation.clawedBackGrossCredits ||
          rollup.clawedBackGrossCredits > rollup.allocatedGrossCredits
        ) {
          throw new Error("Allocation funding rollup is not verified");
        }
      }
      state.allocations += 1;
    }
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) state.stage = "rollups";
  } else if (state.stage === "rollups") {
    if (state.activeRollupId === undefined) {
      const page = await ctx.db
        .query("fundingAllocationRollups")
        .order("asc")
        .paginate({
          cursor: state.cursor,
          numItems: SCOPE_BATCH,
          maximumRowsRead: SCOPE_BATCH * 2,
        });
      const rollup = page.page[0];
      state.cursor = page.continueCursor;
      if (rollup === undefined) {
        state.cursor = null;
        state.stage = "usage";
      } else {
        state.activeRollupId = rollup._id;
        state.detailCursor = null;
        state.rollupAllocated = 0;
        state.rollupClawedBack = 0;
      }
    } else {
      const rollup = await ctx.db.get(state.activeRollupId);
      if (rollup === null) throw new Error("Funding rollup disappeared");
      const lot = await ctx.db.get(rollup.fundingLotId);
      if (
        lot === null ||
        lot.paymentId !== rollup.paymentId ||
        rollup.allocatedGrossCredits <= 0 ||
        rollup.clawedBackGrossCredits < 0 ||
        rollup.clawedBackGrossCredits > rollup.allocatedGrossCredits
      ) {
        throw new Error("Funding rollup root provenance is invalid");
      }
      const page = await ctx.db
        .query("walletFundingAllocations")
        .withIndex("by_lot_created", (q) =>
          q.eq("fundingLotId", rollup.fundingLotId),
        )
        .order("asc")
        .paginate({
          cursor: state.detailCursor ?? null,
          numItems: DETAIL_BATCH,
          maximumRowsRead: DETAIL_BATCH * 2,
        });
      let allocated = state.rollupAllocated ?? 0;
      let clawedBack = state.rollupClawedBack ?? 0;
      for (const allocation of page.page) {
        if (allocation.earningId === undefined) continue;
        const earning = await ctx.db.get(allocation.earningId);
        if (earning === null)
          throw new Error("Funding rollup earning is missing");
        if (
          earning.publisherOrganizationId === rollup.publisherOrganizationId
        ) {
          allocated = safeAdd(
            allocated,
            allocation.grossCredits,
            "Funding rollup allocations",
          );
          clawedBack = safeAdd(
            clawedBack,
            allocation.clawedBackGrossCredits,
            "Funding rollup clawbacks",
          );
        }
      }
      state.detailCursor = page.isDone ? null : page.continueCursor;
      state.rollupAllocated = allocated;
      state.rollupClawedBack = clawedBack;
      if (page.isDone) {
        if (
          allocated !== rollup.allocatedGrossCredits ||
          clawedBack !== rollup.clawedBackGrossCredits
        ) {
          throw new Error("Funding rollup conservation failed");
        }
        state.rollups += 1;
        state.activeRollupId = undefined;
        state.detailCursor = undefined;
        state.rollupAllocated = undefined;
        state.rollupClawedBack = undefined;
      }
    }
  } else if (state.stage === "usage") {
    const page = await ctx.db
      .query("usageEvents")
      .order("asc")
      .paginate({
        cursor: state.cursor,
        numItems: VERIFY_BATCH,
        maximumRowsRead: VERIFY_BATCH * 2,
      });
    for (const usage of page.page) {
      const project = await ctx.db.get(usage.projectId);
      const wallet = await ctx.db
        .query("wallets")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", usage.organizationId),
        )
        .unique();
      const entry =
        usage.settleRefId === undefined
          ? null
          : await ctx.db
              .query("walletEntries")
              .withIndex("by_ref", (q) => q.eq("refId", usage.settleRefId!))
              .unique();
      const earning =
        usage.settleRefId === undefined
          ? null
          : await ctx.db
              .query("publisherEarnings")
              .withIndex("by_settlement", (q) =>
                q.eq("usageSettlementRefId", usage.settleRefId!),
              )
              .unique();
      if (
        project === null ||
        wallet === null ||
        entry === null ||
        entry.walletId !== wallet._id ||
        entry.kind !== "usage_settlement" ||
        entry.amount !== -usage.credits ||
        entry.usageEventId !== usage._id ||
        earning === null ||
        earning.consumerOrganizationId !== usage.organizationId ||
        earning.publisherOrganizationId !== project.organizationId ||
        earning.projectId !== usage.projectId ||
        earning.grossCredits !== usage.credits ||
        usage.projectName === undefined ||
        usage.projectSlug === undefined ||
        usage.projectName.trim() === "" ||
        usage.projectSlug.trim() === ""
      ) {
        throw new Error(`Usage ${usage._id} lacks verified project identity`);
      }
      state.usage += 1;
    }
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) state.stage = "earnings";
  } else if (state.stage === "earnings") {
    const page = await ctx.db
      .query("publisherEarnings")
      .order("asc")
      .paginate({
        cursor: state.cursor,
        numItems: VERIFY_BATCH,
        maximumRowsRead: VERIFY_BATCH * 2,
      });
    for (const earning of page.page) {
      const split = publisherEarningSplit(earning.grossCredits);
      const project =
        earning.projectId === undefined
          ? null
          : await ctx.db.get(earning.projectId);
      const publisherBalance = await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", earning.publisherOrganizationId),
        )
        .unique();
      const usage = await ctx.db
        .query("usageEvents")
        .withIndex("by_settlement", (q) =>
          q.eq("settleRefId", earning.usageSettlementRefId),
        )
        .unique();
      if (
        earning.projectId === undefined ||
        project === null ||
        project.organizationId !== earning.publisherOrganizationId ||
        publisherBalance === null ||
        publisherBalance.migrationStatus !== "verified" ||
        publisherBalance.migrationWatermarkSequence !==
          publisherBalance.sequence ||
        usage === null ||
        usage.organizationId !== earning.consumerOrganizationId ||
        usage.projectId !== earning.projectId ||
        earning.projectName === undefined ||
        earning.projectSlug === undefined ||
        earning.platformFeeAtoms !== split.platformFeeAtoms ||
        earning.publisherNetAtoms !== split.publisherNetAtoms ||
        earning.platformFeeCredits !== split.platformFeeCredits ||
        earning.netCredits !== split.publisherNetCredits ||
        earning.clawedBackGrossCredits < 0 ||
        earning.clawedBackGrossCredits > earning.grossCredits ||
        earning.clawedBackAtoms !==
          publisherEarningSplit(earning.clawedBackGrossCredits)
            .publisherNetAtoms ||
        earning.releasedAtoms < 0 ||
        earning.releasedAtoms > earning.publisherNetAtoms
      ) {
        throw new Error(`Earning ${earning._id} lacks exact provenance`);
      }
      state.earnings += 1;
    }
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) state.stage = "exposures";
  } else if (state.stage === "exposures") {
    const page = await ctx.db
      .query("paymentExposures")
      .order("asc")
      .paginate({
        cursor: state.cursor,
        numItems: SCOPE_BATCH,
        maximumRowsRead: SCOPE_BATCH * 2,
      });
    for (const exposure of page.page) {
      if (
        exposure.sourceAmountExact !== true ||
        exposure.migrationBackfilled !== false ||
        (exposure.sourceKind === "refund" &&
          exposure.sourceStatus === undefined) ||
        exposure.appliedPublisherCredits !== exposure.publisherCredits
      ) {
        throw new Error(`Exposure ${exposure._id} lacks exact provenance`);
      }
      const clawbacks = await ctx.db
        .query("publisherClawbacks")
        .withIndex("by_source", (q) => q.eq("sourceRef", exposure.sourceRef))
        .take(101);
      if (clawbacks.length > 100) {
        throw new Error("Exposure exceeds bounded clawback source cap");
      }
      const appliedPublisherCredits = clawbacks
        .filter((row) => row.paymentId === exposure.paymentId)
        .reduce(
          (sum, row) =>
            safeAdd(
              sum,
              row.grossCredits - (row.restoredGrossCredits ?? 0),
              "Exposure clawback recomputation",
            ),
          0,
        );
      if (appliedPublisherCredits !== exposure.appliedPublisherCredits) {
        throw new Error("Exposure publisher provenance does not conserve");
      }
      state.exposures += 1;
    }
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) state.stage = "reconciliations";
  } else {
    for (const status of ["pending", "running", "failed"] as const) {
      const row = await ctx.db
        .query("publisherReconciliationJobs")
        .withIndex("by_status_updated", (q) => q.eq("status", status))
        .first();
      if (row !== null) {
        throw new Error(`Publisher reconciliation ${row._id} is not complete`);
      }
    }
    await audit(ctx, job._id, "conservation", MIGRATION_KEY, "verified", {
      wallets: state.wallets,
      payments: state.payments,
      publishers: state.publishers,
      transfers: state.transfers,
      allocations: state.allocations,
      rollups: state.rollups,
      usage: state.usage,
      earnings: state.earnings,
      exposures: state.exposures,
      rowsRead: job.rowsRead,
      rowsWritten: job.rowsWritten,
      chunks: job.chunks,
    });
    await ctx.db.patch(job._id, {
      phase: "complete",
      status: "verified",
      verificationState: JSON.stringify(state),
      lastError: undefined,
      updatedAt: Date.now(),
    });
    return;
  }
  await ctx.db.patch(job._id, {
    verificationState: JSON.stringify(state),
    rowsRead: job.rowsRead + 1,
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
    // Finance mutations span multiple webhook/reconciliation transactions.
    // Establish global fence only from a drained checkpoint; later receipts
    // may queue safely because all money mutations fail closed behind fence.
    await assertInitialMigrationQuiescence(ctx);
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
    await audit(ctx, jobId, "migration", "start", "checkpoint", {
      migrationKey: MIGRATION_KEY,
      scopeBatch: SCOPE_BATCH,
      detailBatch: DETAIL_BATCH,
      verifyBatch: VERIFY_BATCH,
    });
    await scheduleNext(ctx, jobId);
    return jobId;
  },
});

export const runChunk = internalMutation({
  args: { jobId: v.id("financialMigrationJobs") },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.status !== "running") return;
    try {
      if (job.phase === "wallets") await runWalletChunk(ctx, job);
      else if (job.phase === "clawbacks") await runPaymentChunk(ctx, job);
      else if (job.phase === "publishers") await runPublisherChunk(ctx, job);
      else if (job.phase === "transfers") await runTransferChunk(ctx, job);
      else if (job.phase === "conservation") {
        await runConservationChunk(ctx, job);
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Finance migration failed";
      await audit(ctx, job._id, job.phase, "failure", "failed", {
        error: message,
        activeWalletId: job.activeWalletId ?? null,
        activePaymentId: job.activePaymentId ?? null,
        activePublisherOrganizationId:
          job.activePublisherOrganizationId ?? null,
        activeTransferId: job.activeTransferId ?? null,
      });
      await ctx.db.patch(job._id, {
        status: "failed",
        lastError: message,
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
