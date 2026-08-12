/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import {
  CREDIT_PACKS,
  createHostedCheckout,
  cumulativeRefundCredits,
} from "./billing";
import { atomsToUsdCents, publisherEarningSplit } from "./accounting";
import type { Id } from "./_generated/dataModel";
import { verifyStripeWebhook } from "./http";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type FinancialSeed = {
  consumerOrganizationId: Id<"organizations">;
  publisherOrganizationId: Id<"organizations">;
  paymentId: Id<"payments">;
  earningId: Id<"publisherEarnings">;
};

async function seedFinancialPayment(
  t: TestConvex<typeof schema>,
  suffix: string,
  walletBalance: number,
): Promise<FinancialSeed> {
  return await t.run(async (ctx) => {
    const consumerOrganizationId = await ctx.db.insert("organizations", {
      clerkOrgId: `org_consumer_${suffix}`,
      name: "Consumer",
      slug: `consumer-${suffix}`,
    });
    const publisherOrganizationId = await ctx.db.insert("organizations", {
      clerkOrgId: `org_publisher_${suffix}`,
      name: "Publisher",
      slug: `publisher-${suffix}`,
    });
    await ctx.db.insert("wallets", {
      organizationId: consumerOrganizationId,
      balance: walletBalance,
      sequence: 0,
    });
    const intentId = await ctx.db.insert("checkoutIntents", {
      organizationId: consumerOrganizationId,
      packId: "pack_10",
      stripePriceId: `price_${suffix}`,
      amount: 1_000,
      currency: "usd",
      credits: 100,
      stripeCheckoutSessionId: `cs_${suffix}`,
      stripePaymentIntentId: `pi_${suffix}`,
      status: "complete",
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    });
    const paymentId = await ctx.db.insert("payments", {
      organizationId: consumerOrganizationId,
      checkoutIntentId: intentId,
      stripeCheckoutSessionId: `cs_${suffix}`,
      stripePaymentIntentId: `pi_${suffix}`,
      stripeChargeId: `ch_${suffix}`,
      amount: 1_000,
      currency: "usd",
      grantedCredits: 100,
      refundedAmount: 0,
      refundedCredits: 0,
      reversedCredits: 0,
      publisherClawbackTargetCredits: 0,
      status: "paid",
      createdAt: 1,
      updatedAt: 1,
    });
    const split = publisherEarningSplit(100);
    const earningId = await ctx.db.insert("publisherEarnings", {
      publisherOrganizationId,
      consumerOrganizationId,
      usageSettlementRefId: `settle:${suffix}`,
      grossCredits: split.grossCredits,
      platformFeeAtoms: split.platformFeeAtoms,
      publisherNetAtoms: split.publisherNetAtoms,
      platformFeeCredits: split.platformFeeCredits,
      netCredits: split.publisherNetCredits,
      clawedBackGrossCredits: 0,
      clawedBackAtoms: 0,
      releasedAtoms: split.publisherNetAtoms,
      availableAt: 1,
      status: "available",
      createdAt: 1,
      updatedAt: 1,
    });
    const balanceId = await ctx.db.insert("publisherBalances", {
      publisherOrganizationId,
      availableAtoms: split.publisherNetAtoms,
      allocatedAtoms: 0,
      paidAtoms: 0,
      sequence: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("publisherSettlementEntries", {
      publisherBalanceId: balanceId,
      publisherOrganizationId,
      kind: "earning_release",
      availableDeltaAtoms: split.publisherNetAtoms,
      allocatedDeltaAtoms: 0,
      paidDeltaAtoms: 0,
      refId: `publisher:earning:${earningId}:release`,
      sequence: 1,
      earningId,
      createdAt: 1,
    });
    return {
      consumerOrganizationId,
      publisherOrganizationId,
      paymentId,
      earningId,
    };
  });
}

describe("Stripe Checkout control plane", () => {
  it("rejects checkout from an ordinary organization member before Stripe work", async () => {
    const t = convexTest(schema, modules);
    const member = t.withIdentity({
      subject: "user_member",
      org_id: "org_purchaser",
      org_slug: "purchaser",
      org_role: "org:member",
    } as {
      subject: string;
      org_id: string;
      org_slug: string;
      org_role: string;
    });
    await expect(
      member.action(api.billing.createCheckout, { packId: "pack_10" }),
    ).rejects.toThrow(/Org admin or owner role required/);
  });

  it("uses immutable server-owned credit packs and only a server-owned Price", async () => {
    expect(
      CREDIT_PACKS.map((pack) => [pack.packId, pack.priceCents, pack.credits]),
    ).toEqual([
      ["pack_10", 1000, 100_000],
      ["pack_50", 5000, 500_000],
      ["pack_100", 10_000, 1_000_000],
    ]);
    for (const pack of CREDIT_PACKS) {
      const publisherPayoutCents = atomsToUsdCents(
        publisherEarningSplit(pack.credits).publisherNetAtoms,
      );
      expect(publisherPayoutCents).toBeLessThan(pack.priceCents);
    }
    let request: unknown = null;
    const session = await createHostedCheckout(
      {
        checkout: {
          sessions: {
            create: async (params) => {
              request = params;
              return {
                id: "cs_test",
                url: "https://checkout.stripe.test/cs_test",
              };
            },
          },
        },
      },
      {
        stripeCustomerId: "cus_test",
        stripePriceId: "price_server_owned",
        checkoutIntentId: "intent_test",
        clerkOrgId: "org_test",
        packId: "pack_10",
        successUrl:
          "https://app.test/app/billing?checkout={CHECKOUT_SESSION_ID}",
        cancelUrl: "https://app.test/app/billing",
      },
    );
    expect(session).toEqual({
      id: "cs_test",
      url: "https://checkout.stripe.test/cs_test",
    });
    expect(request).toMatchObject({
      mode: "payment",
      customer: "cus_test",
      line_items: [{ price: "price_server_owned", quantity: 1 }],
      metadata: {
        checkoutIntentId: "intent_test",
        clerkOrgId: "org_test",
        packId: "pack_10",
      },
    });
    expect(request).not.toHaveProperty("amount_total");
  });

  it("records duplicate Stripe event delivery once while retaining distinct receipts", async () => {
    const t = convexTest(schema, modules);
    expect(
      await t.mutation(internal.billing.receiveStripeEvent, {
        stripeEventId: "evt_one",
        stripeAccount: "platform",
        eventType: "checkout.session.completed",
        objectId: "cs_one",
      }),
    ).toEqual({ isNew: true, scheduled: true });
    expect(
      await t.mutation(internal.billing.receiveStripeEvent, {
        stripeEventId: "evt_one",
        stripeAccount: "platform",
        eventType: "checkout.session.completed",
        objectId: "cs_one",
      }),
    ).toEqual({ isNew: false, scheduled: false });
    await expect(
      t.mutation(internal.billing.receiveStripeEvent, {
        stripeEventId: "evt_one",
        stripeAccount: "platform",
        eventType: "checkout.session.completed",
        objectId: "cs_tampered",
      }),
    ).rejects.toThrow("redelivered with different data");
    expect(
      await t.mutation(internal.billing.receiveStripeEvent, {
        stripeEventId: "evt_two",
        stripeAccount: "platform",
        eventType: "payment_intent.succeeded",
        objectId: "pi_one",
      }),
    ).toEqual({ isNew: true, scheduled: true });
    const receipts = await t.run(async (ctx) =>
      ctx.db.query("paymentEvents").collect(),
    );
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({ attempts: 0, deliveries: 2 });
    expect(
      await t.mutation(internal.billing.claimStripeEvent, {
        stripeEventId: "evt_one",
      }),
    ).toMatchObject({ eventType: "checkout.session.completed" });
    expect(
      await t.mutation(internal.billing.claimStripeEvent, {
        stripeEventId: "evt_one",
      }),
    ).toBeNull();
    await t.mutation(internal.billing.failStripeEvent, {
      stripeEventId: "evt_one",
      error: "temporary Stripe outage",
    });
    expect(
      await t.mutation(internal.billing.receiveStripeEvent, {
        stripeEventId: "evt_one",
        stripeAccount: "platform",
        eventType: "checkout.session.completed",
        objectId: "cs_one",
      }),
    ).toEqual({ isNew: false, scheduled: true });
    expect(
      await t.mutation(internal.billing.claimStripeEvent, {
        stripeEventId: "evt_one",
      }),
    ).toMatchObject({ objectId: "cs_one" });
    await t.mutation(internal.billing.finishStripeEvent, {
      stripeEventId: "evt_one",
      status: "processed",
    });
    expect(
      await t.mutation(internal.billing.receiveStripeEvent, {
        stripeEventId: "evt_one",
        stripeAccount: "platform",
        eventType: "checkout.session.completed",
        objectId: "cs_one",
      }),
    ).toEqual({ isNew: false, scheduled: false });
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("paymentEvents")
          .withIndex("by_stripe_event", (q) => q.eq("stripeEventId", "evt_one"))
          .unique(),
      ),
    ).toMatchObject({ status: "processed", attempts: 2, deliveries: 4 });
  });

  it("fulfills synchronous and async paid paths once and never exposes another org checkout", async () => {
    const t = convexTest(schema, modules);
    const seed = await t.run(async (ctx) => {
      const purchaser = await ctx.db.insert("organizations", {
        clerkOrgId: "org_purchaser",
        name: "Purchaser",
        slug: "purchaser",
      });
      const outsider = await ctx.db.insert("organizations", {
        clerkOrgId: "org_outsider",
        name: "Outsider",
        slug: "outsider",
      });
      await ctx.db.insert("wallets", {
        organizationId: purchaser,
        balance: 0,
        sequence: 0,
      });
      await ctx.db.insert("organizationPayments", {
        organizationId: purchaser,
        stripeCustomerId: "cus_purchaser",
        detailsSubmitted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        requirements: [],
        updatedAt: 1,
      });
      const intentId = await ctx.db.insert("checkoutIntents", {
        organizationId: purchaser,
        packId: "pack_10",
        stripePriceId: "price_immutable",
        amount: 1000,
        currency: "usd",
        credits: 100_000,
        stripeCheckoutSessionId: "cs_paid",
        status: "open",
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      });
      return { purchaser, outsider, intentId };
    });
    const sync = await t.mutation(internal.billing.upsertPaidPayment, {
      stripeCheckoutSessionId: "cs_paid",
      stripePaymentIntentId: "pi_paid",
      stripeChargeId: "ch_paid",
    });
    const async = await t.mutation(internal.billing.upsertPaidPayment, {
      stripeCheckoutSessionId: "cs_paid",
      stripePaymentIntentId: "pi_paid",
      stripeChargeId: "ch_paid",
    });
    expect(async.paymentId).toBe(sync.paymentId);
    expect(
      await t.mutation(internal.wallets.grantPaymentCredits, {
        organizationId: seed.purchaser,
        paymentId: sync.paymentId,
        amount: sync.credits,
        refId: "stripe:payment_intent:pi_paid",
      }),
    ).toMatchObject({ applied: true, balance: 100_000, sequence: 1 });
    expect(
      await t.mutation(internal.wallets.grantPaymentCredits, {
        organizationId: seed.purchaser,
        paymentId: async.paymentId,
        amount: async.credits,
        refId: "stripe:payment_intent:pi_paid",
      }),
    ).toMatchObject({ applied: false, balance: 100_000, sequence: 1 });
    const outsiderState = await t
      .withIdentity({
        subject: "outside",
        org_id: "org_outsider",
        org_role: "org:admin",
      } as {
        subject: string;
        org_id: string;
        org_role: string;
      })
      .query(api.billing.getBillingState, { checkoutSessionId: "cs_paid" });
    expect(outsiderState.checkout).toBeNull();
    expect(seed.intentId).not.toBe(async.paymentId);
    expect(seed.outsider).not.toBe(seed.purchaser);
  });

  it("shows members wallet balance but hides packs, checkout, and payment history", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_member_billing",
        name: "Member Billing",
        slug: "member-billing",
      });
      await ctx.db.insert("wallets", {
        organizationId,
        balance: 42_000,
        sequence: 1,
      });
      const checkoutIntentId = await ctx.db.insert("checkoutIntents", {
        organizationId,
        packId: "pack_10",
        stripePriceId: "price_private",
        amount: 1_000,
        currency: "usd",
        credits: 100_000,
        stripeCheckoutSessionId: "cs_private",
        status: "complete",
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      });
      await ctx.db.insert("payments", {
        organizationId,
        checkoutIntentId,
        stripeCheckoutSessionId: "cs_private",
        stripePaymentIntentId: "pi_private",
        amount: 1_000,
        currency: "usd",
        grantedCredits: 100_000,
        reversedCredits: 0,
        refundedAmount: 0,
        refundedCredits: 0,
        publisherClawbackTargetCredits: 0,
        status: "paid",
        createdAt: 1,
        updatedAt: 1,
      });
    });

    const state = await t
      .withIdentity({
        subject: "user_member",
        org_id: "org_member_billing",
        org_role: "org:member",
      } as {
        subject: string;
        org_id: string;
        org_role: string;
      })
      .query(api.billing.getBillingState, {
        checkoutSessionId: "cs_private",
      });
    expect(state.wallet.balance).toBe(42_000);
    expect(state.access.capabilities.manageBilling).toBe(false);
    expect(state.packs).toEqual([]);
    expect(state.checkout).toBeNull();
    expect(state.payments).toEqual([]);
  });

  it("rejects bad Stripe signatures before a receipt can be made", async () => {
    await expect(
      verifyStripeWebhook("{}", null, "whsec_test", {
        webhooks: {
          constructEventAsync: async () => {
            throw new Error("must not run");
          },
        },
      }),
    ).rejects.toThrow("Stripe signature is missing");
    await expect(
      verifyStripeWebhook("{}", "bad", "whsec_test", {
        webhooks: {
          constructEventAsync: async () => {
            throw new Error("bad signature");
          },
        },
      }),
    ).rejects.toThrow("bad signature");
  });

  it("caps partial and full refund reversals to the original immutable grant", () => {
    expect(
      cumulativeRefundCredits({
        grantedCredits: 525_000,
        reversedCredits: 0,
        paidAmount: 5000,
        totalRefundedAmount: 2500,
      }),
    ).toEqual({ targetReversedCredits: 262_500, creditsToReverse: 262_500 });
    expect(
      cumulativeRefundCredits({
        grantedCredits: 525_000,
        reversedCredits: 262_500,
        paidAmount: 5000,
        totalRefundedAmount: 50_000,
      }),
    ).toEqual({ targetReversedCredits: 525_000, creditsToReverse: 262_500 });
  });

  it("moves no money for an inquiry and atomically claws back/restores real dispute funds", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedFinancialPayment(t, "dispute", 20);
    const common = {
      stripeDisputeId: "dp_money_safe",
      stripeChargeId: "ch_dispute",
      amount: 1_000,
      currency: "usd",
    } as const;

    await t.mutation(internal.billing.applyDisputeProjection, {
      ...common,
      stripeEventId: "evt_inquiry_created",
      status: "warning_needs_response",
      movement: "none",
    });
    let snapshot = await t.run(async (ctx) => ({
      wallet: await ctx.db
        .query("wallets")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.consumerOrganizationId),
        )
        .unique(),
      payment: await ctx.db.get(seed.paymentId),
      publisher: await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seed.publisherOrganizationId),
        )
        .unique(),
    }));
    expect(snapshot.wallet).toMatchObject({ balance: 20, sequence: 0 });
    expect(snapshot.payment).toMatchObject({ reversedCredits: 0 });
    expect(snapshot.publisher?.availableAtoms).toBe(950_000);

    await t.mutation(internal.billing.applyDisputeProjection, {
      ...common,
      stripeEventId: "evt_funds_out",
      status: "needs_response",
      movement: "funds_withdrawn",
    });
    // Same business event replay cannot move either ledger twice.
    await t.mutation(internal.billing.applyDisputeProjection, {
      ...common,
      stripeEventId: "evt_funds_out",
      status: "needs_response",
      movement: "funds_withdrawn",
    });
    snapshot = await t.run(async (ctx) => ({
      wallet: await ctx.db
        .query("wallets")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.consumerOrganizationId),
        )
        .unique(),
      payment: await ctx.db.get(seed.paymentId),
      publisher: await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seed.publisherOrganizationId),
        )
        .unique(),
      walletEntries: await ctx.db.query("walletEntries").collect(),
    }));
    expect(snapshot.wallet).toMatchObject({ balance: -80, sequence: 1 });
    expect(snapshot.payment).toMatchObject({
      status: "disputed",
      reversedCredits: 100,
    });
    expect(snapshot.publisher?.availableAtoms).toBe(0);
    expect(snapshot.walletEntries).toHaveLength(1);

    await t.mutation(internal.billing.applyDisputeProjection, {
      ...common,
      stripeEventId: "evt_funds_back",
      status: "won",
      movement: "funds_reinstated",
    });
    // Out-of-order non-terminal snapshot cannot reopen terminal dispute.
    await t.mutation(internal.billing.applyDisputeProjection, {
      ...common,
      stripeEventId: "evt_stale_created",
      status: "needs_response",
      movement: "none",
    });
    const restored = await t.run(async (ctx) => ({
      wallet: await ctx.db
        .query("wallets")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.consumerOrganizationId),
        )
        .unique(),
      payment: await ctx.db.get(seed.paymentId),
      dispute: await ctx.db
        .query("paymentDisputes")
        .withIndex("by_stripe_dispute", (q) =>
          q.eq("stripeDisputeId", "dp_money_safe"),
        )
        .unique(),
      publisher: await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seed.publisherOrganizationId),
        )
        .unique(),
      walletEntries: await ctx.db.query("walletEntries").collect(),
      publisherEntries: await ctx.db
        .query("publisherSettlementEntries")
        .collect(),
    }));
    expect(restored.wallet).toMatchObject({ balance: 20, sequence: 2 });
    expect(restored.payment).toMatchObject({
      status: "dispute_won",
      reversedCredits: 0,
    });
    expect(restored.dispute).toMatchObject({
      status: "won",
      fundsWithdrawn: true,
      fundsReinstated: true,
    });
    expect(restored.publisher?.availableAtoms).toBe(950_000);
    expect(restored.walletEntries.map((entry) => entry.kind)).toEqual([
      "dispute_reversal",
      "dispute_restoration",
    ]);
    expect(restored.publisherEntries.map((entry) => entry.kind)).toEqual([
      "earning_release",
      "dispute_clawback",
      "dispute_restoration",
    ]);
  });

  it("caps overlapping refund and multiple disputes, then restores only aggregate exposure", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedFinancialPayment(t, "overlap", 100);
    await t.mutation(internal.billing.applyRefundProjection, {
      stripeRefundId: "re_partial",
      stripeChargeId: "ch_overlap",
      totalRefundedAmount: 200,
    });
    const dispute = async (
      event: string,
      id: string,
      status: "needs_response" | "won" | "lost",
      movement: "funds_withdrawn" | "funds_reinstated" | "none",
    ) =>
      await t.mutation(internal.billing.applyDisputeProjection, {
        stripeEventId: event,
        stripeDisputeId: id,
        stripeChargeId: "ch_overlap",
        amount: 600,
        currency: "usd",
        status,
        movement,
      });
    await dispute("evt_d1_out", "dp_one", "needs_response", "funds_withdrawn");
    await dispute("evt_d2_out", "dp_two", "needs_response", "funds_withdrawn");
    let payment = await t.run(async (ctx) => ctx.db.get(seed.paymentId));
    expect(payment).toMatchObject({
      refundedCredits: 20,
      reversedCredits: 100,
      publisherClawbackTargetCredits: 100,
    });

    await dispute("evt_d1_back", "dp_one", "won", "funds_reinstated");
    await dispute("evt_d2_lost", "dp_two", "lost", "none");
    const result = await t.run(async (ctx) => ({
      payment: await ctx.db.get(seed.paymentId),
      wallet: await ctx.db
        .query("wallets")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.consumerOrganizationId),
        )
        .unique(),
      publisher: await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seed.publisherOrganizationId),
        )
        .unique(),
    }));
    // Refund 20 + remaining dispute 60 = 80. Winning first dispute restores
    // only 20 because second dispute had already consumed grant cap headroom.
    expect(result.payment).toMatchObject({
      status: "dispute_lost",
      refundedCredits: 20,
      reversedCredits: 80,
    });
    expect(result.wallet?.balance).toBe(20);
    expect(result.publisher?.availableAtoms).toBe(190_000);
  });

  it("ignores stale cumulative refunds and claws publisher earnings back atomically", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedFinancialPayment(t, "refund", 100);
    await t.mutation(internal.billing.applyRefundProjection, {
      stripeRefundId: "re_half",
      stripeChargeId: "ch_refund",
      totalRefundedAmount: 500,
    });
    await t.mutation(internal.billing.applyRefundProjection, {
      stripeRefundId: "re_stale",
      stripeChargeId: "ch_refund",
      totalRefundedAmount: 100,
    });
    const result = await t.run(async (ctx) => ({
      payment: await ctx.db.get(seed.paymentId),
      wallet: await ctx.db
        .query("wallets")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.consumerOrganizationId),
        )
        .unique(),
      publisher: await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seed.publisherOrganizationId),
        )
        .unique(),
      clawbacks: await ctx.db.query("publisherClawbacks").collect(),
    }));
    expect(result.payment).toMatchObject({
      status: "partially_refunded",
      refundedAmount: 500,
      refundedCredits: 50,
      reversedCredits: 50,
    });
    expect(result.wallet?.balance).toBe(50);
    expect(result.publisher?.availableAtoms).toBe(475_000);
    expect(result.clawbacks).toHaveLength(1);
  });

  it("turns a clawback after transfer into publisher debt and repays it before payout", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedFinancialPayment(t, "paid_clawback", 100);
    await t.run(async (ctx) => {
      const balance = await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seed.publisherOrganizationId),
        )
        .unique();
      if (balance === null) throw new Error("publisher balance missing");
      await ctx.db.insert("publisherSettlementEntries", {
        publisherBalanceId: balance._id,
        publisherOrganizationId: seed.publisherOrganizationId,
        kind: "transfer_allocation",
        availableDeltaAtoms: -950_000,
        allocatedDeltaAtoms: 950_000,
        paidDeltaAtoms: 0,
        refId: "publisher:test:allocation",
        sequence: 2,
        createdAt: 2,
      });
      await ctx.db.insert("publisherSettlementEntries", {
        publisherBalanceId: balance._id,
        publisherOrganizationId: seed.publisherOrganizationId,
        kind: "transfer_succeeded",
        availableDeltaAtoms: 0,
        allocatedDeltaAtoms: -950_000,
        paidDeltaAtoms: 950_000,
        refId: "publisher:test:succeeded",
        sequence: 3,
        createdAt: 3,
      });
      await ctx.db.patch(balance._id, {
        availableAtoms: 0,
        allocatedAtoms: 0,
        paidAtoms: 950_000,
        sequence: 3,
      });
      await ctx.db.patch(seed.earningId, { status: "transferred" });
    });

    await t.mutation(internal.billing.applyRefundProjection, {
      stripeRefundId: "re_paid_full",
      stripeChargeId: "ch_paid_clawback",
      totalRefundedAmount: 1_000,
    });
    let balance = await t.run(async (ctx) =>
      ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seed.publisherOrganizationId),
        )
        .unique(),
    );
    expect(balance).toMatchObject({
      availableAtoms: -950_000,
      allocatedAtoms: 0,
      paidAtoms: 950_000,
    });

    await t.run(async (ctx) => {
      const split = publisherEarningSplit(100);
      await ctx.db.insert("publisherEarnings", {
        publisherOrganizationId: seed.publisherOrganizationId,
        consumerOrganizationId: seed.consumerOrganizationId,
        usageSettlementRefId: "settle:future-after-debt",
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
        createdAt: 4,
        updatedAt: 4,
      });
    });
    await t.mutation(internal.payouts.releaseMatureEarnings, {
      publisherOrganizationId: seed.publisherOrganizationId,
    });
    const final = await t.run(async (ctx) => {
      const publisherBalance = await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seed.publisherOrganizationId),
        )
        .unique();
      const entries = await ctx.db
        .query("publisherSettlementEntries")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seed.publisherOrganizationId),
        )
        .collect();
      return { publisherBalance, entries };
    });
    expect(final.publisherBalance?.availableAtoms).toBe(0);
    expect(
      final.entries.reduce((sum, entry) => sum + entry.availableDeltaAtoms, 0),
    ).toBe(final.publisherBalance?.availableAtoms);
    expect(
      final.entries.reduce((sum, entry) => sum + entry.allocatedDeltaAtoms, 0),
    ).toBe(final.publisherBalance?.allocatedAtoms);
    expect(
      final.entries.reduce((sum, entry) => sum + entry.paidDeltaAtoms, 0),
    ).toBe(final.publisherBalance?.paidAtoms);
  });
});
