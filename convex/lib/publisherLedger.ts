import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { publisherEarningSplit } from "../accounting";

type SettlementKind = Doc<"publisherSettlementEntries">["kind"];

function safeAtomDelta(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer number of atoms`);
  }
}

export async function getOrCreatePublisherBalance(
  ctx: MutationCtx,
  publisherOrganizationId: Id<"organizations">,
): Promise<Doc<"publisherBalances">> {
  const existing = await ctx.db
    .query("publisherBalances")
    .withIndex("by_publisher", (q) =>
      q.eq("publisherOrganizationId", publisherOrganizationId),
    )
    .unique();
  if (existing !== null) return existing;

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
    updatedAt: now,
  });
  const created = await ctx.db.get(id);
  if (created === null) throw new Error("Failed to create publisher balance");
  return created;
}

export async function adjustPublisherBalanceAggregates(
  ctx: MutationCtx,
  balance: Doc<"publisherBalances">,
  deltas: {
    pendingRiskAtoms?: number;
    reversedAtoms?: number;
    failedAtoms?: number;
  },
): Promise<Doc<"publisherBalances">> {
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
  },
): Promise<{ applied: boolean; balance: Doc<"publisherBalances"> }> {
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
    if (existing.publisherBalanceId !== args.balance._id) {
      throw new Error(
        "Publisher settlement reference belongs to another balance",
      );
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

/**
 * Reconcile publisher exposure to one payment's effective credit reversal.
 * Earnings are tied to consumer org because wallet credits are fungible. Any
 * clawback beyond released funds creates negative available balance (debt),
 * blocking future payouts until fresh earnings cover it.
 */
export async function reconcilePaymentPublisherClawback(
  ctx: MutationCtx,
  args: {
    paymentId: Id<"payments">;
    consumerOrganizationId: Id<"organizations">;
    targetGrossCredits: number;
    sourceKind: "refund" | "dispute";
    sourceRef: string;
  },
): Promise<{ activeGrossCredits: number }> {
  if (
    !Number.isSafeInteger(args.targetGrossCredits) ||
    args.targetGrossCredits < 0
  ) {
    throw new Error("Publisher clawback target must be a non-negative integer");
  }
  const rows = await ctx.db
    .query("publisherClawbacks")
    .withIndex("by_payment", (q) => q.eq("paymentId", args.paymentId))
    .collect();
  let activeGrossCredits = rows.reduce(
    (sum, row) => sum + row.grossCredits - row.restoredGrossCredits,
    0,
  );

  if (activeGrossCredits < args.targetGrossCredits) {
    let remaining = args.targetGrossCredits - activeGrossCredits;
    const allocations = await ctx.db
      .query("paymentFundingAllocations")
      .withIndex("by_payment", (q) => q.eq("paymentId", args.paymentId))
      .collect();
    const activeByEarning = new Map<Id<"publisherEarnings">, number>();
    for (const row of rows) {
      activeByEarning.set(
        row.earningId,
        (activeByEarning.get(row.earningId) ?? 0) +
          row.grossCredits -
          row.restoredGrossCredits,
      );
    }
    for (const allocation of allocations) {
      if (remaining === 0) break;
      const earning = await ctx.db.get(allocation.earningId);
      if (earning === null) throw new Error("Funded earning is missing");
      const capacity =
        allocation.grossCredits - (activeByEarning.get(earning._id) ?? 0);
      if (capacity <= 0) continue;
      const grossCredits = Math.min(capacity, remaining);
      const amountAtoms = publisherEarningSplit(grossCredits).publisherNetAtoms;
      const now = Date.now();
      await ctx.db.insert("publisherClawbacks", {
        paymentId: args.paymentId,
        consumerOrganizationId: args.consumerOrganizationId,
        publisherOrganizationId: earning.publisherOrganizationId,
        earningId: earning._id,
        sourceKind: args.sourceKind,
        sourceRef: args.sourceRef,
        grossCredits,
        amountAtoms,
        restoredGrossCredits: 0,
        restoredAtoms: 0,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(earning._id, {
        clawedBackGrossCredits: earning.clawedBackGrossCredits + grossCredits,
        clawedBackAtoms: earning.clawedBackAtoms + amountAtoms,
        releasedAtoms:
          earning.status === "pending_risk"
            ? earning.releasedAtoms
            : earning.releasedAtoms - amountAtoms,
        status:
          earning.status === "pending_risk"
            ? "pending_risk"
            : earning.clawedBackGrossCredits + grossCredits ===
                earning.grossCredits
              ? "reversed"
              : earning.status,
        updatedAt: now,
      });
      if (earning.status !== "pending_risk") {
        const balance = await getOrCreatePublisherBalance(
          ctx,
          earning.publisherOrganizationId,
        );
        const clawed = await appendPublisherSettlementEntry(ctx, {
          balance,
          kind:
            args.sourceKind === "refund"
              ? "refund_clawback"
              : "dispute_clawback",
          availableDeltaAtoms: -amountAtoms,
          allocatedDeltaAtoms: 0,
          paidDeltaAtoms: 0,
          refId: `${args.sourceRef}:clawback:${earning._id}`,
          earningId: earning._id,
          paymentId: args.paymentId,
        });
        await adjustPublisherBalanceAggregates(ctx, clawed.balance, {
          reversedAtoms: amountAtoms,
        });
      } else {
        const balance = await getOrCreatePublisherBalance(
          ctx,
          earning.publisherOrganizationId,
        );
        await adjustPublisherBalanceAggregates(ctx, balance, {
          pendingRiskAtoms: -amountAtoms,
          reversedAtoms: amountAtoms,
        });
      }
      activeByEarning.set(
        earning._id,
        (activeByEarning.get(earning._id) ?? 0) + grossCredits,
      );
      activeGrossCredits += grossCredits;
      remaining -= grossCredits;
    }
    if (remaining !== 0) {
      throw new Error("Payment reversal exceeds consumed funding allocations");
    }
  } else if (activeGrossCredits > args.targetGrossCredits) {
    let remaining = activeGrossCredits - args.targetGrossCredits;
    const newestFirst = [...rows].sort(
      (left, right) => right.createdAt - left.createdAt,
    );
    for (const row of newestFirst) {
      if (remaining === 0) break;
      const active = row.grossCredits - row.restoredGrossCredits;
      if (active <= 0) continue;
      const grossCredits = Math.min(active, remaining);
      const amountAtoms = publisherEarningSplit(grossCredits).publisherNetAtoms;
      const earning = await ctx.db.get(row.earningId);
      if (earning === null) throw new Error("Clawed-back earning is missing");
      const now = Date.now();
      await ctx.db.patch(row._id, {
        restoredGrossCredits: row.restoredGrossCredits + grossCredits,
        restoredAtoms: row.restoredAtoms + amountAtoms,
        updatedAt: now,
      });
      const clawedBackGrossCredits =
        earning.clawedBackGrossCredits - grossCredits;
      const clawedBackAtoms = earning.clawedBackAtoms - amountAtoms;
      if (clawedBackGrossCredits < 0 || clawedBackAtoms < 0) {
        throw new Error("Publisher clawback restoration underflow");
      }
      const wasReleased = earning.status !== "pending_risk";
      await ctx.db.patch(earning._id, {
        clawedBackGrossCredits,
        clawedBackAtoms,
        releasedAtoms: wasReleased
          ? earning.releasedAtoms + amountAtoms
          : earning.releasedAtoms,
        status: wasReleased ? "available" : "pending_risk",
        updatedAt: now,
      });
      if (wasReleased) {
        const balance = await getOrCreatePublisherBalance(
          ctx,
          earning.publisherOrganizationId,
        );
        const restored = await appendPublisherSettlementEntry(ctx, {
          balance,
          kind: "dispute_restoration",
          availableDeltaAtoms: amountAtoms,
          allocatedDeltaAtoms: 0,
          paidDeltaAtoms: 0,
          refId: `${args.sourceRef}:restore:${row._id}`,
          earningId: earning._id,
          paymentId: args.paymentId,
        });
        await adjustPublisherBalanceAggregates(ctx, restored.balance, {
          reversedAtoms: -amountAtoms,
        });
      } else {
        const balance = await getOrCreatePublisherBalance(
          ctx,
          earning.publisherOrganizationId,
        );
        await adjustPublisherBalanceAggregates(ctx, balance, {
          pendingRiskAtoms: amountAtoms,
          reversedAtoms: -amountAtoms,
        });
      }
      activeGrossCredits -= grossCredits;
      remaining -= grossCredits;
    }
  }

  return { activeGrossCredits };
}
