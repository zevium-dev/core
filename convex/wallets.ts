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

export type ReleaseProbeAccounting = {
  requestId: string;
  challenge: string;
  credits: number;
  platformFeeCredits: number;
  publisherNetCredits: number;
};

const RELEASE_REQUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RELEASE_CHALLENGE_RE = /^[0-9a-f]{64}$/;
const RELEASE_SHA_RE = /^[0-9a-f]{40}$/;

async function getOrCreateWallet(
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

function checkpoint(
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
async function appendWalletEntry(
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
    balanceAfter: balance,
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

/**
 * One-time release correlation. HTTP auth and request bounds live in http.ts.
 * This mutation atomically rate-limits and claims a challenge only after exact
 * request, fresh usage, gateway release, consumer wallet, materialized ledger,
 * and publisher split all agree.
 */
export const claimReleaseProbeAccounting = internalMutation({
  args: {
    requestId: v.string(),
    challenge: v.string(),
    notBefore: v.number(),
    expectedGatewayRelease: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<ReleaseProbeAccounting | null> => {
    if (
      !RELEASE_REQUEST_ID_RE.test(args.requestId) ||
      !RELEASE_CHALLENGE_RE.test(args.challenge) ||
      !RELEASE_SHA_RE.test(args.expectedGatewayRelease) ||
      !Number.isSafeInteger(args.notBefore) ||
      !Number.isSafeInteger(args.now) ||
      args.notBefore <= 0 ||
      args.now <= 0
    ) {
      throw new Error("Release probe claim is invalid");
    }
    const gateKey = "release-probe-accounting";
    const windowMs = 60_000;
    const maxRequests = 60;
    const gate = await ctx.db
      .query("releaseProbeGates")
      .withIndex("by_key", (q) => q.eq("key", gateKey))
      .unique();
    if (gate === null) {
      await ctx.db.insert("releaseProbeGates", {
        key: gateKey,
        windowStartedAt: args.now,
        count: 1,
      });
    } else if (args.now - gate.windowStartedAt >= windowMs) {
      await ctx.db.patch(gate._id, { windowStartedAt: args.now, count: 1 });
    } else {
      if (gate.count >= maxRequests) {
        throw new Error("Release probe rate limit exceeded");
      }
      await ctx.db.patch(gate._id, { count: gate.count + 1 });
    }

    const priorClaim = await ctx.db
      .query("releaseProbeClaims")
      .withIndex("by_challenge", (q) => q.eq("challenge", args.challenge))
      .unique();
    if (priorClaim !== null) {
      throw new Error("Release probe challenge was already claimed");
    }

    const settlementRefId = `settle:${args.requestId}`;
    const ledger = await ctx.db
      .query("walletEntries")
      .withIndex("by_ref", (q) => q.eq("refId", settlementRefId))
      .unique();
    if (ledger === null) return null;
    if (
      ledger.kind !== "usage_settlement" ||
      ledger.usageEventId === undefined
    ) {
      throw new Error("Release probe settlement has invalid ledger linkage");
    }

    const usage = await ctx.db.get(ledger.usageEventId);
    if (
      usage === null ||
      usage.settleRefId !== settlementRefId ||
      usage.releaseChallenge !== args.challenge ||
      usage.gatewayRelease !== args.expectedGatewayRelease ||
      usage.at < args.notBefore ||
      usage.at > args.now + 30_000 ||
      args.now - usage.at > 5 * 60_000 ||
      usage.credits <= 0 ||
      usage.status < 200 ||
      usage.status >= 300 ||
      ledger.amount !== -usage.credits
    ) {
      throw new Error("Release probe usage linkage is invalid");
    }
    const wallet = await ctx.db.get(ledger.walletId);
    if (wallet === null || wallet.organizationId !== usage.organizationId) {
      throw new Error("Release probe consumer wallet linkage is invalid");
    }
    const latestLedger = await ctx.db
      .query("walletEntries")
      .withIndex("by_wallet_sequence", (q) => q.eq("walletId", wallet._id))
      .order("desc")
      .first();
    if (
      latestLedger === null ||
      latestLedger.sequence !== wallet.sequence ||
      latestLedger.balanceAfter === undefined ||
      latestLedger.balanceAfter !== wallet.balance ||
      ledger.sequence > wallet.sequence
    ) {
      throw new Error("Release probe wallet checkpoint is invalid");
    }
    const project = await ctx.db.get(usage.projectId);
    if (project === null) throw new Error("Release probe project is missing");
    const earning = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_settlement", (q) =>
        q.eq("usageSettlementRefId", settlementRefId),
      )
      .unique();
    if (
      earning === null ||
      earning.projectId !== project._id ||
      earning.publisherOrganizationId !== project.organizationId ||
      earning.grossCredits !== usage.credits ||
      earning.status !== "pending_risk"
    ) {
      throw new Error("Release probe publisher accounting is invalid");
    }
    const split = publisherEarningSplit(usage.credits);
    if (
      earning.platformFeeCredits !== split.platformFeeCredits ||
      earning.netCredits !== split.publisherNetCredits
    ) {
      throw new Error("Release probe publisher split is invalid");
    }

    await ctx.db.insert("releaseProbeClaims", {
      challenge: args.challenge,
      requestId: args.requestId,
      settlementRefId,
      expectedGatewayRelease: args.expectedGatewayRelease,
      claimedAt: args.now,
    });

    return {
      requestId: args.requestId,
      challenge: args.challenge,
      credits: usage.credits,
      platformFeeCredits: earning.platformFeeCredits,
      publisherNetCredits: earning.netCredits,
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
  releaseChallenge: v.optional(v.string()),
  gatewayRelease: v.optional(v.string()),
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
        !Number.isSafeInteger(event.at) ||
        !Number.isSafeInteger(event.status) ||
        !Number.isFinite(event.latencyMs)
      ) {
        results.push({
          refId: event.settleRefId,
          status: "rejected",
          reason: "invalid settlement",
        });
        continue;
      }
      if (
        (event.releaseChallenge === undefined) !==
          (event.gatewayRelease === undefined) ||
        (event.releaseChallenge !== undefined &&
          !RELEASE_CHALLENGE_RE.test(event.releaseChallenge)) ||
        (event.gatewayRelease !== undefined &&
          !RELEASE_SHA_RE.test(event.gatewayRelease))
      ) {
        results.push({
          refId: event.settleRefId,
          status: "rejected",
          reason: "invalid release metadata",
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
        releaseChallenge: event.releaseChallenge,
        gatewayRelease: event.gatewayRelease,
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
          projectId: project._id,
          usageSettlementRefId: event.settleRefId,
          grossCredits: split.grossCredits,
          platformFeeCredits: split.platformFeeCredits,
          netCredits: split.publisherNetCredits,
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
