import { v } from "convex/values";
import {
  MAX_USAGE_INGEST_EVENTS,
  verifyReservationProof,
  type ReservationProofPayload,
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
  preflightFundingAllocation,
  recordPositiveFundingSource,
  type FundingPlan,
} from "./lib/funding";

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
      existing.usageEventId !== args.usageEventId
    ) {
      throw new Error("Wallet ledger reference immutable facts changed");
    }
    const wallet = await ctx.db.get(existing.walletId);
    if (wallet === null) throw new Error("Wallet missing for existing entry");
    return { applied: false, wallet, entryId: existing._id };
  }

  const sequence = args.wallet.sequence + 1;
  const balance = args.wallet.balance + args.amount;
  const entryId = await ctx.db.insert("walletEntries", {
    walletId: args.wallet._id,
    kind: args.kind,
    amount: args.amount,
    refId: args.refId,
    sequence,
    paymentId: args.paymentId,
    usageEventId: args.usageEventId,
    createdAt: Date.now(),
  });
  await ctx.db.patch(args.wallet._id, {
    balance,
    sequence,
    debtCredits: Math.max(0, -balance),
  });

  return {
    applied: true,
    wallet: {
      ...args.wallet,
      balance,
      sequence,
      debtCredits: Math.max(0, -balance),
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
    if (!Number.isSafeInteger(args.amount) || args.amount <= 0) {
      throw new Error("Payment grant must be a positive integer");
    }
    if (args.refId.trim() === "")
      throw new Error("Payment grant reference is required");

    const organization = await ctx.db.get(args.organizationId);
    if (organization === null) throw new Error("Organization not found");
    const wallet = await getOrCreateWallet(ctx, organization._id);
    const result = await appendWalletEntry(ctx, {
      wallet,
      kind: "payment_grant",
      amount: args.amount,
      refId: args.refId,
      paymentId: args.paymentId,
    });
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
    if (!Number.isSafeInteger(args.amount) || args.amount === 0) {
      throw new Error("Admin adjustment must be a non-zero integer");
    }
    const organization = await ctx.db.get(args.organizationId);
    if (organization === null) throw new Error("Organization not found");
    const wallet = await getOrCreateWallet(ctx, organization._id);
    const plan =
      args.amount < 0
        ? await preflightFundingAllocation(ctx, {
            wallet,
            credits: -args.amount,
            allowReservationDebt: false,
          })
        : null;
    const result = await appendWalletEntry(ctx, {
      wallet,
      kind: "admin_adjustment",
      amount: args.amount,
      refId: args.refId,
    });
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
    } else if (plan !== null) {
      await commitFundingAllocation(ctx, {
        plan,
        walletEntryId: result.entryId,
        walletId: wallet._id,
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
    const organization = await getOrganizationByClerkId(ctx, args.clerkOrgId);
    const wallet =
      organization === null
        ? null
        : await getWalletForOrg(ctx, organization._id);
    const settings = await ctx.db
      .query("keySettings")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .collect();

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
  const wallet = await getWalletForOrg(ctx, organizationId);
  if (wallet === null) {
    return { balance: 0, sequence: 0, walletId: null, entries: [] };
  }
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
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  endpoint: v.string(),
  method: v.string(),
  credits: v.number(),
  status: v.number(),
  latencyMs: v.number(),
  keyId: v.string(),
  at: v.number(),
  settleRefId: v.string(),
  /** The only consumer identity accepted for a Wallet DO settlement. */
  consumerClerkOrgId: v.string(),
  reservationProof: v.optional(
    v.object({
      checkpointSequence: v.number(),
      authorizedBalance: v.number(),
      reservedAt: v.number(),
      signature: v.string(),
    }),
  ),
});

type UsageEventArg = {
  organizationId: Id<"organizations">;
  projectId: Id<"projects">;
  endpoint: string;
  method: string;
  credits: number;
  status: number;
  latencyMs: number;
  keyId: string;
  at: number;
  settleRefId: string;
  consumerClerkOrgId: string;
  reservationProof?: {
    checkpointSequence: number;
    authorizedBalance: number;
    reservedAt: number;
    signature: string;
  };
};

function normalizedMethod(value: string): string {
  return value.trim().toUpperCase();
}

function normalizedEndpoint(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

async function duplicateSettlementMatches(
  ctx: MutationCtx,
  entry: Doc<"walletEntries">,
  walletId: Id<"wallets">,
  consumerOrganizationId: Id<"organizations">,
  event: UsageEventArg,
): Promise<boolean> {
  if (
    entry.walletId !== walletId ||
    entry.kind !== "usage_settlement" ||
    entry.amount !== -event.credits ||
    entry.usageEventId === undefined
  ) {
    return false;
  }
  const usage = await ctx.db.get(entry.usageEventId);
  if (usage === null) return false;
  return (
    usage.organizationId === consumerOrganizationId &&
    usage.projectId === event.projectId &&
    usage.credits === event.credits &&
    normalizedEndpoint(usage.endpoint) === normalizedEndpoint(event.endpoint) &&
    normalizedMethod(usage.method) === normalizedMethod(event.method) &&
    usage.status === event.status &&
    usage.latencyMs === event.latencyMs &&
    usage.keyId === event.keyId &&
    usage.at === event.at &&
    usage.settleRefId === event.settleRefId
  );
}

async function hasValidReservationProof(
  event: UsageEventArg,
): Promise<boolean> {
  const proof = event.reservationProof;
  const secret = process.env.GATEWAY_INTERNAL_SECRET ?? "";
  if (
    proof === undefined ||
    !event.settleRefId.startsWith("settle:") ||
    !Number.isSafeInteger(proof.checkpointSequence) ||
    proof.checkpointSequence < 0 ||
    !Number.isSafeInteger(proof.authorizedBalance) ||
    proof.authorizedBalance < event.credits ||
    !Number.isSafeInteger(proof.reservedAt) ||
    proof.reservedAt > event.at
  ) {
    return false;
  }
  const payload: ReservationProofPayload = {
    consumerClerkOrgId: event.consumerClerkOrgId,
    reservationId: event.settleRefId.slice("settle:".length),
    credits: event.credits,
    checkpointSequence: proof.checkpointSequence,
    authorizedBalance: proof.authorizedBalance,
    reservedAt: proof.reservedAt,
    keyId: event.keyId,
  };
  return await verifyReservationProof(secret, payload, proof.signature);
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
    if (consumerOrg === null)
      throw new Error("Consumer organization not found");
    let wallet = await getOrCreateWallet(ctx, consumerOrg._id);
    const results: SettlementResult[] = [];

    for (const event of args.events) {
      if (
        event.settleRefId.trim() === "" ||
        !Number.isSafeInteger(event.credits) ||
        event.credits < 0 ||
        !Number.isFinite(event.at) ||
        !Number.isFinite(event.status) ||
        !Number.isFinite(event.latencyMs)
      ) {
        results.push({
          refId: event.settleRefId,
          status: "rejected",
          reason: "invalid settlement",
          retryable: false,
        });
        continue;
      }

      const existing = await ctx.db
        .query("walletEntries")
        .withIndex("by_ref", (q) => q.eq("refId", event.settleRefId))
        .unique();
      if (existing !== null) {
        if (
          await duplicateSettlementMatches(
            ctx,
            existing,
            wallet._id,
            consumerOrg._id,
            event,
          )
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

      const project = await ctx.db.get(event.projectId);
      if (project === null) {
        results.push({
          refId: event.settleRefId,
          status: "rejected",
          reason: "project not found",
          retryable: false,
        });
        continue;
      }
      if (project.organizationId !== event.organizationId) {
        results.push({
          refId: event.settleRefId,
          status: "rejected",
          reason: "publisher organization does not own project",
          retryable: false,
        });
        continue;
      }

      const insufficientAuthoritativeBalance =
        wallet.balance - event.credits < 0;
      const reservationProofValid = insufficientAuthoritativeBalance
        ? await hasValidReservationProof(event)
        : false;
      if (insufficientAuthoritativeBalance && !reservationProofValid) {
        results.push({
          refId: event.settleRefId,
          status: "rejected",
          reason:
            "insufficient balance without authoritative reservation proof",
          retryable: false,
        });
        continue;
      }

      let fundingPlan: FundingPlan | null = null;
      if (event.credits > 0) {
        try {
          fundingPlan = await preflightFundingAllocation(ctx, {
            wallet,
            credits: event.credits,
            allowReservationDebt: reservationProofValid,
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
      }

      const now = Date.now();
      const usageEventId = await ctx.db.insert("usageEvents", {
        organizationId: consumerOrg._id,
        projectId: event.projectId,
        endpoint: event.endpoint,
        method: normalizedMethod(event.method),
        credits: event.credits,
        status: event.status,
        latencyMs: event.latencyMs,
        keyId: event.keyId,
        at: event.at,
        settleRefId: event.settleRefId,
      });
      const settled = await appendWalletEntry(ctx, {
        wallet,
        kind: "usage_settlement",
        amount: -event.credits,
        refId: event.settleRefId,
        usageEventId,
      });
      wallet = settled.wallet;

      const split = publisherEarningSplit(event.credits);
      const earningId = await ctx.db.insert("publisherEarnings", {
        publisherOrganizationId: project.organizationId,
        consumerOrganizationId: consumerOrg._id,
        projectId: project._id,
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
      if (fundingPlan !== null) {
        await commitFundingAllocation(ctx, {
          plan: fundingPlan,
          walletEntryId: settled.entryId,
          walletId: wallet._id,
          organizationId: consumerOrg._id,
          kind: "usage",
          usageEventId,
          earningId,
          publisherOrganizationId: project.organizationId,
          createdAt: now,
        });
      }
      results.push({ refId: event.settleRefId, status: "applied" });
    }

    return { results, wallet: checkpoint(clerkOrgId, wallet) };
  },
});
