/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import {
  CREDIT_PACKS,
  createHostedCheckout,
  cumulativeRefundCredits,
} from "./billing";
import { creditsToUsdCents, publisherEarningSplit } from "./accounting";
import { verifyStripeWebhook } from "./http";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("Stripe Checkout control plane", () => {
  it("uses immutable server-owned credit packs and only a server-owned Price", async () => {
    expect(
      CREDIT_PACKS.map((pack) => [pack.packId, pack.priceCents, pack.credits]),
    ).toEqual([
      ["pack_10", 1000, 100_000],
      ["pack_50", 5000, 500_000],
      ["pack_100", 10_000, 1_000_000],
    ]);
    for (const pack of CREDIT_PACKS) {
      const publisherPayoutCents = creditsToUsdCents(
        publisherEarningSplit(pack.credits).publisherNetCredits,
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
    ).toEqual({ isNew: true });
    expect(
      await t.mutation(internal.billing.receiveStripeEvent, {
        stripeEventId: "evt_one",
        stripeAccount: "platform",
        eventType: "checkout.session.completed",
        objectId: "cs_one",
      }),
    ).toEqual({ isNew: false });
    expect(
      await t.mutation(internal.billing.receiveStripeEvent, {
        stripeEventId: "evt_two",
        stripeAccount: "platform",
        eventType: "payment_intent.succeeded",
        objectId: "pi_one",
      }),
    ).toEqual({ isNew: true });
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
      .withIdentity({ subject: "outside", org_id: "org_outsider" } as {
        subject: string;
        org_id: string;
      })
      .query(api.billing.getBillingState, { checkoutSessionId: "cs_paid" });
    expect(outsiderState.checkout).toBeNull();
    expect(seed.intentId).not.toBe(async.paymentId);
    expect(seed.outsider).not.toBe(seed.purchaser);
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

  it("records a dispute reversal as debt when the granted credits were spent", async () => {
    const t = convexTest(schema, modules);
    const seed = await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_dispute",
        name: "Dispute org",
        slug: "dispute-org",
      });
      await ctx.db.insert("wallets", {
        organizationId,
        balance: 20,
        sequence: 1,
      });
      const intentId = await ctx.db.insert("checkoutIntents", {
        organizationId,
        packId: "pack_10",
        stripePriceId: "price_dispute",
        amount: 1000,
        currency: "usd",
        credits: 100,
        stripeCheckoutSessionId: "cs_dispute",
        status: "complete",
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      });
      const paymentId = await ctx.db.insert("payments", {
        organizationId,
        checkoutIntentId: intentId,
        stripeCheckoutSessionId: "cs_dispute",
        stripePaymentIntentId: "pi_dispute",
        stripeChargeId: "ch_dispute",
        amount: 1000,
        currency: "usd",
        grantedCredits: 100,
        reversedCredits: 0,
        status: "paid",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("organizationPayments", {
        organizationId,
        stripeCustomerId: "cus_dispute",
        detailsSubmitted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        requirements: [],
        updatedAt: 1,
      });
      return { organizationId, paymentId };
    });
    const dispute = await t.mutation(internal.billing.applyDispute, {
      stripeDisputeId: "dp_test",
      stripeChargeId: "ch_dispute",
    });
    if (dispute.kind !== "dispute")
      throw new Error("Dispute payment was not found");
    await t.mutation(internal.wallets.reversePaymentCredits, {
      organizationId: dispute.organizationId,
      paymentId: dispute.paymentId,
      amount: dispute.creditsToReverse,
      refId: dispute.refId,
      kind: "dispute_reversal",
    });
    await t.mutation(internal.billing.finalizeDispute, {
      paymentId: dispute.paymentId,
      creditsReversed: dispute.creditsToReverse,
    });
    const result = await t.run(async (ctx) => ({
      wallet: await ctx.db
        .query("wallets")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique(),
      payment: await ctx.db.get(seed.paymentId),
    }));
    expect(result.wallet).toMatchObject({ balance: -80, sequence: 2 });
    expect(result.payment).toMatchObject({
      status: "disputed",
      reversedCredits: 100,
      disputedCredits: 100,
    });
  });

  it("projects won and lost dispute closures and clears the payment lock", async () => {
    const t = convexTest(schema, modules);
    const seed = await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_dispute_won",
        name: "Won dispute org",
        slug: "won-dispute-org",
      });
      await ctx.db.insert("wallets", {
        organizationId,
        balance: -80,
        sequence: 2,
      });
      const intentId = await ctx.db.insert("checkoutIntents", {
        organizationId,
        packId: "pack_10",
        stripePriceId: "price_dispute_won",
        amount: 1000,
        currency: "usd",
        credits: 100,
        stripeCheckoutSessionId: "cs_dispute_won",
        status: "complete",
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      });
      const paymentId = await ctx.db.insert("payments", {
        organizationId,
        checkoutIntentId: intentId,
        stripeCheckoutSessionId: "cs_dispute_won",
        stripePaymentIntentId: "pi_dispute_won",
        stripeChargeId: "ch_dispute_won",
        amount: 1000,
        currency: "usd",
        grantedCredits: 100,
        reversedCredits: 100,
        disputedCredits: 80,
        status: "disputed",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("organizationPayments", {
        organizationId,
        stripeCustomerId: "cus_dispute_won",
        detailsSubmitted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        disabledReason: "Payment dispute under review",
        requirements: [],
        updatedAt: 1,
      });
      return { organizationId, paymentId };
    });

    const closure = await t.query(internal.billing.prepareDisputeClosure, {
      stripeDisputeId: "dp_won",
      stripeChargeId: "ch_dispute_won",
      outcome: "won",
    });
    if (closure.kind !== "dispute_closure") {
      throw new Error("Dispute payment was not found");
    }
    await t.mutation(internal.wallets.grantPaymentCredits, {
      organizationId: closure.organizationId,
      paymentId: closure.paymentId,
      amount: closure.creditsToRestore,
      refId: closure.refId,
    });
    await t.mutation(internal.billing.finalizeDisputeClosure, {
      paymentId: closure.paymentId,
      outcome: closure.outcome,
      creditsRestored: closure.creditsToRestore,
    });

    const result = await t.run(async (ctx) => ({
      wallet: await ctx.db
        .query("wallets")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique(),
      payment: await ctx.db.get(seed.paymentId),
      profile: await ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique(),
    }));
    expect(result.wallet).toMatchObject({ balance: 0, sequence: 3 });
    expect(result.payment).toMatchObject({
      status: "dispute_won",
      reversedCredits: 20,
      disputedCredits: 0,
    });
    expect(result.profile?.disabledReason).toBeUndefined();
    await t.mutation(internal.billing.upsertPaidPayment, {
      stripeCheckoutSessionId: "cs_dispute_won",
      stripePaymentIntentId: "pi_dispute_won",
      stripeChargeId: "ch_dispute_won",
    });
    expect(
      await t.run(async (ctx) => ctx.db.get(seed.paymentId)),
    ).toMatchObject({ status: "dispute_won" });

    const lostPaymentId = await t.run(async (ctx) => {
      const paymentId = await ctx.db.insert("payments", {
        organizationId: seed.organizationId,
        checkoutIntentId: result.payment!.checkoutIntentId,
        stripeCheckoutSessionId: "cs_dispute_lost",
        stripePaymentIntentId: "pi_dispute_lost",
        stripeChargeId: "ch_dispute_lost",
        amount: 1000,
        currency: "usd",
        grantedCredits: 100,
        reversedCredits: 100,
        disputedCredits: 100,
        status: "disputed",
        createdAt: 2,
        updatedAt: 2,
      });
      if (result.profile !== null) {
        await ctx.db.patch(result.profile._id, {
          disabledReason: "Payment dispute under review",
        });
      }
      return paymentId;
    });
    const lost = await t.query(internal.billing.prepareDisputeClosure, {
      stripeDisputeId: "dp_lost",
      stripeChargeId: "ch_dispute_lost",
      outcome: "lost",
    });
    if (lost.kind !== "dispute_closure") {
      throw new Error("Lost dispute payment was not found");
    }
    expect(lost.creditsToRestore).toBe(0);
    await t.mutation(internal.billing.finalizeDisputeClosure, {
      paymentId: lost.paymentId,
      outcome: lost.outcome,
      creditsRestored: lost.creditsToRestore,
    });
    const lostResult = await t.run(async (ctx) => ({
      payment: await ctx.db.get(lostPaymentId),
      wallet: await ctx.db
        .query("wallets")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique(),
      profile: await ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique(),
    }));
    expect(lostResult.payment).toMatchObject({
      status: "dispute_lost",
      reversedCredits: 100,
      disputedCredits: 100,
    });
    expect(lostResult.wallet).toMatchObject({ balance: 0, sequence: 3 });
    expect(lostResult.profile?.disabledReason).toBeUndefined();
  });
});
