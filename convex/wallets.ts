import { v } from "convex/values";
import {
  MAX_ENDPOINT_COST_CREDITS,
  MAX_USAGE_INGEST_EVENTS,
} from "@zevium/shared";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireOrgMemberBySlug } from "./lib/auth";
import { toGatewayRow, type GatewayKeySettingRow } from "./keySettings";
import { PUBLISHER_RISK_HOLD_MS, publisherEarningSplit } from "./accounting";
import {
  adjustPublisherBalanceAggregates,
  getOrCreatePublisherBalance,
} from "./lib/publisherLedger";
import {
  commitFundingAllocation,
  FundingInvariantError,
  MAX_FUNDING_WRITE_UNITS_PER_BATCH,
  preflightFundingAllocation,
  recordPositiveFundingSource,
  requireVerifiedWalletFunding,
  type FundingPlan,
} from "./lib/funding";
import { assertFinanceMigrationAllowsRuntime } from "./lib/financeMigrationGate";
import { settlementIdentityFingerprint } from "./lib/settlementIdentity";

export type SettlementStatus = "applied" | "already_applied" | "rejected";

export type WalletCheckpoint = {
  clerkOrgId: string;
  balance: number;
  sequence: number;
};

export type SettlementResult = {
  refId: string;
  status: SettlementStatus;
  reason?: string;
  retryable?: boolean;
};

export async function getOrCreateWallet(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
): Promise<Doc<"wallets">> {
  const existing = await ctx.db
    .query("wallets")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .unique();
  if (existing !== null) return existing;

  const walletId = await ctx.db.insert("wallets", {
    organizationId,
    balance: 0,
    sequence: 0,
    debtCredits: 0,
  });
  await ctx.db.insert("walletFundingStates", {
    walletId,
    organizationId,
    nonrefundableAvailableCredits: 0,
    refundableAvailableCredits: 0,
    allocatedCredits: 0,
    reversedCredits: 0,
    sequence: 0,
    migrationStatus: "verified",
    migrationWatermarkSequence: 0,
    updatedAt: Date.now(),
  });
  const wallet = await ctx.db.get(walletId);
  if (wallet === null) throw new Error("Failed to create wallet");
  return wallet;
}

async function getWalletForOrg(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
): Promise<Doc<"wallets"> | null> {
  return await ctx.db
    .query("wallets")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .unique();
}

async function getOrganizationByClerkId(
  ctx: QueryCtx | MutationCtx,
  clerkOrgId: string,
): Promise<Doc<"organizations"> | null> {
  return await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", clerkOrgId))
    .unique();
}

export function checkpoint(
  clerkOrgId: string,
  wallet: Pick<Doc<"wallets">, "balance" | "sequence">,
): WalletCheckpoint {
  return {
    clerkOrgId,
    balance: wallet.balance,
    sequence: wallet.sequence,
  };
}

type WalletEntryKind = Doc<"walletEntries">["kind"];

/**
 * Append one signed ledger entry and materialize the new balance/version in the
 * same Convex transaction. Callers must use a stable, globally unique refId.
 */
export async function appendWalletEntry(
  ctx: MutationCtx,
  args: {
    wallet: Doc<"wallets">;
    kind: WalletEntryKind;
    amount: number;
    refId: string;
    paymentId?: Id<"payments">;
    usageEventId?: Id<"usageEvents">;
    settlementFingerprint?: string;
  },
): Promise<{
  applied: boolean;
  wallet: Doc<"wallets">;
  entryId: Id<"walletEntries">;
}> {
  const existing = await ctx.db
    .query("walletEntries")
    .withIndex("by_ref", (q) => q.eq("refId", args.refId))
    .unique();
  if (existing !== null) {
    if (
      existing.walletId !== args.wallet._id ||
      existing.kind !== args.kind ||
      existing.amount !== args.amount ||
      existing.paymentId !== args.paymentId ||
      existing.usageEventId !== args.usageEventId ||
      existing.settlementFingerprint !== args.settlementFingerprint
    ) {
      throw new Error("Wallet ledger reference immutable facts changed");
    }
    const wallet = await ctx.db.get(existing.walletId);
    if (wallet === null) throw new Error("Wallet missing for existing entry");
    return { applied: false, wallet, entryId: existing._id };
  }

  const sequence = args.wallet.sequence + 1;
  const balance = args.wallet.balance + args.amount;
  if (balance < 0) {
    throw new Error("Wallet debit exceeds authoritative balance");
  }
  const entryId = await ctx.db.insert("walletEntries", {
    walletId: args.wallet._id,
    kind: args.kind,
    amount: args.amount,
    refId: args.refId,
    sequence,
    paymentId: args.paymentId,
    usageEventId: args.usageEventId,
    settlementFingerprint: args.settlementFingerprint,
    createdAt: Date.now(),
  });
  await ctx.db.patch(args.wallet._id, {
    balance,
    sequence,
    debtCredits: 0,
  });

  return {
    applied: true,
    wallet: {
      ...args.wallet,
      balance,
      sequence,
      debtCredits: 0,
    },
    entryId,
  };
}

/** Payment fulfillment and webhook processing call this exact-once grant. */
export const grantPaymentCredits = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    paymentId: v.id("payments"),
    amount: v.number(),
    refId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<WalletCheckpoint & { applied: boolean }> => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    if (!Number.isSafeInteger(args.amount) || args.amount <= 0) {
      throw new Error("Payment grant must be a positive integer");
    }
    if (args.refId.trim() === "")
      throw new Error("Payment grant reference is required");

    const organization = await ctx.db.get(args.organizationId);
    if (organization === null) throw new Error("Organization not found");
    const payment = await ctx.db.get(args.paymentId);
    if (
      payment === null ||
      payment.organizationId !== organization._id ||
      payment.financeMigrationStatus !== "verified" ||
      payment.financeMigrationJobId !== undefined ||
      payment.walletReversedCredits === undefined ||
      payment.publisherClawbackTargetCredits === undefined ||
      payment.reversalSequence === undefined
    ) {
      throw new Error("Payment finance migration is not verified");
    }
    if (
      payment.stripePaymentIntentId === undefined ||
      args.amount !== payment.grantedCredits ||
      args.refId !== `stripe:payment_intent:${payment.stripePaymentIntentId}`
    ) {
      throw new Error("Payment grant changed immutable provider facts");
    }
    const wallet = await getOrCreateWallet(ctx, organization._id);
    const result = await appendWalletEntry(ctx, {
      wallet,
      kind: "payment_grant",
      amount: args.amount,
      refId: args.refId,
      paymentId: args.paymentId,
    });
    if (result.applied) {
      const entry = await ctx.db.get(result.entryId);
      if (entry === null)
        throw new Error("Payment grant ledger entry is missing");
      await recordPositiveFundingSource(ctx, {
        wallet: result.wallet,
        sourceKind: "stripe_payment",
        sourceRef: args.refId,
        amount: args.amount,
        refundable: true,
        paymentId: args.paymentId,
        createdAt: entry.createdAt,
      });
    } else {
      // Duplicate grant must bind to an already-built exact source. This fails
      // closed for legacy rows until fenced migration finishes.
      await recordPositiveFundingSource(ctx, {
        wallet: result.wallet,
        sourceKind: "stripe_payment",
        sourceRef: args.refId,
        amount: args.amount,
        refundable: true,
        paymentId: args.paymentId,
        createdAt: Date.now(),
      });
    }
    return {
      ...checkpoint(organization.clerkOrgId, result.wallet),
      applied: result.applied,
    };
  },
});

export const applyAdminAdjustment = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    amount: v.number(),
    refId: v.string(),
    promotion: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<WalletCheckpoint & { applied: boolean }> => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    if (!Number.isSafeInteger(args.amount) || args.amount === 0) {
      throw new Error("Admin adjustment must be a non-zero integer");
    }
    if (
      args.refId.trim().length === 0 ||
      args.refId.length > 200 ||
      (args.promotion === true) !== args.refId.startsWith("promo:")
    ) {
      throw new Error(
        "Admin adjustment reference must match immutable promotion provenance",
      );
    }
    if (args.amount < 0 && args.promotion === true) {
      throw new Error("Negative adjustment cannot be a promotion");
    }
    const organization = await ctx.db.get(args.organizationId);
    if (organization === null) throw new Error("Organization not found");
    const wallet = await getOrCreateWallet(ctx, organization._id);
    const result = await appendWalletEntry(ctx, {
      wallet,
      kind: "admin_adjustment",
      amount: args.amount,
      refId: args.refId,
    });
    if (!result.applied) {
      if (args.amount > 0) {
        await recordPositiveFundingSource(ctx, {
          wallet: result.wallet,
          sourceKind: args.promotion ? "promotion" : "admin_adjustment",
          sourceRef: args.refId,
          amount: args.amount,
          refundable: false,
          createdAt: Date.now(),
        });
      } else {
        await requireVerifiedWalletFunding(ctx, result.wallet);
        const allocations = await ctx.db
          .query("walletFundingAllocations")
          .withIndex("by_wallet_entry", (q) =>
            q.eq("walletEntryId", result.entryId),
          )
          .take(25);
        const lots = await Promise.all(
          allocations.map(async (allocation) =>
            allocation.fundingLotId === undefined
              ? null
              : await ctx.db.get(allocation.fundingLotId),
          ),
        );
        if (
          allocations.length === 0 ||
          allocations.length > 24 ||
          allocations.some((allocation, index) => {
            const lot = lots[index];
            return (
              allocation.kind !== "negative_adjustment" ||
              allocation.fundingLotId === undefined ||
              allocation.walletId !== result.wallet._id ||
              allocation.organizationId !== organization._id ||
              allocation.walletEntryId !== result.entryId ||
              allocation.usageEventId !== undefined ||
              allocation.earningId !== undefined ||
              allocation.grossCredits <= 0 ||
              allocation.clawedBackGrossCredits !== 0 ||
              lot === null ||
              lot.walletId !== result.wallet._id ||
              lot.organizationId !== organization._id ||
              allocation.paymentId !== lot.paymentId
            );
          }) ||
          allocations.reduce(
            (sum, allocation) => sum + allocation.grossCredits,
            0,
          ) !== -args.amount
        ) {
          throw new Error(
            "Negative adjustment replay lacks exact funding provenance",
          );
        }
      }
      return {
        ...checkpoint(organization.clerkOrgId, result.wallet),
        applied: false,
      };
    }
    const entry = await ctx.db.get(result.entryId);
    if (entry === null) throw new Error("Admin adjustment entry is missing");
    if (args.amount > 0) {
      await recordPositiveFundingSource(ctx, {
        wallet: result.wallet,
        sourceKind: args.promotion ? "promotion" : "admin_adjustment",
        sourceRef: args.refId,
        amount: args.amount,
        refundable: false,
        createdAt: entry.createdAt,
      });
    } else {
      // Append first establishes exact immutable duplicate binding. Preflight
      // failure rolls back ledger append and materialized wallet atomically.
      const plan = await preflightFundingAllocation(ctx, {
        wallet,
        credits: -args.amount,
      });
      await commitFundingAllocation(ctx, {
        plan,
        walletEntryId: result.entryId,
        walletId: wallet._id,
        walletSequence: result.wallet.sequence,
        organizationId: organization._id,
        kind: "negative_adjustment",
        createdAt: entry.createdAt,
      });
    }
    return {
      ...checkpoint(organization.clerkOrgId, result.wallet),
      applied: result.applied,
    };
  },
});

export type GatewayWalletView = {
  wallet: WalletCheckpoint;
  keySettings: GatewayKeySettingRow[];
};

/**
 * Authoritative checkpoint for the Wallet DO. The edge never rebuilds a
 * ledger from grants; it accepts only strictly newer `sequence` values.
 */
export const getGatewayWallet = internalQuery({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args): Promise<GatewayWalletView> => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    const organization = await getOrganizationByClerkId(ctx, args.clerkOrgId);
    const wallet =
      organization === null
        ? null
        : await getWalletForOrg(ctx, organization._id);
    if (wallet !== null) {
      await requireVerifiedWalletFunding(ctx, wallet);
    }
    const settings = await ctx.db
      .query("keySettings")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .take(1_001);
    if (settings.length > 1_000) {
      throw new Error("Gateway key settings exceed bounded sync capacity");
    }

    return {
      wallet:
        wallet === null
          ? { clerkOrgId: args.clerkOrgId, balance: 0, sequence: 0 }
          : checkpoint(args.clerkOrgId, wallet),
      keySettings: settings.map(toGatewayRow),
    };
  },
});

export type WalletEntryView = {
  _id: Id<"walletEntries">;
  kind: Doc<"walletEntries">["kind"];
  amount: number;
  refId: string;
  sequence: number;
  createdAt: number;
};

export type WalletView = {
  balance: number;
  sequence: number;
  walletId: Id<"wallets"> | null;
  entries: WalletEntryView[];
};

async function walletView(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
): Promise<WalletView> {
  await assertFinanceMigrationAllowsRuntime(ctx);
  const wallet = await getWalletForOrg(ctx, organizationId);
  if (wallet === null) {
    return { balance: 0, sequence: 0, walletId: null, entries: [] };
  }
  await requireVerifiedWalletFunding(ctx, wallet);
  const entries = await ctx.db
    .query("walletEntries")
    .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id))
    .order("desc")
    .take(50);
  return {
    balance: wallet.balance,
    sequence: wallet.sequence,
    walletId: wallet._id,
    entries: entries.map((entry) => ({
      _id: entry._id,
      kind: entry.kind,
      amount: entry.amount,
      refId: entry.refId,
      sequence: entry.sequence,
      createdAt: entry.createdAt,
    })),
  };
}

export const getMyWallet = query({
  args: { orgSlug: v.string() },
  handler: async (ctx, args): Promise<WalletView> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    return await walletView(ctx, org._id);
  },
});

export const ensureWallet = mutation({
  args: { orgSlug: v.string() },
  handler: async (ctx, args): Promise<WalletView> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    await getOrCreateWallet(ctx, org._id);
    return await walletView(ctx, org._id);
  },
});

const usageEventArg = v.object({
  organizationId: v.string(),
  projectId: v.string(),
  specVersionId: v.string(),
  specVersion: v.string(),
  operationId: v.string(),
  endpoint: v.string(),
  method: v.string(),
  listedCostCredits: v.number(),
  freeTierLimit: v.optional(v.number()),
  freeTierUsedBefore: v.optional(v.number()),
  pricingDecision: v.union(
    v.literal("listed_price"),
    v.literal("free_tier"),
    v.literal("zero_price"),
  ),
  credits: v.number(),
  status: v.number(),
  latencyMs: v.number(),
  keyId: v.string(),
  keyFamilyId: v.string(),
  monthlyCapCredits: v.optional(v.number()),
  budgetPeriod: v.string(),
  budgetUsedBefore: v.number(),
  budgetReservedBefore: v.number(),
  budgetReservationCredits: v.number(),
  at: v.number(),
  reservationId: v.string(),
  settleRefId: v.string(),
  ambiguous: v.optional(v.boolean()),
  publisherIdempotencyKey: v.optional(v.string()),
  /** The only consumer identity accepted for a Wallet DO settlement. */
  consumerClerkOrgId: v.string(),
});

type UsageEventArg = {
  organizationId: string;
  projectId: string;
  specVersionId: string;
  specVersion: string;
  operationId: string;
  endpoint: string;
  method: string;
  listedCostCredits: number;
  freeTierLimit?: number;
  freeTierUsedBefore?: number;
  pricingDecision: "listed_price" | "free_tier" | "zero_price";
  credits: number;
  status: number;
  latencyMs: number;
  keyId: string;
  keyFamilyId: string;
  monthlyCapCredits?: number;
  budgetPeriod: string;
  budgetUsedBefore: number;
  budgetReservedBefore: number;
  budgetReservationCredits: number;
  at: number;
  reservationId: string;
  settleRefId: string;
  ambiguous?: boolean;
  publisherIdempotencyKey?: string;
  consumerClerkOrgId: string;
};

type SettlementBinding = {
  consumerOrganizationId: Id<"organizations">;
  publisherOrganizationId: Id<"organizations">;
  projectId: Id<"projects">;
  specVersionId: Id<"specVersions">;
  event: UsageEventArg;
};

async function settlementFingerprint(
  binding: SettlementBinding,
): Promise<string> {
  const { event } = binding;
  return await settlementIdentityFingerprint({
    ...event,
    consumerOrganizationId: binding.consumerOrganizationId,
    publisherOrganizationId: binding.publisherOrganizationId,
    projectId: binding.projectId,
    specVersionId: binding.specVersionId,
  });
}

function validSettlementBoundary(event: UsageEventArg): boolean {
  return (
    event.settleRefId.trim().length > 0 &&
    event.settleRefId.length <= 200 &&
    event.reservationId.trim().length > 0 &&
    event.reservationId.length <= 180 &&
    event.settleRefId === `settle:${event.reservationId}` &&
    event.consumerClerkOrgId.trim().length > 0 &&
    event.consumerClerkOrgId.length <= 256 &&
    event.endpoint.trim().length > 0 &&
    event.endpoint.length <= 2_048 &&
    event.operationId.trim().length > 0 &&
    event.operationId.length <= 512 &&
    event.specVersion.trim().length > 0 &&
    event.specVersion.length <= 128 &&
    event.method.trim().length > 0 &&
    event.method.length <= 16 &&
    event.keyId.trim().length > 0 &&
    event.keyId.length <= 256 &&
    event.keyFamilyId.trim().length > 0 &&
    event.keyFamilyId.length <= 256 &&
    /^\d{4}-\d{2}$/.test(event.budgetPeriod) &&
    (event.publisherIdempotencyKey === undefined ||
      (event.publisherIdempotencyKey.trim().length > 0 &&
        event.publisherIdempotencyKey.length <= 256)) &&
    Number.isSafeInteger(event.credits) &&
    event.credits >= 0 &&
    event.credits <= MAX_ENDPOINT_COST_CREDITS &&
    Number.isSafeInteger(event.listedCostCredits) &&
    event.listedCostCredits >= 0 &&
    event.listedCostCredits <= MAX_ENDPOINT_COST_CREDITS &&
    (event.freeTierLimit === undefined ||
      (Number.isSafeInteger(event.freeTierLimit) &&
        event.freeTierLimit > 0)) &&
    (event.freeTierUsedBefore === undefined ||
      (Number.isSafeInteger(event.freeTierUsedBefore) &&
        event.freeTierUsedBefore >= 0)) &&
    (event.monthlyCapCredits === undefined ||
      (Number.isSafeInteger(event.monthlyCapCredits) &&
        event.monthlyCapCredits > 0)) &&
    Number.isSafeInteger(event.budgetUsedBefore) &&
    event.budgetUsedBefore >= 0 &&
    Number.isSafeInteger(event.budgetReservedBefore) &&
    event.budgetReservedBefore >= 0 &&
    Number.isSafeInteger(event.budgetReservationCredits) &&
    event.budgetReservationCredits >= 0 &&
    (event.monthlyCapCredits === undefined ||
      event.budgetUsedBefore +
        event.budgetReservedBefore +
        event.budgetReservationCredits <=
        event.monthlyCapCredits) &&
    ((event.pricingDecision === "listed_price" &&
      event.listedCostCredits > 0 &&
      event.credits === event.listedCostCredits &&
      event.budgetReservationCredits === event.credits &&
      (event.freeTierLimit === undefined ||
        (event.freeTierUsedBefore !== undefined &&
          event.freeTierUsedBefore >= event.freeTierLimit))) ||
      (event.pricingDecision === "free_tier" &&
        event.listedCostCredits > 0 &&
        event.credits === 0 &&
        event.budgetReservationCredits === 0 &&
        event.freeTierLimit !== undefined &&
        event.freeTierUsedBefore !== undefined &&
        event.freeTierUsedBefore < event.freeTierLimit) ||
      (event.pricingDecision === "zero_price" &&
        event.listedCostCredits === 0 &&
        event.credits === 0 &&
        event.budgetReservationCredits === 0)) &&
    Number.isSafeInteger(event.at) &&
    event.at > 0 &&
    Number.isSafeInteger(event.status) &&
    event.status >= 100 &&
    event.status <= 599 &&
    Number.isSafeInteger(event.latencyMs) &&
    event.latencyMs >= 0 &&
    event.latencyMs <= 86_400_000
  );
}

async function duplicateSettlementMatches(
  ctx: MutationCtx,
  entry: Doc<"walletEntries">,
  walletId: Id<"wallets">,
  binding: SettlementBinding,
): Promise<boolean> {
  const fingerprint = await settlementFingerprint(binding);
  if (
    entry.walletId !== walletId ||
    entry.kind !== "usage_settlement" ||
    entry.amount !== -binding.event.credits ||
    entry.usageEventId === undefined
  ) {
    return false;
  }
  if (entry.settlementFingerprint !== undefined) {
    return entry.settlementFingerprint === fingerprint;
  }
  // V2 callers always supply facts legacy rows cannot prove. No downgrade.
  return false;
}

/**
 * Gateway settlement ingest. A request belongs to precisely one consumer
 * Wallet DO, so mixed-organizations are rejected before any ledger mutation.
 * Every event receives a durable outcome; callers retain only rejected items.
 */
export const recordUsage = internalMutation({
  args: { events: v.array(usageEventArg) },
  handler: async (
    ctx,
    args,
  ): Promise<{ results: SettlementResult[]; wallet: WalletCheckpoint }> => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    if (args.events.length === 0) {
      throw new Error("At least one settlement is required");
    }
    if (args.events.length > MAX_USAGE_INGEST_EVENTS) {
      throw new Error(
        `Settlement batch exceeds ${MAX_USAGE_INGEST_EVENTS} events`,
      );
    }
    const clerkOrgId = args.events[0]!.consumerClerkOrgId;
    if (
      clerkOrgId.trim() === "" ||
      args.events.some((event) => event.consumerClerkOrgId !== clerkOrgId)
    ) {
      throw new Error(
        "All settlements must belong to one consumer organization",
      );
    }

    const consumerOrg = await getOrganizationByClerkId(ctx, clerkOrgId);
    if (consumerOrg === null) {
      return {
        results: args.events.map((event) => ({
          refId: event.settleRefId,
          status: "rejected" as const,
          reason: "consumer organization not found",
          retryable: false,
        })),
        wallet: { clerkOrgId, balance: 0, sequence: -1 },
      };
    }
    let wallet = await getOrCreateWallet(ctx, consumerOrg._id);
    try {
      await requireVerifiedWalletFunding(ctx, wallet);
    } catch (error) {
      if (!(error instanceof FundingInvariantError)) throw error;
      return {
        results: args.events.map((event) => ({
          refId: event.settleRefId,
          status: "rejected" as const,
          reason: "wallet finance migration is not verified",
          retryable: true,
        })),
        wallet: checkpoint(clerkOrgId, wallet),
      };
    }
    const results: SettlementResult[] = [];
    let projectedWriteUnits = 0;

    for (const event of args.events) {
      if (!validSettlementBoundary(event)) {
        results.push({
          refId: event.settleRefId,
          status: "rejected",
          reason: "invalid settlement",
          retryable: false,
        });
        continue;
      }

      const publisherOrganizationId = ctx.db.normalizeId(
        "organizations",
        event.organizationId,
      );
      const projectId = ctx.db.normalizeId("projects", event.projectId);
      const specVersionId = ctx.db.normalizeId(
        "specVersions",
        event.specVersionId,
      );
      const project = projectId === null ? null : await ctx.db.get(projectId);
      const specVersion =
        specVersionId === null ? null : await ctx.db.get(specVersionId);
      if (
        projectId === null ||
        project === null ||
        specVersionId === null ||
        specVersion === null ||
        specVersion.projectId !== projectId ||
        specVersion.version !== event.specVersion
      ) {
        results.push({
          refId: event.settleRefId,
          status: "rejected",
          reason: "immutable project spec version not found",
          retryable: false,
        });
        continue;
      }
      if (
        publisherOrganizationId === null ||
        project.organizationId !== publisherOrganizationId
      ) {
        results.push({
          refId: event.settleRefId,
          status: "rejected",
          reason: "publisher organization does not own project",
          retryable: false,
        });
        continue;
      }
      const binding: SettlementBinding = {
        consumerOrganizationId: consumerOrg._id,
        publisherOrganizationId,
        projectId,
        specVersionId,
        event,
      };
      const fingerprint = await settlementFingerprint(binding);

      const existing = await ctx.db
        .query("walletEntries")
        .withIndex("by_ref", (q) => q.eq("refId", event.settleRefId))
        .unique();
      if (existing !== null) {
        if (
          await duplicateSettlementMatches(ctx, existing, wallet._id, binding)
        ) {
          results.push({ refId: event.settleRefId, status: "already_applied" });
        } else {
          results.push({
            refId: event.settleRefId,
            status: "rejected",
            reason: "settlement replay changed immutable payload or linkage",
            retryable: false,
          });
        }
        continue;
      }

      if (wallet.balance < event.credits) {
        results.push({
          refId: event.settleRefId,
          status: "rejected",
          reason: "reservation checkpoint is stale after ledger debit",
          retryable: false,
        });
        continue;
      }

      let fundingPlan: FundingPlan;
      try {
        fundingPlan = await preflightFundingAllocation(ctx, {
          wallet,
          credits: event.credits,
        });
      } catch (error) {
        if (!(error instanceof FundingInvariantError)) throw error;
        results.push({
          refId: event.settleRefId,
          status: "rejected",
          reason: error.message,
          retryable: error.retryable,
        });
        continue;
      }
      const eventWriteUnits = fundingPlan.estimatedWriteUnits + 8;
      if (
        projectedWriteUnits + eventWriteUnits >
        MAX_FUNDING_WRITE_UNITS_PER_BATCH
      ) {
        results.push({
          refId: event.settleRefId,
          status: "rejected",
          reason: "settlement batch reached bounded transaction write budget",
          retryable: true,
        });
        continue;
      }
      projectedWriteUnits += eventWriteUnits;

      const now = Date.now();
      const usageEventId = await ctx.db.insert("usageEvents", {
        organizationId: consumerOrg._id,
        publisherOrganizationId,
        projectId,
        specVersionId,
        specVersion: event.specVersion,
        operationId: event.operationId,
        projectName: project.name,
        projectSlug: project.slug,
        endpoint: event.endpoint,
        method: event.method,
        listedCostCredits: event.listedCostCredits,
        freeTierLimit: event.freeTierLimit,
        freeTierUsedBefore: event.freeTierUsedBefore,
        pricingDecision: event.pricingDecision,
        credits: event.credits,
        status: event.status,
        latencyMs: event.latencyMs,
        keyId: event.keyId,
        keyFamilyId: event.keyFamilyId,
        monthlyCapCredits: event.monthlyCapCredits,
        budgetPeriod: event.budgetPeriod,
        budgetUsedBefore: event.budgetUsedBefore,
        budgetReservedBefore: event.budgetReservedBefore,
        budgetReservationCredits: event.budgetReservationCredits,
        at: event.at,
        reservationId: event.reservationId,
        settlementIdentityVersion: 2,
        settleRefId: event.settleRefId,
        ambiguous: event.ambiguous,
        publisherIdempotencyKey: event.publisherIdempotencyKey,
      });
      const settled = await appendWalletEntry(ctx, {
        wallet,
        kind: "usage_settlement",
        amount: -event.credits,
        refId: event.settleRefId,
        usageEventId,
        settlementFingerprint: fingerprint,
      });
      wallet = settled.wallet;

      const split = publisherEarningSplit(event.credits);
      const earningId = await ctx.db.insert("publisherEarnings", {
        publisherOrganizationId: project.organizationId,
        consumerOrganizationId: consumerOrg._id,
        projectId: project._id,
        specVersionId,
        projectName: project.name,
        projectSlug: project.slug,
        usageSettlementRefId: event.settleRefId,
        grossCredits: split.grossCredits,
        platformFeeAtoms: split.platformFeeAtoms,
        publisherNetAtoms: split.publisherNetAtoms,
        platformFeeCredits: split.platformFeeCredits,
        netCredits: split.publisherNetCredits,
        clawedBackGrossCredits: 0,
        clawedBackAtoms: 0,
        releasedAtoms: 0,
        availableAt: now + PUBLISHER_RISK_HOLD_MS,
        status: "pending_risk",
        createdAt: now,
        updatedAt: now,
      });
      const publisherBalance = await getOrCreatePublisherBalance(
        ctx,
        project.organizationId,
      );
      if (split.publisherNetAtoms > 0) {
        await adjustPublisherBalanceAggregates(ctx, publisherBalance, {
          pendingRiskAtoms: split.publisherNetAtoms,
        });
      }
      await commitFundingAllocation(ctx, {
        plan: fundingPlan,
        walletEntryId: settled.entryId,
        walletId: wallet._id,
        walletSequence: settled.wallet.sequence,
        organizationId: consumerOrg._id,
        kind: "usage",
        usageEventId,
        earningId,
        publisherOrganizationId: project.organizationId,
        createdAt: now,
      });
      results.push({ refId: event.settleRefId, status: "applied" });
    }

    return { results, wallet: checkpoint(clerkOrgId, wallet) };
  },
});
