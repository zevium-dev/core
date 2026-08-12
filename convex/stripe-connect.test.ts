/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  ACCOUNTING_ATOMS_PER_CREDIT,
  publisherEarningSplit,
} from "./accounting";
import {
  connectAccountProjection,
  createAndRetrieveStripeTransfer,
  createOnboardingLink,
} from "./payouts";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type ConnectSeed = {
  organizationId: Id<"organizations">;
  earningId: Id<"publisherEarnings">;
};

async function seedConnect(t: TestConvex<typeof schema>): Promise<ConnectSeed> {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_publisher",
      name: "Publisher",
      slug: "publisher",
    });
    await ctx.db.insert("organizationPayments", {
      organizationId,
      detailsSubmitted: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      requirements: [],
      updatedAt: 1,
    });
    const split = publisherEarningSplit(110_000);
    const earningId = await ctx.db.insert("publisherEarnings", {
      publisherOrganizationId: organizationId,
      consumerOrganizationId: organizationId,
      usageSettlementRefId: "settle:publisher-one",
      grossCredits: split.grossCredits,
      platformFeeAtoms: split.platformFeeAtoms,
      publisherNetAtoms: split.publisherNetAtoms,
      platformFeeCredits: split.platformFeeCredits,
      netCredits: split.publisherNetCredits,
      clawedBackGrossCredits: 0,
      clawedBackAtoms: 0,
      releasedAtoms: 0,
      availableAt: 1,
      status: "pending_risk",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("publisherBalances", {
      publisherOrganizationId: organizationId,
      availableAtoms: 0,
      allocatedAtoms: 0,
      paidAtoms: 0,
      pendingRiskAtoms: split.publisherNetAtoms,
      reversedAtoms: 0,
      failedAtoms: 0,
      sequence: 0,
      updatedAt: 1,
    });
    return { organizationId, earningId };
  });
}

describe("Stripe Connect publisher accounting", () => {
  it("projects Accounts v2 recipient capability and requirements", () => {
    const projection = connectAccountProjection({
      id: "acct_recipient",
      object: "v2.core.account",
      configuration: {
        recipient: {
          applied: true,
          capabilities: {
            stripe_balance: {
              payouts: { status: "restricted", status_details: [] },
              stripe_transfers: {
                status: "active",
                status_details: [],
              },
            },
          },
        },
      },
      requirements: {
        entries: [
          {
            awaiting_action_from: "user",
            description: "external_account",
            errors: [],
            impact: { restricts_capabilities: [] },
            minimum_deadline: { status: "past_due" },
            requested_reason: "routine_onboarding",
          },
        ],
        summary: { minimum_deadline: { status: "past_due" } },
      },
    } as Stripe.V2.Core.Account);

    expect(projection).toEqual({
      chargesEnabled: false,
      detailsSubmitted: false,
      disabledReason: "Transfers: active; payouts: restricted",
      payoutsEnabled: false,
      requirements: ["external_account"],
    });
  });

  it("creates an Accounts v2 recipient with platform fee and loss liability", async () => {
    const createCalls: unknown[] = [];
    const result = await createOnboardingLink(
      {
        accountsV2: {
          create: async (params) => {
            createCalls.push(params);
            return { id: "acct_v2_recipient" };
          },
        },
        accountLinks: {
          create: async () => ({ url: "https://connect.stripe.test/onboard" }),
        },
      },
      {
        connectedAccountId: null,
        clerkOrgId: "org_publisher",
        organizationId: "org_doc",
        country: "AE",
        contactEmail: "publisher@example.com",
        refreshUrl: "https://zevium.test/refresh",
        returnUrl: "https://zevium.test/return",
      },
    );

    expect(result.connectedAccountId).toBe("acct_v2_recipient");
    expect(createCalls).toEqual([
      expect.objectContaining({
        dashboard: "express",
        defaults: {
          responsibilities: {
            fees_collector: "application",
            losses_collector: "application",
          },
        },
        configuration: {
          recipient: {
            capabilities: {
              stripe_balance: {
                stripe_transfers: { requested: true },
              },
            },
          },
        },
        identity: { country: "AE" },
        contact_email: "publisher@example.com",
      }),
    ]);
  });

  it("splits every call exactly in atom units without rounding theft", () => {
    expect([0, 1, 19, 20].map(publisherEarningSplit)).toEqual([
      {
        grossCredits: 0,
        platformFeeAtoms: 0,
        publisherNetAtoms: 0,
        platformFeeCredits: 0,
        publisherNetCredits: 0,
      },
      {
        grossCredits: 1,
        platformFeeAtoms: 500,
        publisherNetAtoms: 9_500,
        platformFeeCredits: 0.05,
        publisherNetCredits: 0.95,
      },
      {
        grossCredits: 19,
        platformFeeAtoms: 9_500,
        publisherNetAtoms: 180_500,
        platformFeeCredits: 0.95,
        publisherNetCredits: 18.05,
      },
      {
        grossCredits: 20,
        platformFeeAtoms: 10_000,
        publisherNetAtoms: 190_000,
        platformFeeCredits: 1,
        publisherNetCredits: 19,
      },
    ]);
    expect(publisherEarningSplit(100_001)).toEqual({
      grossCredits: 100_001,
      platformFeeAtoms: 50_000_500,
      publisherNetAtoms: 950_009_500,
      platformFeeCredits: 5_000.05,
      publisherNetCredits: 95_000.95,
    });
    for (let credits = 0; credits < 10_000; credits += 17) {
      const split = publisherEarningSplit(credits);
      expect(split.platformFeeAtoms + split.publisherNetAtoms).toBe(
        credits * ACCOUNTING_ATOMS_PER_CREDIT,
      );
      expect(split.platformFeeAtoms * 19).toBe(split.publisherNetAtoms);
    }
    expect(() => publisherEarningSplit(-1)).toThrow("non-negative");
  });

  it("reuses a connected account and projects account.updated state", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedConnect(t);
    expect(
      await t.mutation(internal.payouts.setConnectedAccount, {
        organizationId: seed.organizationId,
        stripeConnectedAccountId: "acct_reused",
      }),
    ).toBe("acct_reused");
    expect(
      await t.mutation(internal.payouts.setConnectedAccount, {
        organizationId: seed.organizationId,
        stripeConnectedAccountId: "acct_other",
      }),
    ).toBe("acct_reused");
    await t.mutation(internal.payouts.projectConnectedAccount, {
      stripeConnectedAccountId: "acct_reused",
      detailsSubmitted: true,
      chargesEnabled: false,
      payoutsEnabled: true,
      disabledReason: undefined,
      requirements: ["external_account", "external_account"],
    });
    const profile = await t.run(async (ctx) =>
      ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique(),
    );
    expect(profile).toMatchObject({
      stripeConnectedAccountId: "acct_reused",
      detailsSubmitted: true,
      payoutsEnabled: true,
      requirements: ["external_account"],
    });
  });

  it("blocks members from onboarding or transferring before any local side effect", async () => {
    const t = convexTest(schema, modules);
    const organizationId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        clerkOrgId: "org_member_blocked",
        name: "Member blocked",
        slug: "member-blocked",
      }),
    );
    const member = t.withIdentity({
      subject: "member_user",
      org_id: "org_member_blocked",
      org_role: "org:member",
      email: "member@example.com",
    } as {
      subject: string;
      org_id: string;
      org_role: string;
      email: string;
    });
    await expect(
      member.action(api.payouts.startOnboarding, { country: "US" }),
    ).rejects.toThrow("Org admin or owner role required");
    await expect(
      member.action(api.payouts.initiatePublisherTransfer, {}),
    ).rejects.toThrow("Org admin or owner role required");
    const state = await t.run(async (ctx) => ({
      profiles: await ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", organizationId),
        )
        .collect(),
      transfers: await ctx.db
        .query("publisherTransfers")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", organizationId),
        )
        .collect(),
    }));
    expect(state).toEqual({ profiles: [], transfers: [] });
  });

  it("enforces capability gates and creates one idempotent transfer allocation", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedConnect(t);
    await t.mutation(internal.payouts.setConnectedAccount, {
      organizationId: seed.organizationId,
      stripeConnectedAccountId: "acct_transfer",
    });
    await expect(
      t.mutation(internal.payouts.preparePublisherTransfer, {
        publisherOrganizationId: seed.organizationId,
      }),
    ).rejects.toThrow("not eligible");
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique();
      if (profile === null) throw new Error("profile missing");
      await ctx.db.patch(profile._id, { payoutsEnabled: true, updatedAt: 2 });
      await ctx.db.patch(seed.earningId, {
        status: "pending_risk",
        availableAt: Date.now() + 60_000,
      });
    });
    await t.mutation(internal.payouts.releaseMatureEarnings, {
      publisherOrganizationId: seed.organizationId,
    });
    await expect(
      t.mutation(internal.payouts.preparePublisherTransfer, {
        publisherOrganizationId: seed.organizationId,
      }),
    ).rejects.toThrow("$10.00 payout minimum");
    await t.run(async (ctx) => {
      await ctx.db.patch(seed.earningId, {
        status: "pending_risk",
        availableAt: 1,
      });
    });
    await t.mutation(internal.payouts.releaseMatureEarnings, {
      publisherOrganizationId: seed.organizationId,
    });
    const [first, retry] = await Promise.all([
      t.mutation(internal.payouts.preparePublisherTransfer, {
        publisherOrganizationId: seed.organizationId,
      }),
      t.mutation(internal.payouts.preparePublisherTransfer, {
        publisherOrganizationId: seed.organizationId,
      }),
    ]);
    expect(retry.transferId).toBe(first.transferId);
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(first.amount).toBe(1_045);
  });

  it("carries sub-cent earnings into the next transfer", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedConnect(t);
    await t.mutation(internal.payouts.setConnectedAccount, {
      organizationId: seed.organizationId,
      stripeConnectedAccountId: "acct_carry",
    });
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique();
      if (profile === null) throw new Error("profile missing");
      await ctx.db.patch(profile._id, { payoutsEnabled: true });
      const split = publisherEarningSplit(110_001);
      await ctx.db.patch(seed.earningId, {
        grossCredits: split.grossCredits,
        platformFeeAtoms: split.platformFeeAtoms,
        publisherNetAtoms: split.publisherNetAtoms,
        platformFeeCredits: split.platformFeeCredits,
        netCredits: split.publisherNetCredits,
      });
      const balance = await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seed.organizationId),
        )
        .unique();
      if (balance === null) throw new Error("balance missing");
      await ctx.db.patch(balance._id, {
        pendingRiskAtoms: split.publisherNetAtoms,
      });
    });
    await t.mutation(internal.payouts.releaseMatureEarnings, {
      publisherOrganizationId: seed.organizationId,
    });

    const first = await t.mutation(internal.payouts.preparePublisherTransfer, {
      publisherOrganizationId: seed.organizationId,
    });
    expect(first.amount).toBe(1_045);
    expect(first.remainderAtoms).toBe(9_500);
    await t.mutation(internal.payouts.markPublisherTransferSucceeded, {
      transferId: first.transferId,
      stripeTransferId: "tr_carry_first",
    });
    await expect(
      t.mutation(internal.payouts.preparePublisherTransfer, {
        publisherOrganizationId: seed.organizationId,
      }),
    ).rejects.toThrow("$10.00 payout minimum");
    await t.run(async (ctx) => {
      const split = publisherEarningSplit(105_263);
      await ctx.db.insert("publisherEarnings", {
        publisherOrganizationId: seed.organizationId,
        consumerOrganizationId: seed.organizationId,
        usageSettlementRefId: "settle:publisher-carry",
        grossCredits: split.grossCredits,
        platformFeeAtoms: split.platformFeeAtoms,
        publisherNetAtoms: split.publisherNetAtoms,
        platformFeeCredits: split.platformFeeCredits,
        netCredits: split.publisherNetCredits,
        clawedBackGrossCredits: 0,
        clawedBackAtoms: 0,
        releasedAtoms: 0,
        availableAt: 1,
        status: "pending_risk",
        createdAt: 2,
        updatedAt: 2,
      });
      const balance = await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seed.organizationId),
        )
        .unique();
      if (balance === null) throw new Error("balance missing");
      await ctx.db.patch(balance._id, {
        pendingRiskAtoms: balance.pendingRiskAtoms + split.publisherNetAtoms,
      });
    });
    await t.mutation(internal.payouts.releaseMatureEarnings, {
      publisherOrganizationId: seed.organizationId,
    });

    const second = await t.mutation(internal.payouts.preparePublisherTransfer, {
      publisherOrganizationId: seed.organizationId,
    });
    expect(second.amount).toBe(1_000);
    expect(second.remainderAtoms).toBe(8_000);
  });

  it("projects failed/reversed transfers and payout state without changing earnings twice", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedConnect(t);
    await t.mutation(internal.payouts.setConnectedAccount, {
      organizationId: seed.organizationId,
      stripeConnectedAccountId: "acct_projection",
    });
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique();
      if (profile === null) throw new Error("profile missing");
      await ctx.db.patch(profile._id, { payoutsEnabled: true });
    });
    await t.mutation(internal.payouts.releaseMatureEarnings, {
      publisherOrganizationId: seed.organizationId,
    });
    const transfer = await t.mutation(
      internal.payouts.preparePublisherTransfer,
      {
        publisherOrganizationId: seed.organizationId,
      },
    );
    await t.mutation(internal.payouts.markPublisherTransferSucceeded, {
      transferId: transfer.transferId,
      stripeTransferId: "tr_projection",
    });
    await t.mutation(internal.payouts.projectStripeTransfer, {
      stripeTransferId: "tr_projection",
      amount: transfer.amount,
      amountReversed: 0,
      failed: true,
      failureReason: "stale failure",
    });
    await t.mutation(internal.payouts.projectStripeTransfer, {
      stripeTransferId: "tr_projection",
      amount: transfer.amount,
      amountReversed: transfer.amount,
      failed: false,
      failureReason: undefined,
    });
    await t.mutation(internal.payouts.projectConnectedPayout, {
      stripeConnectedAccountId: "acct_projection",
      stripePayoutId: "po_projection",
      amount: 950,
      currency: "usd",
      status: "paid",
      failureCode: undefined,
      arrivalDate: 1000,
    });
    await t.mutation(internal.payouts.projectConnectedPayout, {
      stripeConnectedAccountId: "acct_projection",
      stripePayoutId: "po_projection",
      amount: 950,
      currency: "usd",
      status: "paid",
      failureCode: undefined,
      arrivalDate: 1000,
    });
    const state = await t.run(async (ctx) => ({
      earning: await ctx.db.get(seed.earningId),
      transfer: await ctx.db.get(transfer.transferId),
      payouts: await ctx.db.query("connectedPayouts").collect(),
      balance: await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seed.organizationId),
        )
        .unique(),
      ledger: await ctx.db.query("publisherSettlementEntries").collect(),
    }));
    expect(state.earning?.status).toBe("available");
    expect(state.transfer?.status).toBe("reversed");
    expect(state.balance).toMatchObject({
      availableAtoms: 1_045_000_000,
      allocatedAtoms: 0,
      paidAtoms: 0,
    });
    expect(state.ledger.map((entry) => entry.kind)).toEqual([
      "earning_release",
      "transfer_allocation",
      "transfer_succeeded",
      "transfer_reversal",
    ]);
    expect(state.payouts).toHaveLength(1);
  });

  it("correlates reversal metadata across local-write crash and keeps retry projection reversed", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedConnect(t);
    await t.mutation(internal.payouts.setConnectedAccount, {
      organizationId: seed.organizationId,
      stripeConnectedAccountId: "acct_crash",
    });
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique();
      if (profile === null) throw new Error("profile missing");
      await ctx.db.patch(profile._id, { payoutsEnabled: true });
    });
    await t.mutation(internal.payouts.releaseMatureEarnings, {
      publisherOrganizationId: seed.organizationId,
    });
    const local = await t.mutation(internal.payouts.preparePublisherTransfer, {
      publisherOrganizationId: seed.organizationId,
    });
    const calls: string[] = [];
    const snapshot = await createAndRetrieveStripeTransfer(
      {
        create: (async () => {
          calls.push("create");
          return {
            id: "tr_crash",
            amount: local.amount,
            amount_reversed: 0,
            metadata: { publisherTransferId: local.transferId },
          } as Stripe.Transfer;
        }) as Stripe["transfers"]["create"],
        retrieve: (async () => {
          calls.push("retrieve");
          return {
            id: "tr_crash",
            amount: local.amount,
            amount_reversed: local.amount,
            reversed: true,
            metadata: { publisherTransferId: local.transferId },
          } as Stripe.Transfer;
        }) as Stripe["transfers"]["retrieve"],
      },
      {
        _id: local.transferId,
        stripeConnectedAccountId: local.connectedAccountId,
        amount: local.amount,
        currency: local.currency,
        idempotencyKey: local.idempotencyKey,
      },
    );
    expect(calls).toEqual(["create", "retrieve"]);
    expect(snapshot.amount_reversed).toBe(local.amount);

    const projection = {
      stripeTransferId: snapshot.id,
      publisherTransferId: snapshot.metadata.publisherTransferId,
      amount: snapshot.amount,
      amountReversed: snapshot.amount_reversed,
      failed: false,
      failureReason: undefined,
    } as const;
    await t.mutation(internal.payouts.projectStripeTransfer, projection);
    await t.mutation(internal.payouts.projectStripeTransfer, projection);
    const state = await t.run(async (ctx) => ({
      transfer: await ctx.db.get(local.transferId),
      balance: await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seed.organizationId),
        )
        .unique(),
      ledger: await ctx.db.query("publisherSettlementEntries").collect(),
    }));
    expect(state.transfer).toMatchObject({
      stripeTransferId: "tr_crash",
      reversedAmount: local.amount,
      status: "reversed",
    });
    expect(state.balance).toMatchObject({
      availableAtoms: 1_045_000_000,
      allocatedAtoms: 0,
      paidAtoms: 0,
    });
    expect(state.ledger.map((entry) => entry.kind)).toEqual([
      "earning_release",
      "transfer_allocation",
      "transfer_succeeded",
      "transfer_reversal",
    ]);
  });

  it("uses materialized all-row payout totals while paginating display rows", async () => {
    const t = convexTest(schema, modules);
    const count = 120;
    await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_totals",
        name: "Totals",
        slug: "totals",
      });
      await ctx.db.insert("publisherBalances", {
        publisherOrganizationId: organizationId,
        availableAtoms: 0,
        allocatedAtoms: 0,
        paidAtoms: 0,
        pendingRiskAtoms: count * 9_500,
        reversedAtoms: count * 9_500,
        failedAtoms: count * 10_000,
        sequence: 0,
        updatedAt: 1,
      });
      for (let index = 0; index < count; index += 1) {
        await ctx.db.insert("publisherEarnings", {
          publisherOrganizationId: organizationId,
          consumerOrganizationId: organizationId,
          usageSettlementRefId: `settle:totals:${index}`,
          grossCredits: 1,
          platformFeeAtoms: 500,
          publisherNetAtoms: 9_500,
          platformFeeCredits: 0.05,
          netCredits: 0.95,
          clawedBackGrossCredits: 0,
          clawedBackAtoms: 0,
          releasedAtoms: 0,
          availableAt: 2,
          status: "pending_risk",
          createdAt: index + 1,
          updatedAt: index + 1,
        });
        await ctx.db.insert("publisherTransfers", {
          publisherOrganizationId: organizationId,
          stripeConnectedAccountId: "acct_totals",
          amount: 1,
          amountAtoms: 10_000,
          remainderAtoms: 0,
          currency: "usd",
          idempotencyKey: `totals:${index}`,
          reversedAmount: 0,
          status: "failed",
          createdAt: index + 1,
          updatedAt: index + 1,
        });
      }
    });
    const state = await t
      .withIdentity({
        subject: "totals_user",
        org_id: "org_totals",
        org_role: "org:member",
      } as { subject: string; org_id: string; org_role: string })
      .query(api.payouts.getPayoutState, {});
    expect(state.earnings.rows).toHaveLength(100);
    expect(state.transfers).toHaveLength(100);
    expect(state.earnings.pendingRisk).toBe(114);
    expect(state.earnings.reversed).toBe(114);
    expect(state.earnings.failed).toBe(120);
  });
});
