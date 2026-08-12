/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { publisherEarningSplit } from "./accounting";
import { connectAccountProjection, createOnboardingLink } from "./payouts";
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
    const earningId = await ctx.db.insert("publisherEarnings", {
      publisherOrganizationId: organizationId,
      usageSettlementRefId: "settle:publisher-one",
      grossCredits: 100_000,
      platformFeeCredits: 5_000,
      netCredits: 95_000,
      availableAt: 1,
      status: "available",
      createdAt: 1,
      updatedAt: 1,
    });
    return { organizationId, earningId };
  });
}

describe("Stripe Connect publisher accounting", () => {
  it("rejects onboarding and transfers from an ordinary organization member", async () => {
    const t = convexTest(schema, modules);
    const member = t.withIdentity({
      subject: "user_member",
      org_id: "org_publisher",
      org_slug: "publisher",
      org_role: "org:member",
      email: "member@example.com",
    } as {
      subject: string;
      org_id: string;
      org_slug: string;
      org_role: string;
      email: string;
    });
    await expect(
      member.action(api.payouts.startOnboarding, {}),
    ).rejects.toThrow(/Org admin role required/);
    await expect(
      member.action(api.payouts.initiatePublisherTransfer, {}),
    ).rejects.toThrow(/Org admin role required/);
  });

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

  it("rounds the platform fee up so every paid call contributes", () => {
    expect([0, 1, 19, 20].map(publisherEarningSplit)).toEqual([
      { grossCredits: 0, platformFeeCredits: 0, publisherNetCredits: 0 },
      { grossCredits: 1, platformFeeCredits: 1, publisherNetCredits: 0 },
      { grossCredits: 19, platformFeeCredits: 1, publisherNetCredits: 18 },
      { grossCredits: 20, platformFeeCredits: 1, publisherNetCredits: 19 },
    ]);
    expect(publisherEarningSplit(100_001)).toEqual({
      grossCredits: 100_001,
      platformFeeCredits: 5_001,
      publisherNetCredits: 95_000,
    });
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
    await expect(
      t.mutation(internal.payouts.preparePublisherTransfer, {
        publisherOrganizationId: seed.organizationId,
      }),
    ).rejects.toThrow("below one cent");
    await t.run(async (ctx) => {
      await ctx.db.patch(seed.earningId, {
        status: "available",
        availableAt: 1,
      });
    });
    const first = await t.mutation(internal.payouts.preparePublisherTransfer, {
      publisherOrganizationId: seed.organizationId,
    });
    const retry = await t.mutation(internal.payouts.preparePublisherTransfer, {
      publisherOrganizationId: seed.organizationId,
    });
    expect(retry.transferId).toBe(first.transferId);
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(first.amount).toBe(950);
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
      await ctx.db.patch(seed.earningId, {
        grossCredits: 100_001,
        netCredits: 95_001,
      });
    });

    const first = await t.mutation(internal.payouts.preparePublisherTransfer, {
      publisherOrganizationId: seed.organizationId,
    });
    expect(first.amount).toBe(950);
    expect(first.remainderCredits).toBe(1);
    await t.mutation(internal.payouts.markPublisherTransferSucceeded, {
      transferId: first.transferId,
      stripeTransferId: "tr_carry_first",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("publisherEarnings", {
        publisherOrganizationId: seed.organizationId,
        usageSettlementRefId: "settle:publisher-carry",
        grossCredits: 99,
        platformFeeCredits: 0,
        netCredits: 99,
        availableAt: 1,
        status: "available",
        createdAt: 2,
        updatedAt: 2,
      });
    });

    const second = await t.mutation(internal.payouts.preparePublisherTransfer, {
      publisherOrganizationId: seed.organizationId,
    });
    expect(second.amount).toBe(1);
    expect(second.remainderCredits).toBe(0);
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
      state: "reversed",
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
    }));
    expect(state.earning?.status).toBe("reversed");
    expect(state.transfer?.status).toBe("reversed");
    expect(state.payouts).toHaveLength(1);
  });
});
