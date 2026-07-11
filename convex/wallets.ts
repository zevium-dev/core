import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireOrgMemberBySlug } from "./lib/auth";

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
  });
  const created = await ctx.db.get(walletId);
  if (created === null) {
    throw new Error("Failed to create wallet");
  }
  return created;
}

/**
 * Grant prepaid credits to an org wallet (Polar webhook / admin).
 * Idempotent on grantRefId via walletEntries.by_ref.
 */
export const grantCredits = internalMutation({
  args: {
    clerkOrgId: v.string(),
    amount: v.number(),
    grantRefId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    applied: boolean;
    balance: number;
    walletId: Id<"wallets">;
  }> => {
    if (!Number.isFinite(args.amount) || args.amount <= 0) {
      throw new Error("Grant amount must be a positive number");
    }
    if (args.grantRefId.trim() === "") {
      throw new Error("grantRefId is required");
    }

    const existingEntry = await ctx.db
      .query("walletEntries")
      .withIndex("by_ref", (q) => q.eq("refId", args.grantRefId))
      .unique();
    if (existingEntry !== null) {
      const wallet = await ctx.db.get(existingEntry.walletId);
      if (wallet === null) {
        throw new Error("Wallet missing for existing grant entry");
      }
      return {
        applied: false,
        balance: wallet.balance,
        walletId: wallet._id,
      };
    }

    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    if (org === null) {
      throw new Error("Organization not found for clerkOrgId");
    }

    const wallet = await getOrCreateWallet(ctx, org._id);
    const nextBalance = wallet.balance + args.amount;

    await ctx.db.insert("walletEntries", {
      walletId: wallet._id,
      kind: "grant",
      amount: args.amount,
      refId: args.grantRefId,
      createdAt: Date.now(),
    });
    await ctx.db.patch(wallet._id, { balance: nextBalance });

    return {
      applied: true,
      balance: nextBalance,
      walletId: wallet._id,
    };
  },
});

export const getMyWallet = mutation({
  args: { orgSlug: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    balance: number;
    walletId: Id<"wallets">;
    entries: Array<{
      _id: Id<"walletEntries">;
      kind: Doc<"walletEntries">["kind"];
      amount: number;
      refId: string;
      createdAt: number;
    }>;
  }> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const wallet = await getOrCreateWallet(ctx, org._id);

    const entries = await ctx.db
      .query("walletEntries")
      .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id))
      .order("desc")
      .take(50);

    return {
      balance: wallet.balance,
      walletId: wallet._id,
      entries: entries.map((e) => ({
        _id: e._id,
        kind: e.kind,
        amount: e.amount,
        refId: e.refId,
        createdAt: e.createdAt,
      })),
    };
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
  /** Settlement ledger ref — stable settle:{reservationId} */
  settleRefId: v.string(),
});

/**
 * Gateway flush: batch usage events + settle ledger rows.
 * Each settleRefId is idempotent; usage events always insert when new settle applies.
 * balance never goes negative from this path — gateway already reserved.
 */
export const recordUsage = internalMutation({
  args: {
    events: v.array(usageEventArg),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    applied: number;
    skipped: number;
    balances: Record<string, number>;
  }> => {
    let applied = 0;
    let skipped = 0;
    const balances: Record<string, number> = {};

    // Group by org so we touch each wallet once per batch where possible.
    for (const event of args.events) {
      if (event.settleRefId.trim() === "") {
        throw new Error("settleRefId is required on each usage event");
      }
      if (!Number.isFinite(event.credits) || event.credits < 0) {
        throw new Error("credits must be a number ≥ 0");
      }

      const existingEntry = await ctx.db
        .query("walletEntries")
        .withIndex("by_ref", (q) => q.eq("refId", event.settleRefId))
        .unique();
      if (existingEntry !== null) {
        skipped += 1;
        const wallet = await ctx.db.get(existingEntry.walletId);
        if (wallet !== null) {
          balances[wallet.organizationId] = wallet.balance;
        }
        continue;
      }

      const wallet = await getOrCreateWallet(ctx, event.organizationId);
      // Free-tier (credits 0): still ledger a settle row for idempotency + audit.
      const nextBalance = wallet.balance - event.credits;
      if (nextBalance < 0) {
        // Do not invent balance. Skip settle but still record usage for forensics.
        await ctx.db.insert("usageEvents", {
          organizationId: event.organizationId,
          projectId: event.projectId,
          endpoint: event.endpoint,
          method: event.method,
          credits: event.credits,
          status: event.status,
          latencyMs: event.latencyMs,
          keyId: event.keyId,
          at: event.at,
        });
        // Soft-fail this row: mark skipped so gateway can alert/reconcile.
        skipped += 1;
        balances[wallet.organizationId] = wallet.balance;
        continue;
      }

      await ctx.db.insert("walletEntries", {
        walletId: wallet._id,
        kind: "settle",
        amount: event.credits,
        refId: event.settleRefId,
        createdAt: Date.now(),
      });
      await ctx.db.patch(wallet._id, { balance: nextBalance });

      await ctx.db.insert("usageEvents", {
        organizationId: event.organizationId,
        projectId: event.projectId,
        endpoint: event.endpoint,
        method: event.method,
        credits: event.credits,
        status: event.status,
        latencyMs: event.latencyMs,
        keyId: event.keyId,
        at: event.at,
      });

      applied += 1;
      balances[wallet.organizationId] = nextBalance;
    }

    return { applied, skipped, balances };
  },
});
