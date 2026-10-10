import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { appendWalletEntry, getOrCreateWallet } from "./wallets";
import { recordPositiveFundingSource } from "./lib/funding";
import {
  fundingExpiresAt,
  machineWalletId,
  MACHINE_TOPUP_CREDITS,
  type MachineGrant,
} from "@zevium/shared";

/** Gateway-only, after facilitator settlement AND Stripe succeeded verification. */
export const fund = internalMutation({
  args: {
    paymentId: v.string(),
    transaction: v.string(),
    network: v.string(),
    payer: v.string(),
  },
  handler: async (ctx, args): Promise<MachineGrant> => {
    if (
      !/^pi_[A-Za-z0-9]+$/.test(args.paymentId) ||
      !/^0x[0-9a-f]{64}$/.test(args.transaction) ||
      !/^eip155:[0-9]+$/.test(args.network) ||
      !/^0x[0-9a-f]{40}$/.test(args.payer)
    )
      throw new Error("Invalid verified payment");
    const walletId = machineWalletId(args.network, args.payer);
    const sourceRef = `x402:${args.paymentId}`;
    const prior = await ctx.db
      .query("machinePayments")
      .withIndex("by_payment", (q) => q.eq("paymentId", args.paymentId))
      .unique();
    if (prior) {
      if (prior.walletId !== walletId || prior.transaction !== args.transaction)
        throw new Error("Payment replay changed identity");
      return {
        walletId,
        sourceRef,
        credits: MACHINE_TOPUP_CREDITS,
        createdAt: prior.createdAt,
        expiresAt: prior.expiresAt,
        applied: false,
      };
    }
    const replay = await ctx.db
      .query("machinePayments")
      .withIndex("by_transaction", (q) =>
        q.eq("network", args.network).eq("transaction", args.transaction),
      )
      .unique();
    if (replay) throw new Error("Transaction already funded");
    let org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", walletId))
      .unique();
    if (!org) {
      const id = await ctx.db.insert("organizations", {
        clerkOrgId: walletId,
        walletKind: "anonymous",
        slug: walletId,
        name: "Anonymous wallet",
      });
      org = await ctx.db.get(id);
    }
    if (!org || org.walletKind !== "anonymous")
      throw new Error("Invalid wallet owner");
    const createdAt = Date.now();
    const expiresAt = fundingExpiresAt(createdAt);
    const wallet = await getOrCreateWallet(ctx, org._id);
    const grant = await appendWalletEntry(ctx, {
      wallet,
      kind: "payment_grant",
      amount: MACHINE_TOPUP_CREDITS,
      refId: sourceRef,
    });
    await recordPositiveFundingSource(ctx, {
      wallet: grant.wallet,
      sourceKind: "machine_payment",
      sourceRef,
      amount: MACHINE_TOPUP_CREDITS,
      refundable: false,
      createdAt,
      expiresAt,
    });
    await ctx.db.insert("machinePayments", {
      ...args,
      walletId,
      createdAt,
      expiresAt,
    });
    return {
      walletId,
      sourceRef,
      credits: MACHINE_TOPUP_CREDITS,
      createdAt,
      expiresAt,
      applied: true,
    };
  },
});
