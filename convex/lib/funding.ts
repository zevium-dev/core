import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export const MAX_FUNDING_LOTS_PER_DEBIT = 16;

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

export async function getFundingState(
  ctx: MutationCtx,
  walletId: Id<"wallets">,
): Promise<Doc<"walletFundingStates"> | null> {
  return await ctx.db
    .query("walletFundingStates")
    .withIndex("by_wallet", (q) => q.eq("walletId", walletId))
    .unique();
}

async function requireFundingState(
  ctx: MutationCtx,
  wallet: Doc<"wallets">,
): Promise<Doc<"walletFundingStates">> {
  const state = await getFundingState(ctx, wallet._id);
  if (state !== null) return state;
  throw new FundingInvariantError(
    "Wallet funding migration has not completed",
    true,
  );
}

/**
 * Create exactly one universal lot for a positive immutable ledger source.
 * A state can be bootstrapped only for a new wallet; historical wallets must
 * go through ordered finance migration so no prior source disappears.
 */
export async function recordPositiveFundingSource(
  ctx: MutationCtx,
  args: {
    wallet: Doc<"wallets">;
    sourceKind: FundingSourceKind;
    sourceRef: string;
    amount: number;
    refundable: boolean;
    paymentId?: Id<"payments">;
    createdAt: number;
  },
): Promise<Doc<"walletFundingLots">> {
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
    return existing;
  }

  let state = await getFundingState(ctx, args.wallet._id);
  if (state === null) {
    if (args.wallet.sequence !== 1) {
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
      updatedAt: args.createdAt,
    });
    state = await ctx.db.get(stateId);
    if (state === null) {
      throw new FundingInvariantError("Funding state creation failed", true);
    }
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
    state: "available",
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
  });
  await ctx.db.patch(state._id, {
    nonrefundableAvailableCredits:
      state.nonrefundableAvailableCredits + (args.refundable ? 0 : args.amount),
    refundableAvailableCredits:
      state.refundableAvailableCredits + (args.refundable ? args.amount : 0),
    reversedCredits:
      args.sourceKind === "restoration"
        ? Math.max(0, state.reversedCredits - args.amount)
        : state.reversedCredits,
    sequence: state.sequence + 1,
    updatedAt: args.createdAt,
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
};

export type FundingPlan = {
  state: Doc<"walletFundingStates">;
  items: FundingPlanItem[];
  debtCredits: number;
  nonrefundableCredits: number;
  refundableCredits: number;
};

export type PaymentReversalPlan = {
  state: Doc<"walletFundingStates">;
  items: FundingPlanItem[];
  walletCredits: number;
};

/**
 * Select payment-provenance inventory for an external reversal. Publisher
 * exposure receives any remainder. More than bounded fan-out is retried after
 * migration/compaction instead of partially mutating money.
 */
export async function preflightPaymentReversal(
  ctx: MutationCtx,
  args: {
    wallet: Doc<"wallets">;
    paymentId: Id<"payments">;
    requestedCredits: number;
  },
): Promise<PaymentReversalPlan> {
  const state = await requireFundingState(ctx, args.wallet);
  const lots = await ctx.db
    .query("walletFundingLots")
    .withIndex("by_payment_state_created", (q) =>
      q.eq("paymentId", args.paymentId).eq("state", "available"),
    )
    .order("asc")
    .take(MAX_FUNDING_LOTS_PER_DEBIT + 1);
  const items: FundingPlanItem[] = [];
  let remaining = args.requestedCredits;
  for (const lot of lots) {
    if (remaining === 0 || items.length === MAX_FUNDING_LOTS_PER_DEBIT) break;
    const grossCredits = Math.min(lot.availableCredits, remaining);
    if (grossCredits <= 0) continue;
    items.push({ lot, grossCredits });
    remaining -= grossCredits;
  }
  if (remaining > 0 && lots.length > MAX_FUNDING_LOTS_PER_DEBIT) {
    throw new FundingInvariantError(
      "Payment reversal exceeds bounded lot fan-out",
      true,
    );
  }
  const walletCredits = args.requestedCredits - remaining;
  const refundableCredits = items
    .filter((item) => item.lot.refundable)
    .reduce((sum, item) => sum + item.grossCredits, 0);
  const nonrefundableCredits = walletCredits - refundableCredits;
  if (
    refundableCredits > state.refundableAvailableCredits ||
    nonrefundableCredits > state.nonrefundableAvailableCredits
  ) {
    throw new FundingInvariantError(
      "Payment reversal funding aggregate would underflow",
      false,
    );
  }
  return {
    state,
    items,
    walletCredits,
  };
}

export async function commitPaymentReversal(
  ctx: MutationCtx,
  plan: PaymentReversalPlan,
  now: number,
): Promise<void> {
  let refundableDelta = 0;
  let nonrefundableDelta = 0;
  for (const item of plan.items) {
    const availableCredits = item.lot.availableCredits - item.grossCredits;
    if (availableCredits < 0) {
      throw new FundingInvariantError("Payment reversal lot underflow", false);
    }
    await ctx.db.patch(item.lot._id, {
      availableCredits,
      reversedCredits: item.lot.reversedCredits + item.grossCredits,
      state: availableCredits === 0 ? "depleted" : "available",
      updatedAt: now,
    });
    if (item.lot.refundable) refundableDelta += item.grossCredits;
    else nonrefundableDelta += item.grossCredits;
  }
  if (refundableDelta + nonrefundableDelta !== plan.walletCredits) {
    throw new FundingInvariantError(
      "Payment reversal plan did not balance",
      false,
    );
  }
  await ctx.db.patch(plan.state._id, {
    refundableAvailableCredits:
      plan.state.refundableAvailableCredits - refundableDelta,
    nonrefundableAvailableCredits:
      plan.state.nonrefundableAvailableCredits - nonrefundableDelta,
    reversedCredits: plan.state.reversedCredits + plan.walletCredits,
    sequence: plan.state.sequence + 1,
    updatedAt: now,
  });
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

/**
 * Read-only allocation preflight. No usage, earning, ledger, or lot write may
 * happen until this returns a plan whose remainder is exactly zero.
 */
export async function preflightFundingAllocation(
  ctx: MutationCtx,
  args: {
    wallet: Doc<"wallets">;
    credits: number;
    allowReservationDebt: boolean;
  },
): Promise<FundingPlan> {
  if (!Number.isSafeInteger(args.credits) || args.credits < 0) {
    throw new FundingInvariantError(
      "Debit must be a non-negative integer",
      false,
    );
  }
  const state = await requireFundingState(ctx, args.wallet);
  if (args.credits === 0) {
    return {
      state,
      items: [],
      debtCredits: 0,
      nonrefundableCredits: 0,
      refundableCredits: 0,
    };
  }

  const totalAvailable =
    state.nonrefundableAvailableCredits + state.refundableAvailableCredits;
  if (totalAvailable < args.credits && !args.allowReservationDebt) {
    throw new FundingInvariantError(
      "Funding inventory cannot cover settlement",
      false,
    );
  }
  const inventoryTarget = Math.min(totalAvailable, args.credits);
  let remainingInventory = inventoryTarget;
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
    if (remainingInventory === 0) break;
    if (items.length === MAX_FUNDING_LOTS_PER_DEBIT) break;
    const grossCredits = Math.min(lot.availableCredits, remainingInventory);
    if (grossCredits <= 0) continue;
    items.push({ lot, grossCredits });
    nonrefundableCredits += grossCredits;
    remainingInventory -= grossCredits;
  }

  if (remainingInventory > 0) {
    const refundableLots = await takeAvailableLots(
      ctx,
      args.wallet.organizationId,
      true,
      MAX_FUNDING_LOTS_PER_DEBIT - items.length + 1,
    );
    for (const lot of refundableLots) {
      if (remainingInventory === 0) break;
      if (items.length === MAX_FUNDING_LOTS_PER_DEBIT) break;
      const grossCredits = Math.min(lot.availableCredits, remainingInventory);
      if (grossCredits <= 0) continue;
      items.push({ lot, grossCredits });
      refundableCredits += grossCredits;
      remainingInventory -= grossCredits;
    }
  }

  if (remainingInventory !== 0) {
    throw new FundingInvariantError(
      "Funding allocation exceeds bounded lot fan-out",
      true,
    );
  }
  const debtCredits = args.credits - inventoryTarget;
  if (debtCredits > 0 && !args.allowReservationDebt) {
    throw new FundingInvariantError("Unproven wallet debt is forbidden", false);
  }
  if (nonrefundableCredits + refundableCredits + debtCredits !== args.credits) {
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
    debtCredits,
    nonrefundableCredits,
    refundableCredits,
  };
}

/** Commit a fully balanced preflight plan. */
export async function commitFundingAllocation(
  ctx: MutationCtx,
  args: {
    plan: FundingPlan;
    walletEntryId: Id<"walletEntries">;
    walletId: Id<"wallets">;
    organizationId: Id<"organizations">;
    kind: "usage" | "negative_adjustment";
    usageEventId?: Id<"usageEvents">;
    earningId?: Id<"publisherEarnings">;
    publisherOrganizationId?: Id<"organizations">;
    createdAt: number;
  },
): Promise<void> {
  let committed = 0;
  for (const item of args.plan.items) {
    const availableCredits = item.lot.availableCredits - item.grossCredits;
    if (availableCredits < 0) {
      throw new FundingInvariantError("Funding lot underflow", false);
    }
    await ctx.db.patch(item.lot._id, {
      availableCredits,
      allocatedCredits: item.lot.allocatedCredits + item.grossCredits,
      state: availableCredits === 0 ? "depleted" : "available",
      updatedAt: args.createdAt,
    });
    const allocationId = await ctx.db.insert("walletFundingAllocations", {
      walletId: args.walletId,
      organizationId: args.organizationId,
      fundingLotId: item.lot._id,
      paymentId: item.lot.paymentId,
      walletEntryId: args.walletEntryId,
      usageEventId: args.usageEventId,
      earningId: args.earningId,
      kind: args.kind,
      grossCredits: item.grossCredits,
      clawedBackGrossCredits: 0,
      createdAt: args.createdAt,
    });
    if (args.earningId !== undefined) {
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
          paymentId: item.lot.paymentId,
          publisherOrganizationId: args.publisherOrganizationId,
          allocatedGrossCredits: item.grossCredits,
          clawedBackGrossCredits: 0,
          updatedAt: args.createdAt,
        });
      } else {
        await ctx.db.patch(rollup._id, {
          allocatedGrossCredits:
            rollup.allocatedGrossCredits + item.grossCredits,
          updatedAt: args.createdAt,
        });
      }
    }
    void allocationId;
    committed += item.grossCredits;
  }

  if (args.plan.debtCredits > 0) {
    await ctx.db.insert("walletFundingAllocations", {
      walletId: args.walletId,
      organizationId: args.organizationId,
      walletEntryId: args.walletEntryId,
      usageEventId: args.usageEventId,
      earningId: args.earningId,
      kind: "reservation_debt",
      grossCredits: args.plan.debtCredits,
      clawedBackGrossCredits: 0,
      createdAt: args.createdAt,
    });
    committed += args.plan.debtCredits;
  }
  if (
    committed !==
    args.plan.nonrefundableCredits +
      args.plan.refundableCredits +
      args.plan.debtCredits
  ) {
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
    updatedAt: args.createdAt,
  });
}
