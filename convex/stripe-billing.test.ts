/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import {
  CREDIT_PACKS,
  STRIPE_EVENT_MAX_ATTEMPTS,
  createHostedCheckout,
  cumulativeRefundCredits,
} from "./billing";
import { atomsToUsdCents, publisherEarningSplit } from "./accounting";
import type { Id } from "./_generated/dataModel";
import { verifyStripeWebhook } from "./http";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function drainFinancialJobs(
  t: TestConvex<typeof schema>,
  paymentId: Id<"payments">,
): Promise<void> {
  for (let chunk = 0; chunk < 20; chunk += 1) {
    const result = await t.mutation(
      internal.billing.processPublisherReconciliation,
      { paymentId },
    );
    if (result.complete) return;
  }
  throw new Error("publisher reconciliation did not converge");
}

type FinancialSeed = {
  consumerOrganizationId: Id<"organizations">;
  publisherOrganizationId: Id<"organizations">;
  projectId: Id<"projects">;
  paymentId: Id<"payments">;
  earningId: Id<"publisherEarnings">;
};

async function seedFinancialPayment(
  t: TestConvex<typeof schema>,
  suffix: string,
  walletBalance: number,
): Promise<FinancialSeed> {
  const seeded = await t.run(async (ctx) => {
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
      balance: 0,
      sequence: 0,
    });
    await ctx.db.insert("organizationPayments", {
      organizationId: consumerOrganizationId,
      stripeCustomerId: `cus_${suffix}`,
      detailsSubmitted: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      requirements: [],
      updatedAt: 1,
    });
    await ctx.db.insert("organizationPayments", {
      organizationId: publisherOrganizationId,
      detailsSubmitted: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      requirements: [],
      updatedAt: 1,
    });
    await ctx.db.insert("checkoutIntents", {
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
    const projectId = await ctx.db.insert("projects", {
      organizationId: publisherOrganizationId,
      name: "Publisher API",
      slug: `publisher-api-${suffix}`,
      status: "published",
      visibility: "public",
      tags: [],
    });
    return { consumerOrganizationId, publisherOrganizationId, projectId };
  });
  const payment = await t.mutation(internal.billing.upsertPaidPayment, {
    stripeCheckoutSessionId: `cs_${suffix}`,
    stripePaymentIntentId: `pi_${suffix}`,
    stripeChargeId: `ch_${suffix}`,
  });
  await t.mutation(internal.wallets.grantPaymentCredits, {
    organizationId: seeded.consumerOrganizationId,
    paymentId: payment.paymentId,
    amount: 100,
    refId: `stripe:payment_intent:pi_${suffix}`,
  });
  await t.mutation(internal.wallets.recordUsage, {
    events: [
      {
        organizationId: seeded.publisherOrganizationId,
        projectId: seeded.projectId,
        endpoint: "/financial-test",
        method: "POST",
        credits: 100,
        status: 200,
        latencyMs: 1,
        keyId: "key_financial_test",
        at: 10,
        settleRefId: `settle:${suffix}`,
        consumerClerkOrgId: `org_consumer_${suffix}`,
      },
    ],
  });
  if (walletBalance > 0) {
    await t.mutation(internal.wallets.applyAdminAdjustment, {
      organizationId: seeded.consumerOrganizationId,
      amount: walletBalance,
      refId: `admin:${suffix}:post-usage`,
    });
  }
  const earningId = await t.run(async (ctx) => {
    const earning = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_settlement", (q) =>
        q.eq("usageSettlementRefId", `settle:${suffix}`),
      )
      .unique();
    if (earning === null) throw new Error("canonical earning missing");
    await ctx.db.patch(earning._id, { availableAt: 1 });
    return earning._id;
  });
  await t.mutation(internal.payouts.releaseMatureEarnings, {
    publisherOrganizationId: seeded.publisherOrganizationId,
  });
  return { ...seeded, paymentId: payment.paymentId, earningId };
}

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
    ).toEqual({ isNew: false, scheduled: false });
    expect(
      await t.mutation(internal.billing.claimStripeEvent, {
        stripeEventId: "evt_one",
      }),
    ).toBeNull();
    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("paymentEvents")
        .withIndex("by_stripe_event", (q) => q.eq("stripeEventId", "evt_one"))
        .unique();
      if (event === null) throw new Error("event missing");
      await ctx.db.patch(event._id, { nextAttemptAt: 0 });
    });
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

  it("keeps exhausted poison receipts dead until an explicit admin replay", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_poison_recovery",
        name: "Poison recovery",
        slug: "poison-recovery",
      });
      await ctx.db.insert("checkoutIntents", {
        organizationId,
        packId: "pack_10",
        stripePriceId: "price_poison",
        amount: 1_000,
        currency: "usd",
        credits: 100_000,
        stripeCheckoutSessionId: "cs_poison",
        status: "open",
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      });
      await ctx.db.insert("paymentEvents", {
        stripeEventId: "evt_poison",
        stripeAccount: "platform",
        eventType: "checkout.session.expired",
        objectId: "cs_poison",
        status: "failed",
        attempts: STRIPE_EVENT_MAX_ATTEMPTS,
        deliveries: 1,
        lastError: "poison",
        receivedAt: 1,
      });
    });
    expect(
      await t.mutation(internal.billing.receiveStripeEvent, {
        stripeEventId: "evt_poison",
        stripeAccount: "platform",
        eventType: "checkout.session.expired",
        objectId: "cs_poison",
      }),
    ).toEqual({ isNew: false, scheduled: false });
    expect(
      await t.mutation(internal.billing.claimStripeEvent, {
        stripeEventId: "evt_poison",
      }),
    ).toBeNull();
    const prior = process.env.ADMIN_USER_IDS;
    process.env.ADMIN_USER_IDS = "operator";
    try {
      await expect(
        t
          .withIdentity({ subject: "member" } as { subject: string })
          .mutation(api.billing.replayStripeEvent, {
            stripeEventId: "evt_poison",
          }),
      ).rejects.toThrow("Not authorized as admin");
      await expect(
        t
          .withIdentity({ subject: "operator" } as { subject: string })
          .mutation(api.billing.replayStripeEvent, {
            stripeEventId: "evt_poison",
          }),
      ).resolves.toEqual({ scheduled: true });
    } finally {
      if (prior === undefined) delete process.env.ADMIN_USER_IDS;
      else process.env.ADMIN_USER_IDS = prior;
    }
    const replayed = await t.run(async (ctx) =>
      ctx.db
        .query("paymentEvents")
        .withIndex("by_stripe_event", (q) =>
          q.eq("stripeEventId", "evt_poison"),
        )
        .unique(),
    );
    expect(replayed).toMatchObject({
      status: "received",
      attempts: 0,
      deliveries: 2,
      replayCount: 1,
      lastReplayedBy: "operator",
    });
    const priorStripeKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_local_projection";
    try {
      await t.action(internal.billing.processStripeEvent, {
        stripeEventId: "evt_poison",
      });
    } finally {
      if (priorStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = priorStripeKey;
    }
    const recovered = await t.run(async (ctx) => {
      const [event, checkout] = await Promise.all([
        ctx.db
          .query("paymentEvents")
          .withIndex("by_stripe_event", (q) =>
            q.eq("stripeEventId", "evt_poison"),
          )
          .unique(),
        ctx.db
          .query("checkoutIntents")
          .withIndex("by_checkout_session", (q) =>
            q.eq("stripeCheckoutSessionId", "cs_poison"),
          )
          .unique(),
      ]);
      return { event, checkout };
    });
    expect(recovered.event).toMatchObject({
      status: "processed",
      attempts: 1,
      replayCount: 1,
    });
    expect(recovered.checkout).toMatchObject({ status: "expired" });
  });

  it("projects failed and expired Checkout sessions into terminal UI states", async () => {
    const t = convexTest(schema, modules);
    const organizationId = await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_checkout_terminal",
        name: "Terminal checkout",
        slug: "terminal-checkout",
      });
      for (const [session, status] of [
        ["cs_failed", "open"],
        ["cs_expired", "open"],
        ["cs_complete", "complete"],
      ] as const) {
        await ctx.db.insert("checkoutIntents", {
          organizationId,
          packId: "pack_10",
          stripePriceId: `price_${session}`,
          amount: 1_000,
          currency: "usd",
          credits: 100_000,
          stripeCheckoutSessionId: session,
          status,
          createdAt: 1,
          updatedAt: 1,
          expiresAt: 2,
        });
      }
      for (const [stripeEventId, eventType, objectId] of [
        [
          "evt_checkout_failed",
          "checkout.session.async_payment_failed",
          "cs_failed",
        ],
        ["evt_checkout_expired", "checkout.session.expired", "cs_expired"],
      ] as const) {
        await ctx.db.insert("paymentEvents", {
          stripeEventId,
          stripeAccount: "platform",
          eventType,
          objectId,
          status: "received",
          attempts: 0,
          deliveries: 1,
          receivedAt: 1,
        });
      }
      return organizationId;
    });
    const priorStripeKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_local_projection";
    try {
      await t.action(internal.billing.processStripeEvent, {
        stripeEventId: "evt_checkout_failed",
      });
      await t.action(internal.billing.processStripeEvent, {
        stripeEventId: "evt_checkout_expired",
      });
    } finally {
      if (priorStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = priorStripeKey;
    }
    await t.mutation(internal.billing.markCheckoutIntentTerminal, {
      stripeCheckoutSessionId: "cs_complete",
      status: "failed",
    });
    const statuses = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("checkoutIntents")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", organizationId),
        )
        .collect();
      return Object.fromEntries(
        rows.map((row) => [row.stripeCheckoutSessionId, row.status]),
      );
    });
    expect(statuses).toEqual({
      cs_failed: "failed",
      cs_expired: "expired",
      cs_complete: "complete",
    });
  });

  it("correlates cancel UI state only to an authorized local intent", async () => {
    const t = convexTest(schema, modules);
    const intentId = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_cancel_owner",
        name: "Cancel owner",
        slug: "cancel-owner",
      });
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_cancel_outsider",
        name: "Cancel outsider",
        slug: "cancel-outsider",
      });
      return await ctx.db.insert("checkoutIntents", {
        organizationId: ownerId,
        packId: "pack_10",
        stripePriceId: "price_cancel",
        amount: 1_000,
        currency: "usd",
        credits: 100_000,
        stripeCheckoutSessionId: "cs_cancel",
        status: "open",
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      });
    });
    const owner = t.withIdentity({
      subject: "owner",
      org_id: "org_cancel_owner",
    } as { subject: string; org_id: string });
    const outsider = t.withIdentity({
      subject: "outsider",
      org_id: "org_cancel_outsider",
    } as { subject: string; org_id: string });
    await expect(
      owner.query(api.billing.getBillingState, {
        checkoutIntentId: intentId,
      }),
    ).resolves.toMatchObject({
      checkout: { id: intentId, status: "canceled" },
    });
    await expect(
      outsider.query(api.billing.getBillingState, {
        checkoutIntentId: intentId,
      }),
    ).resolves.toMatchObject({ checkout: null });
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

  it("moves no money for an inquiry and exactly claws back/restores real dispute funds", async () => {
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
    expect(snapshot.wallet).toMatchObject({ balance: 20, sequence: 3 });
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
    await drainFinancialJobs(t, seed.paymentId);
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
    expect(snapshot.wallet).toMatchObject({ balance: 20, sequence: 3 });
    expect(snapshot.payment).toMatchObject({
      status: "disputed",
      reversedCredits: 100,
    });
    expect(snapshot.publisher?.availableAtoms).toBe(0);
    expect(snapshot.walletEntries).toHaveLength(3);

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
    await drainFinancialJobs(t, seed.paymentId);
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
    expect(restored.wallet).toMatchObject({ balance: 20, sequence: 3 });
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
    expect(restored.walletEntries).toHaveLength(3);
    expect(restored.publisherEntries.map((entry) => entry.kind)).toEqual([
      "earning_release",
      "dispute_clawback",
      "dispute_restoration",
    ]);
  });

  it("caps overlaps and restores closed dispute provenance before reallocating", async () => {
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
    await drainFinancialJobs(t, seed.paymentId);
    let payment = await t.run(async (ctx) => ctx.db.get(seed.paymentId));
    expect(payment).toMatchObject({
      refundedCredits: 20,
      reversedCredits: 100,
      publisherClawbackTargetCredits: 100,
    });

    await dispute("evt_d1_back", "dp_one", "won", "funds_reinstated");
    await dispute("evt_d2_lost", "dp_two", "lost", "none");
    await drainFinancialJobs(t, seed.paymentId);
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
    // Refund 20 + remaining dispute 60 = 80. Winning first dispute restores
    // only 20 because second dispute had already consumed grant cap headroom.
    expect(result.payment).toMatchObject({
      status: "dispute_lost",
      refundedCredits: 20,
      reversedCredits: 80,
    });
    expect(result.wallet?.balance).toBe(100);
    expect(result.publisher?.availableAtoms).toBe(190_000);
    const activeBySource = Object.fromEntries(
      [
        "stripe:refund:re_partial",
        "stripe:dispute:dp_one",
        "stripe:dispute:dp_two",
      ].map((sourceRef) => [
        sourceRef,
        result.clawbacks
          .filter((row) => row.sourceRef === sourceRef)
          .reduce(
            (sum, row) =>
              sum + row.grossCredits - (row.restoredGrossCredits ?? 0),
            0,
          ),
      ]),
    );
    expect(activeBySource).toEqual({
      "stripe:refund:re_partial": 20,
      "stripe:dispute:dp_one": 0,
      "stripe:dispute:dp_two": 60,
    });
  });

  it("ignores stale cumulative refunds and claws publisher earnings back atomically", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedFinancialPayment(t, "refund", 100);
    await t.mutation(internal.billing.applyRefundProjection, {
      stripeRefundId: "re_half",
      stripeChargeId: "ch_refund",
      refundAmount: 500,
      totalRefundedAmount: 500,
    });
    await t.mutation(internal.billing.applyRefundProjection, {
      stripeRefundId: "re_half",
      stripeChargeId: "ch_refund",
      refundAmount: 500,
      totalRefundedAmount: 100,
    });
    await drainFinancialJobs(t, seed.paymentId);
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
    expect(result.wallet?.balance).toBe(100);
    expect(result.publisher?.availableAtoms).toBe(475_000);
    expect(result.clawbacks).toHaveLength(1);
  });

  it("turns a clawback after transfer into publisher debt and repays it before payout", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedFinancialPayment(t, "paid_clawback", 100);
    await t.mutation(internal.payouts.setConnectedAccount, {
      organizationId: seed.publisherOrganizationId,
      stripeConnectedAccountId: "acct_paid_clawback",
    });
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.publisherOrganizationId),
        )
        .unique();
      if (profile === null) throw new Error("publisher profile missing");
      await ctx.db.patch(profile._id, { payoutsEnabled: true });
    });
    await t.mutation(internal.wallets.applyAdminAdjustment, {
      organizationId: seed.consumerOrganizationId,
      amount: 109_900,
      refId: "admin:paid-clawback:scale",
    });
    await t.mutation(internal.wallets.recordUsage, {
      events: [
        {
          organizationId: seed.publisherOrganizationId,
          projectId: seed.projectId,
          endpoint: "/financial-test",
          method: "POST",
          credits: 109_900,
          status: 200,
          latencyMs: 1,
          keyId: "key_financial_test",
          at: 20,
          settleRefId: "settle:paid-clawback-scale",
          consumerClerkOrgId: "org_consumer_paid_clawback",
        },
      ],
    });
    await t.run(async (ctx) => {
      const earning = await ctx.db
        .query("publisherEarnings")
        .withIndex("by_settlement", (q) =>
          q.eq("usageSettlementRefId", "settle:paid-clawback-scale"),
        )
        .unique();
      if (earning === null) throw new Error("scaled earning missing");
      await ctx.db.patch(earning._id, { availableAt: 1 });
    });
    await t.mutation(internal.payouts.releaseMatureEarnings, {
      publisherOrganizationId: seed.publisherOrganizationId,
    });
    const priorCorrelationSecret =
      process.env.STRIPE_TRANSFER_CORRELATION_SECRET;
    process.env.STRIPE_TRANSFER_CORRELATION_SECRET =
      "transfer-test-secret-32-bytes-minimum";
    try {
      const transfer = await t.mutation(
        internal.payouts.preparePublisherTransfer,
        {
          publisherOrganizationId: seed.publisherOrganizationId,
          correlationNonce: "a".repeat(64),
          platformAccountId: "acct_platform_test",
        },
      );
      await t.mutation(internal.payouts.markPublisherTransferSucceeded, {
        transferId: transfer.transferId,
        stripeTransferId: "tr_paid_clawback",
      });
    } finally {
      if (priorCorrelationSecret === undefined) {
        delete process.env.STRIPE_TRANSFER_CORRELATION_SECRET;
      } else {
        process.env.STRIPE_TRANSFER_CORRELATION_SECRET = priorCorrelationSecret;
      }
    }

    await t.mutation(internal.billing.applyRefundProjection, {
      stripeRefundId: "re_paid_full",
      stripeChargeId: "ch_paid_clawback",
      refundAmount: 1_000,
      totalRefundedAmount: 1_000,
    });
    await drainFinancialJobs(t, seed.paymentId);
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
      paidAtoms: 1_045_000_000,
    });

    await t.mutation(internal.wallets.recordUsage, {
      events: [
        {
          organizationId: seed.publisherOrganizationId,
          projectId: seed.projectId,
          endpoint: "/financial-test",
          method: "POST",
          credits: 100,
          status: 200,
          latencyMs: 1,
          keyId: "key_financial_test",
          at: 30,
          settleRefId: "settle:future-after-debt",
          consumerClerkOrgId: "org_consumer_paid_clawback",
        },
      ],
    });
    await t.run(async (ctx) => {
      const earning = await ctx.db
        .query("publisherEarnings")
        .withIndex("by_settlement", (q) =>
          q.eq("usageSettlementRefId", "settle:future-after-debt"),
        )
        .unique();
      if (earning === null) throw new Error("future earning missing");
      await ctx.db.patch(earning._id, { availableAt: 1 });
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
