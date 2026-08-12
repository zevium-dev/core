import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { assertFinanceMigrationAllowsRuntime } from "./financeMigrationGate";

/** One debit stays bounded; batches additionally budget total projected writes. */
export const MAX_FUNDING_LOTS_PER_DEBIT = 24;
export const MAX_FUNDING_WRITE_UNITS_PER_BATCH = 96;
/** Pairwise compaction leaves at most one active lot per funding priority. */
export const FUNDING_COMPACTION_INPUTS = 2;

export class FundingInvariantError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "FundingInvariantError";
  }
}

type FundingSourceKind = Doc<"walletFundingLots">["sourceKind"];

export type FundingProvenanceSlice = {
  sourceRef: string;
  paymentId?: Id<"payments">;
  grossCredits: number;
};

function provenanceTotal(slices: readonly FundingProvenanceSlice[]): number {
  const total = slices.reduce((sum, slice) => sum + slice.grossCredits, 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new FundingInvariantError("Funding provenance overflow", false);
  }
  return total;
}

function availableProvenance(
  lot: Doc<"walletFundingLots">,
): FundingProvenanceSlice[] {
  const slices = lot.availableProvenance;
  if (slices === undefined) {
    if (lot.sourceKind === "compaction") {
      throw new FundingInvariantError(
        "Compacted funding lot is missing provenance",
        false,
      );
    }
    return lot.availableCredits === 0
      ? []
      : [
          {
            sourceRef: lot.sourceRef,
            paymentId: lot.paymentId,
            grossCredits: lot.availableCredits,
          },
        ];
  }
  for (const slice of slices) {
    if (
      slice.sourceRef.trim() === "" ||
      !Number.isSafeInteger(slice.grossCredits) ||
      slice.grossCredits <= 0 ||
      (!lot.refundable && slice.paymentId !== undefined)
    ) {
      throw new FundingInvariantError("Funding provenance is invalid", false);
    }
  }
  if (provenanceTotal(slices) !== lot.availableCredits) {
    throw new FundingInvariantError(
      "Funding provenance does not match available inventory",
      false,
    );
  }
  return [...slices];
}

function splitProvenance(
  slices: readonly FundingProvenanceSlice[],
  credits: number,
  paymentId?: Id<"payments">,
): {
  consumed: FundingProvenanceSlice[];
  remaining: FundingProvenanceSlice[];
} {
  let needed = credits;
  const consumed: FundingProvenanceSlice[] = [];
  const remaining: FundingProvenanceSlice[] = [];
  for (const slice of slices) {
    const eligible = paymentId === undefined || slice.paymentId === paymentId;
    const take = eligible ? Math.min(needed, slice.grossCredits) : 0;
    if (take > 0) {
      consumed.push({ ...slice, grossCredits: take });
      needed -= take;
    }
    if (take < slice.grossCredits) {
      remaining.push({ ...slice, grossCredits: slice.grossCredits - take });
    }
  }
  if (needed !== 0) {
    throw new FundingInvariantError(
      "Funding provenance cannot cover requested credits",
      false,
    );
  }
  return { consumed, remaining };
}

function provenancePaymentId(
  slices: readonly FundingProvenanceSlice[],
): Id<"payments"> | undefined {
  const first = slices[0]?.paymentId;
  return first !== undefined && slices.every((slice) => slice.paymentId === first)
    ? first
    : undefined;
}

export async function getFundingState(
  ctx: MutationCtx | QueryCtx,
  walletId: Id<"wallets">,
): Promise<Doc<"walletFundingStates"> | null> {
  return await ctx.db
    .query("walletFundingStates")
    .withIndex("by_wallet", (q) => q.eq("walletId", walletId))
    .unique();
}

export async function requireVerifiedWalletFunding(
  ctx: MutationCtx | QueryCtx,
  wallet: Doc<"wallets">,
): Promise<Doc<"walletFundingStates">> {
  await assertFinanceMigrationAllowsRuntime(ctx);
  const state = await getFundingState(ctx, wallet._id);
  const availableCredits =
    (state?.nonrefundableAvailableCredits ?? -1) +
    (state?.refundableAvailableCredits ?? -1);
  if (
    state === null ||
    state.migrationStatus !== "verified" ||
    state.migrationJobId !== undefined ||
    state.migrationWatermarkSequence !== wallet.sequence ||
    !Number.isSafeInteger(availableCredits) ||
    availableCredits !== wallet.balance ||
    state.nonrefundableAvailableCredits < 0 ||
    state.refundableAvailableCredits < 0 ||
    state.allocatedCredits < 0 ||
    state.reversedCredits < 0 ||
    wallet.balance < 0 ||
    (wallet.debtCredits ?? 0) !== 0
  ) {
    throw new FundingInvariantError(
      "Wallet funding checkpoint is not verified",
      true,
    );
  }
  return state;
}

function assertFundingStateReady(
  state: Doc<"walletFundingStates">,
  migrationJobId?: Id<"financialMigrationJobs">,
): void {
  if (migrationJobId !== undefined) {
    if (
      state.migrationStatus !== "building" ||
      state.migrationJobId !== migrationJobId
    ) {
      throw new FundingInvariantError(
        "Wallet funding migration fence changed",
        true,
      );
    }
    return;
  }
  if (state.migrationStatus !== "verified") {
    throw new FundingInvariantError(
      "Wallet funding migration has not completed",
      true,
    );
  }
}

async function requireFundingState(
  ctx: MutationCtx,
  wallet: Doc<"wallets">,
  migrationJobId?: Id<"financialMigrationJobs">,
): Promise<Doc<"walletFundingStates">> {
  if (migrationJobId === undefined) {
    return await requireVerifiedWalletFunding(ctx, wallet);
  }
  const state = await getFundingState(ctx, wallet._id);
  if (state === null) {
    throw new FundingInvariantError(
      "Wallet funding migration has not completed",
      true,
    );
  }
  assertFundingStateReady(state, migrationJobId);
  return state;
}

function compactableTogether(
  left: Doc<"walletFundingLots">,
  right: Doc<"walletFundingLots">,
): boolean {
  if (
    left.walletId !== right.walletId ||
    left.refundable !== right.refundable
  ) {
    return false;
  }
  return true;
}

async function compactLots(
  ctx: MutationCtx,
  state: Doc<"walletFundingStates">,
  lots: Doc<"walletFundingLots">[],
  now: number,
): Promise<Doc<"walletFundingStates">> {
  if (lots.length !== FUNDING_COMPACTION_INPUTS) return state;
  const first = lots[0]!;
  if (
    lots.some(
      (lot) =>
        lot.state !== "available" ||
        lot.availableCredits <= 0 ||
        !compactableTogether(first, lot),
    )
  ) {
    throw new FundingInvariantError("Invalid funding compaction set", false);
  }
  const grantedCredits = lots.reduce(
    (sum, lot) => sum + lot.availableCredits,
    0,
  );
  if (!Number.isSafeInteger(grantedCredits) || grantedCredits <= 0) {
    throw new FundingInvariantError("Funding compaction overflow", false);
  }
  const provenance = lots.flatMap((lot) => availableProvenance(lot));
  if (provenanceTotal(provenance) !== grantedCredits) {
    throw new FundingInvariantError(
      "Funding compaction provenance did not balance",
      false,
    );
  }
  const compactedLotId = await ctx.db.insert("walletFundingLots", {
    walletId: first.walletId,
    organizationId: first.organizationId,
    sourceKind: "compaction",
    sourceRef: `funding:compact:${first.walletId}:${state.sequence + 1}`,
    paymentId: first.refundable
      ? provenancePaymentId(provenance)
      : undefined,
    refundable: first.refundable,
    grantedCredits,
    availableCredits: grantedCredits,
    allocatedCredits: 0,
    reversedCredits: 0,
    compactedCredits: 0,
    availableProvenance: provenance,
    state: "available",
    createdAt: Math.min(...lots.map((lot) => lot.createdAt)),
    updatedAt: now,
  });
  for (const lot of lots) {
    const grossCredits = lot.availableCredits;
    await ctx.db.patch(lot._id, {
      availableCredits: 0,
      compactedCredits: (lot.compactedCredits ?? 0) + grossCredits,
      availableProvenance: [],
      state: "compacted",
      updatedAt: now,
    });
    await ctx.db.insert("walletFundingLotComponents", {
      walletId: lot.walletId,
      compactedLotId,
      sourceLotId: lot._id,
      grossCredits,
      createdAt: now,
    });
  }
  await ctx.db.patch(state._id, {
    sequence: state.sequence + 1,
    updatedAt: now,
  });
  return { ...state, sequence: state.sequence + 1, updatedAt: now };
}

/**
 * Compact one compatible inventory group. Source lots remain immutable roots;
 * lineage rows preserve every funding ref while active fan-out stays small.
 */
export async function compactFundingInventory(
  ctx: MutationCtx,
  args: {
    wallet: Doc<"wallets">;
    migrationJobId?: Id<"financialMigrationJobs">;
    paymentId?: Id<"payments">;
    refundable: boolean;
    now: number;
  },
): Promise<boolean> {
  const state = await requireFundingState(
    ctx,
    args.wallet,
    args.migrationJobId,
  );
  const lots = await ctx.db
        .query("walletFundingLots")
        .withIndex("by_org_priority_state_created", (q) =>
          q
            .eq("organizationId", args.wallet.organizationId)
            .eq("refundable", args.refundable)
            .eq("state", "available"),
        )
        .order("asc")
        .take(FUNDING_COMPACTION_INPUTS);
  if (lots.length < FUNDING_COMPACTION_INPUTS) return false;
  await compactLots(ctx, state, lots, args.now);
  return true;
}

/**
 * Create exactly one root lot for a positive immutable ledger source. New
 * wallets become verified atomically with their first source. Historical
 * wallets require the explicit fenced migration.
 */
export async function recordPositiveFundingSource(
  ctx: MutationCtx,
  args: {
    wallet: Doc<"wallets">;
    sourceKind: Exclude<FundingSourceKind, "compaction">;
    sourceRef: string;
    amount: number;
    refundable: boolean;
    paymentId?: Id<"payments">;
    createdAt: number;
    migrationJobId?: Id<"financialMigrationJobs">;
  },
): Promise<Doc<"walletFundingLots">> {
  if (args.migrationJobId === undefined) {
    await assertFinanceMigrationAllowsRuntime(ctx);
  }
  if (!Number.isSafeInteger(args.amount) || args.amount <= 0) {
    throw new FundingInvariantError(
      "Funding source must be a positive integer",
      false,
    );
  }
  const existing = await ctx.db
    .query("walletFundingLots")
    .withIndex("by_source_ref", (q) => q.eq("sourceRef", args.sourceRef))
    .unique();
  if (existing !== null) {
    if (
      existing.walletId !== args.wallet._id ||
      existing.organizationId !== args.wallet.organizationId ||
      existing.sourceKind !== args.sourceKind ||
      existing.paymentId !== args.paymentId ||
      existing.refundable !== args.refundable ||
      existing.grantedCredits !== args.amount
    ) {
      throw new FundingInvariantError(
        "Funding source reference was replayed with different facts",
        false,
      );
    }
    if (existing.availableProvenance === undefined) {
      await ctx.db.patch(existing._id, {
        availableProvenance:
          existing.availableCredits === 0
            ? []
            : [
                {
                  sourceRef: existing.sourceRef,
                  paymentId: existing.paymentId,
                  grossCredits: existing.availableCredits,
                },
              ],
      });
    }
    await requireFundingState(ctx, args.wallet, args.migrationJobId);
    return existing;
  }

  let state = await getFundingState(ctx, args.wallet._id);
  if (state === null) {
    if (args.migrationJobId !== undefined || args.wallet.sequence !== 1) {
      throw new FundingInvariantError(
        "Historical wallet requires ordered funding migration",
        true,
      );
    }
    const stateId = await ctx.db.insert("walletFundingStates", {
      walletId: args.wallet._id,
      organizationId: args.wallet.organizationId,
      nonrefundableAvailableCredits: 0,
      refundableAvailableCredits: 0,
      allocatedCredits: 0,
      reversedCredits: 0,
      sequence: 0,
      migrationStatus: "verified",
      migrationWatermarkSequence: 0,
      updatedAt: args.createdAt,
    });
    state = await ctx.db.get(stateId);
    if (state === null) {
      throw new FundingInvariantError("Funding state creation failed", true);
    }
  }
  assertFundingStateReady(state, args.migrationJobId);
  if (
    args.migrationJobId === undefined &&
    (state.migrationJobId !== undefined ||
      args.wallet.sequence <= 0 ||
      state.migrationWatermarkSequence !== args.wallet.sequence - 1 ||
      state.nonrefundableAvailableCredits + state.refundableAvailableCredits !==
        args.wallet.balance - args.amount ||
      args.wallet.balance - args.amount < 0 ||
      (args.wallet.debtCredits ?? 0) !== 0)
  ) {
    throw new FundingInvariantError(
      "Positive funding source cannot repair an unverified checkpoint",
      true,
    );
  }

  const lotId = await ctx.db.insert("walletFundingLots", {
    walletId: args.wallet._id,
    organizationId: args.wallet.organizationId,
    sourceKind: args.sourceKind,
    sourceRef: args.sourceRef,
    paymentId: args.paymentId,
    refundable: args.refundable,
    grantedCredits: args.amount,
    availableCredits: args.amount,
    allocatedCredits: 0,
    reversedCredits: 0,
    compactedCredits: 0,
    availableProvenance: [
      {
        sourceRef: args.sourceRef,
        paymentId: args.paymentId,
        grossCredits: args.amount,
      },
    ],
    state: "available",
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
  });
  const patched = {
    ...state,
    nonrefundableAvailableCredits:
      state.nonrefundableAvailableCredits + (args.refundable ? 0 : args.amount),
    refundableAvailableCredits:
      state.refundableAvailableCredits + (args.refundable ? args.amount : 0),
    sequence: state.sequence + 1,
    migrationWatermarkSequence:
      args.migrationJobId === undefined
        ? args.wallet.sequence
        : state.migrationWatermarkSequence,
    updatedAt: args.createdAt,
  };
  await ctx.db.patch(state._id, {
    nonrefundableAvailableCredits: patched.nonrefundableAvailableCredits,
    refundableAvailableCredits: patched.refundableAvailableCredits,
    sequence: patched.sequence,
    migrationWatermarkSequence: patched.migrationWatermarkSequence,
    updatedAt: patched.updatedAt,
  });
  await compactFundingInventory(ctx, {
    wallet: args.wallet,
    migrationJobId: args.migrationJobId,
    paymentId: args.paymentId,
    refundable: args.refundable,
    now: args.createdAt,
  });
  const lot = await ctx.db.get(lotId);
  if (lot === null) {
    throw new FundingInvariantError("Funding lot creation failed", true);
  }
  return lot;
}

export type FundingPlanItem = {
  lot: Doc<"walletFundingLots">;
  grossCredits: number;
  provenance: FundingProvenanceSlice[];
};

export type FundingPlan = {
  state: Doc<"walletFundingStates">;
  items: FundingPlanItem[];
  credits: number;
  nonrefundableCredits: number;
  refundableCredits: number;
  estimatedWriteUnits: number;
};

export type PaymentReversalPlan = {
  state: Doc<"walletFundingStates">;
  items: FundingPlanItem[];
  walletCredits: number;
  estimatedWriteUnits: number;
};

/** Select exact payment inventory; publisher exposure receives any remainder. */
export async function preflightPaymentReversal(
  ctx: MutationCtx,
  args: {
    wallet: Doc<"wallets">;
    paymentId: Id<"payments">;
    requestedCredits: number;
    migrationJobId?: Id<"financialMigrationJobs">;
  },
): Promise<PaymentReversalPlan> {
  const state = await requireFundingState(
    ctx,
    args.wallet,
    args.migrationJobId,
  );
  const lots = await ctx.db
    .query("walletFundingLots")
    .withIndex("by_org_priority_state_created", (q) =>
      q
        .eq("organizationId", args.wallet.organizationId)
        .eq("refundable", true)
        .eq("state", "available"),
    )
    .order("asc")
    .take(MAX_FUNDING_LOTS_PER_DEBIT + 1);
  const items: FundingPlanItem[] = [];
  let remaining = args.requestedCredits;
  for (const lot of lots) {
    if (remaining === 0 || items.length === MAX_FUNDING_LOTS_PER_DEBIT) break;
    const provenance = availableProvenance(lot);
    const paymentCredits = provenance
      .filter((slice) => slice.paymentId === args.paymentId)
      .reduce((sum, slice) => sum + slice.grossCredits, 0);
    const grossCredits = Math.min(paymentCredits, remaining);
    if (grossCredits <= 0) continue;
    items.push({
      lot,
      grossCredits,
      provenance: splitProvenance(provenance, grossCredits, args.paymentId)
        .consumed,
    });
    remaining -= grossCredits;
  }
  if (remaining > 0 && lots.length > MAX_FUNDING_LOTS_PER_DEBIT) {
    throw new FundingInvariantError(
      "Payment reversal exceeds bounded transaction write budget",
      true,
    );
  }
  const walletCredits = args.requestedCredits - remaining;
  if (walletCredits > state.refundableAvailableCredits) {
    throw new FundingInvariantError(
      "Payment reversal funding aggregate would underflow",
      false,
    );
  }
  return {
    state,
    items,
    walletCredits,
    estimatedWriteUnits: items.length + 2,
  };
}

export async function commitPaymentReversal(
  ctx: MutationCtx,
  args: {
    plan: PaymentReversalPlan;
    walletSequence: number;
    now: number;
    migrationJobId?: Id<"financialMigrationJobs">;
  },
): Promise<FundingProvenanceSlice[]> {
  assertFundingStateReady(args.plan.state, args.migrationJobId);
  let refundableDelta = 0;
  const reversedProvenance: FundingProvenanceSlice[] = [];
  for (const item of args.plan.items) {
    const split = splitProvenance(
      availableProvenance(item.lot),
      item.grossCredits,
      item.provenance[0]?.paymentId,
    );
    if (
      JSON.stringify(split.consumed) !== JSON.stringify(item.provenance)
    ) {
      throw new FundingInvariantError(
        "Payment reversal provenance changed after preflight",
        true,
      );
    }
    const availableCredits = item.lot.availableCredits - item.grossCredits;
    if (availableCredits < 0) {
      throw new FundingInvariantError("Payment reversal lot underflow", false);
    }
    await ctx.db.patch(item.lot._id, {
      availableCredits,
      reversedCredits: item.lot.reversedCredits + item.grossCredits,
      availableProvenance: split.remaining,
      state: availableCredits === 0 ? "depleted" : "available",
      updatedAt: args.now,
    });
    refundableDelta += item.grossCredits;
    reversedProvenance.push(...split.consumed);
  }
  if (refundableDelta !== args.plan.walletCredits) {
    throw new FundingInvariantError(
      "Payment reversal plan did not balance",
      false,
    );
  }
  await ctx.db.patch(args.plan.state._id, {
    refundableAvailableCredits:
      args.plan.state.refundableAvailableCredits - refundableDelta,
    reversedCredits: args.plan.state.reversedCredits + args.plan.walletCredits,
    sequence: args.plan.state.sequence + 1,
    migrationWatermarkSequence:
      args.migrationJobId === undefined
        ? args.walletSequence
        : args.plan.state.migrationWatermarkSequence,
    updatedAt: args.now,
  });
  return reversedProvenance;
}

async function takeAvailableLots(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  refundable: boolean,
  limit: number,
): Promise<Doc<"walletFundingLots">[]> {
  if (limit <= 0) return [];
  return await ctx.db
    .query("walletFundingLots")
    .withIndex("by_org_priority_state_created", (q) =>
      q
        .eq("organizationId", organizationId)
        .eq("refundable", refundable)
        .eq("state", "available"),
    )
    .order("asc")
    .take(limit);
}

/** Read-only allocation preflight. Every committed debit is fully funded. */
export async function preflightFundingAllocation(
  ctx: MutationCtx,
  args: {
    wallet: Doc<"wallets">;
    credits: number;
    migrationJobId?: Id<"financialMigrationJobs">;
  },
): Promise<FundingPlan> {
  if (!Number.isSafeInteger(args.credits) || args.credits < 0) {
    throw new FundingInvariantError(
      "Debit must be a non-negative integer",
      false,
    );
  }
  const state = await requireFundingState(
    ctx,
    args.wallet,
    args.migrationJobId,
  );
  if (args.credits === 0) {
    return {
      state,
      items: [],
      credits: 0,
      nonrefundableCredits: 0,
      refundableCredits: 0,
      estimatedWriteUnits: 1,
    };
  }

  const totalAvailable =
    state.nonrefundableAvailableCredits + state.refundableAvailableCredits;
  if (totalAvailable < args.credits) {
    throw new FundingInvariantError(
      "Funding inventory cannot cover settlement",
      false,
    );
  }
  let remaining = args.credits;
  let nonrefundableCredits = 0;
  let refundableCredits = 0;
  const items: FundingPlanItem[] = [];

  const nonrefundableLots = await takeAvailableLots(
    ctx,
    args.wallet.organizationId,
    false,
    MAX_FUNDING_LOTS_PER_DEBIT + 1,
  );
  for (const lot of nonrefundableLots) {
    if (remaining === 0 || items.length === MAX_FUNDING_LOTS_PER_DEBIT) break;
    const grossCredits = Math.min(lot.availableCredits, remaining);
    if (grossCredits <= 0) continue;
    items.push({
      lot,
      grossCredits,
      provenance: splitProvenance(
        availableProvenance(lot),
        grossCredits,
      ).consumed,
    });
    nonrefundableCredits += grossCredits;
    remaining -= grossCredits;
  }

  if (remaining > 0) {
    const refundableLots = await takeAvailableLots(
      ctx,
      args.wallet.organizationId,
      true,
      MAX_FUNDING_LOTS_PER_DEBIT - items.length + 1,
    );
    for (const lot of refundableLots) {
      if (remaining === 0 || items.length === MAX_FUNDING_LOTS_PER_DEBIT) break;
      const grossCredits = Math.min(lot.availableCredits, remaining);
      if (grossCredits <= 0) continue;
      items.push({
        lot,
        grossCredits,
        provenance: splitProvenance(
          availableProvenance(lot),
          grossCredits,
        ).consumed,
      });
      refundableCredits += grossCredits;
      remaining -= grossCredits;
    }
  }

  if (remaining !== 0) {
    throw new FundingInvariantError(
      "Funding allocation exceeds bounded transaction write budget",
      true,
    );
  }
  if (nonrefundableCredits + refundableCredits !== args.credits) {
    throw new FundingInvariantError(
      "Funding allocation did not balance",
      false,
    );
  }
  if (
    nonrefundableCredits > state.nonrefundableAvailableCredits ||
    refundableCredits > state.refundableAvailableCredits
  ) {
    throw new FundingInvariantError("Funding aggregate would underflow", false);
  }
  return {
    state,
    items,
    credits: args.credits,
    nonrefundableCredits,
    refundableCredits,
    estimatedWriteUnits: items.length * 3 + 2,
  };
}

/** Commit one fully balanced, source-backed plan. */
export async function commitFundingAllocation(
  ctx: MutationCtx,
  args: {
    plan: FundingPlan;
    walletEntryId: Id<"walletEntries">;
    walletId: Id<"wallets">;
    walletSequence: number;
    organizationId: Id<"organizations">;
    kind: "usage" | "negative_adjustment";
    usageEventId?: Id<"usageEvents">;
    earningId?: Id<"publisherEarnings">;
    publisherOrganizationId?: Id<"organizations">;
    createdAt: number;
    migrationJobId?: Id<"financialMigrationJobs">;
  },
): Promise<void> {
  assertFundingStateReady(args.plan.state, args.migrationJobId);
  const existing = await ctx.db
    .query("walletFundingAllocations")
    .withIndex("by_wallet_entry", (q) =>
      q.eq("walletEntryId", args.walletEntryId),
    )
    .first();
  if (existing !== null) {
    throw new FundingInvariantError(
      "Wallet entry already has funding allocations",
      false,
    );
  }
  let committed = 0;
  for (const item of args.plan.items) {
    const split = splitProvenance(
      availableProvenance(item.lot),
      item.grossCredits,
    );
    if (JSON.stringify(split.consumed) !== JSON.stringify(item.provenance)) {
      throw new FundingInvariantError(
        "Funding provenance changed after preflight",
        true,
      );
    }
    const availableCredits = item.lot.availableCredits - item.grossCredits;
    if (availableCredits < 0) {
      throw new FundingInvariantError("Funding lot underflow", false);
    }
    await ctx.db.patch(item.lot._id, {
      availableCredits,
      allocatedCredits: item.lot.allocatedCredits + item.grossCredits,
      availableProvenance: split.remaining,
      state: availableCredits === 0 ? "depleted" : "available",
      updatedAt: args.createdAt,
    });
    await ctx.db.insert("walletFundingAllocations", {
      walletId: args.walletId,
      organizationId: args.organizationId,
      fundingLotId: item.lot._id,
      paymentId: provenancePaymentId(item.provenance),
      walletEntryId: args.walletEntryId,
      usageEventId: args.usageEventId,
      earningId: args.earningId,
      kind: args.kind,
      grossCredits: item.grossCredits,
      clawedBackGrossCredits: 0,
      provenance: item.provenance,
      createdAt: args.createdAt,
    });
    if (args.earningId !== undefined) {
      if (args.publisherOrganizationId === undefined) {
        throw new FundingInvariantError(
          "Publisher allocation is missing organization linkage",
          false,
        );
      }
      const rollup = await ctx.db
        .query("fundingAllocationRollups")
        .withIndex("by_lot_publisher", (q) =>
          q
            .eq("fundingLotId", item.lot._id)
            .eq("publisherOrganizationId", args.publisherOrganizationId),
        )
        .unique();
      if (rollup === null) {
        await ctx.db.insert("fundingAllocationRollups", {
          fundingLotId: item.lot._id,
          paymentId: provenancePaymentId(item.provenance),
          publisherOrganizationId: args.publisherOrganizationId,
          allocatedGrossCredits: item.grossCredits,
          clawedBackGrossCredits: 0,
          updatedAt: args.createdAt,
        });
      } else {
        const paymentId = provenancePaymentId(item.provenance);
        await ctx.db.patch(rollup._id, {
          paymentId:
            rollup.paymentId === paymentId ? rollup.paymentId : undefined,
          allocatedGrossCredits:
            rollup.allocatedGrossCredits + item.grossCredits,
          updatedAt: args.createdAt,
        });
      }
    }
    committed += item.grossCredits;
  }
  if (committed !== args.plan.credits) {
    throw new FundingInvariantError("Committed funding did not balance", false);
  }

  await ctx.db.patch(args.plan.state._id, {
    nonrefundableAvailableCredits:
      args.plan.state.nonrefundableAvailableCredits -
      args.plan.nonrefundableCredits,
    refundableAvailableCredits:
      args.plan.state.refundableAvailableCredits - args.plan.refundableCredits,
    allocatedCredits: args.plan.state.allocatedCredits + committed,
    sequence: args.plan.state.sequence + 1,
    migrationWatermarkSequence:
      args.migrationJobId === undefined
        ? args.walletSequence
        : args.plan.state.migrationWatermarkSequence,
    updatedAt: args.createdAt,
  });
}
