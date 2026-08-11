import { v } from "convex/values";
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
  const organization = await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", clerkOrgId))
    .unique();
  return organization?.archivedAt === undefined ? organization : null;
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
): Promise<{ applied: boolean; wallet: Doc<"wallets"> }> {
  const existing = await ctx.db
    .query("walletEntries")
    .withIndex("by_ref", (q) => q.eq("refId", args.refId))
    .unique();
  if (existing !== null) {
    if (existing.walletId !== args.wallet._id) {
      throw new Error("Wallet ledger reference belongs to another wallet");
    }
    const wallet = await ctx.db.get(existing.walletId);
    if (wallet === null) throw new Error("Wallet missing for existing entry");
    return { applied: false, wallet };
  }

  const sequence = args.wallet.sequence + 1;
  const balance = args.wallet.balance + args.amount;
  await ctx.db.insert("walletEntries", {
    walletId: args.wallet._id,
    kind: args.kind,
    amount: args.amount,
    refId: args.refId,
    sequence,
    paymentId: args.paymentId,
    usageEventId: args.usageEventId,
    createdAt: Date.now(),
  });
  await ctx.db.patch(args.wallet._id, { balance, sequence });

  return {
    applied: true,
    wallet: { ...args.wallet, balance, sequence },
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
    return {
      ...checkpoint(organization.clerkOrgId, result.wallet),
      applied: result.applied,
    };
  },
});

/** Refund/dispute reversals are permitted to create debt. */
export const reversePaymentCredits = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    paymentId: v.id("payments"),
    amount: v.number(),
    refId: v.string(),
    kind: v.union(v.literal("refund_reversal"), v.literal("dispute_reversal")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<WalletCheckpoint & { applied: boolean }> => {
    if (!Number.isSafeInteger(args.amount) || args.amount <= 0) {
      throw new Error("Payment reversal must be a positive integer");
    }
    const organization = await ctx.db.get(args.organizationId);
    if (organization === null) throw new Error("Organization not found");
    const wallet = await getOrCreateWallet(ctx, organization._id);
    const result = await appendWalletEntry(ctx, {
      wallet,
      kind: args.kind,
      amount: -args.amount,
      refId: args.refId,
      paymentId: args.paymentId,
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
    const result = await appendWalletEntry(ctx, {
      wallet,
      kind: "admin_adjustment",
      amount: args.amount,
      refId: args.refId,
    });
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
});

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
        });
        continue;
      }

      const existing = await ctx.db
        .query("walletEntries")
        .withIndex("by_ref", (q) => q.eq("refId", event.settleRefId))
        .unique();
      if (existing !== null) {
        if (existing.walletId === wallet._id) {
          results.push({ refId: event.settleRefId, status: "already_applied" });
        } else {
          results.push({
            refId: event.settleRefId,
            status: "rejected",
            reason: "settlement reference belongs to another wallet",
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
        });
        continue;
      }
      if (wallet.balance - event.credits < 0) {
        results.push({
          refId: event.settleRefId,
          status: "rejected",
          reason: "insufficient authoritative balance",
        });
        continue;
      }

      const usageEventId = await ctx.db.insert("usageEvents", {
        organizationId: consumerOrg._id,
        projectId: event.projectId,
        endpoint: event.endpoint,
        method: event.method,
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
      const existingEarning = await ctx.db
        .query("publisherEarnings")
        .withIndex("by_settlement", (q) =>
          q.eq("usageSettlementRefId", event.settleRefId),
        )
        .unique();
      if (existingEarning === null) {
        const now = Date.now();
        await ctx.db.insert("publisherEarnings", {
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
      }
      results.push({ refId: event.settleRefId, status: "applied" });
    }

    return { results, wallet: checkpoint(clerkOrgId, wallet) };
  },
});
