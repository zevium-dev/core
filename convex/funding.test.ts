/// <reference types="vite/client" />
import { signReservationProof } from "@zevium/shared";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const GATEWAY_SECRET = "gateway-test-secret-32-bytes-minimum";

type Seed = {
  consumerId: Id<"organizations">;
  publisherId: Id<"organizations">;
  projectId: Id<"projects">;
};

async function seed(
  t: TestConvex<typeof schema>,
  suffix: string,
): Promise<Seed> {
  return await t.run(async (ctx) => {
    const consumerId = await ctx.db.insert("organizations", {
      clerkOrgId: `org_consumer_${suffix}`,
      name: "Consumer",
      slug: `consumer-${suffix}`,
    });
    const publisherId = await ctx.db.insert("organizations", {
      clerkOrgId: `org_publisher_${suffix}`,
      name: "Publisher",
      slug: `publisher-${suffix}`,
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: publisherId,
      name: "API",
      slug: `api-${suffix}`,
      status: "published",
      visibility: "public",
      tags: [],
    });
    await ctx.db.insert("wallets", {
      organizationId: consumerId,
      balance: 0,
      sequence: 0,
    });
    await ctx.db.insert("organizationPayments", {
      organizationId: consumerId,
      stripeCustomerId: `cus_${suffix}`,
      detailsSubmitted: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      requirements: [],
      updatedAt: Date.now(),
    });
    return { consumerId, publisherId, projectId };
  });
}

async function grantPayment(
  t: TestConvex<typeof schema>,
  seed: Seed,
  suffix: string,
  credits: number,
): Promise<Id<"payments">> {
  const intentId = await t.run(
    async (ctx) =>
      await ctx.db.insert("checkoutIntents", {
        organizationId: seed.consumerId,
        packId: "pack_10",
        stripePriceId: `price_${suffix}`,
        amount: 1_000,
        currency: "usd",
        credits,
        stripeCheckoutSessionId: `cs_${suffix}`,
        status: "complete",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
  );
  const payment = await t.mutation(internal.billing.upsertPaidPayment, {
    stripeCheckoutSessionId: `cs_${suffix}`,
    stripePaymentIntentId: `pi_${suffix}`,
    stripeChargeId: `ch_${suffix}`,
  });
  expect(payment.paymentId).not.toBe(intentId);
  await t.mutation(internal.wallets.grantPaymentCredits, {
    organizationId: seed.consumerId,
    paymentId: payment.paymentId,
    amount: credits,
    refId: `stripe:payment_intent:pi_${suffix}`,
  });
  return payment.paymentId;
}

function usage(seed: Seed, refId: string, credits: number) {
  return {
    organizationId: seed.publisherId,
    projectId: seed.projectId,
    endpoint: "/v1/work",
    method: "POST",
    credits,
    status: 200,
    latencyMs: 12,
    keyId: "key_test",
    at: Date.now(),
    settleRefId: refId,
    consumerClerkOrgId: `org_consumer_${refId.split(":")[1]}`,
  };
}

describe("universal wallet funding", () => {
  const previousSecret = process.env.GATEWAY_INTERNAL_SECRET;

  beforeEach(() => {
    process.env.GATEWAY_INTERNAL_SECRET = GATEWAY_SECRET;
  });

  afterEach(() => {
    if (previousSecret === undefined)
      delete process.env.GATEWAY_INTERNAL_SECRET;
    else process.env.GATEWAY_INTERNAL_SECRET = previousSecret;
  });

  it("consumes two payments in true FIFO order", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "fifo");
    const firstPaymentId = await grantPayment(t, s, "fifo_one", 100);
    const secondPaymentId = await grantPayment(t, s, "fifo_two", 100);

    expect(
      await t.mutation(internal.wallets.recordUsage, {
        events: [
          {
            ...usage(s, "settle:fifo", 150),
            consumerClerkOrgId: "org_consumer_fifo",
          },
        ],
      }),
    ).toMatchObject({ results: [{ status: "applied" }] });

    const result = await t.run(async (ctx) => {
      const allocations = await ctx.db
        .query("walletFundingAllocations")
        .withIndex("by_payment_created", (q) =>
          q.eq("paymentId", firstPaymentId),
        )
        .collect();
      const second = await ctx.db
        .query("walletFundingAllocations")
        .withIndex("by_payment_created", (q) =>
          q.eq("paymentId", secondPaymentId),
        )
        .collect();
      const lots = await ctx.db.query("walletFundingLots").collect();
      return { allocations, second, lots };
    });
    expect(result.allocations.map((row) => row.grossCredits)).toEqual([100]);
    expect(result.second.map((row) => row.grossCredits)).toEqual([50]);
    expect(
      result.lots
        .filter((lot) => lot.paymentId === secondPaymentId)
        .map((lot) => lot.availableCredits),
    ).toEqual([50]);
  });

  it("consumes promotion before refundable payment and refunds payment without clawback", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "promo");
    await t.mutation(internal.wallets.applyAdminAdjustment, {
      organizationId: s.consumerId,
      amount: 50,
      refId: "promo:welcome",
      promotion: true,
    });
    const paymentId = await grantPayment(t, s, "promo_payment", 100);
    await t.mutation(internal.wallets.recordUsage, {
      events: [
        {
          ...usage(s, "settle:promo", 50),
          consumerClerkOrgId: "org_consumer_promo",
        },
      ],
    });
    await t.mutation(internal.billing.applyRefundProjection, {
      stripeRefundId: "re_promo_full",
      stripeChargeId: "ch_promo_payment",
      refundAmount: 1_000,
      totalRefundedAmount: 1_000,
    });

    const result = await t.run(async (ctx) => {
      const wallet = await ctx.db
        .query("wallets")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", s.consumerId),
        )
        .unique();
      const exposure = await ctx.db
        .query("paymentExposures")
        .withIndex("by_source", (q) =>
          q.eq("sourceRef", "stripe:refund:re_promo_full"),
        )
        .unique();
      const allocations = await ctx.db
        .query("walletFundingAllocations")
        .collect();
      return {
        wallet,
        exposure,
        allocations,
        payment: await ctx.db.get(paymentId),
      };
    });
    expect(result.wallet).toMatchObject({ balance: 0 });
    expect(result.exposure).toMatchObject({
      walletCredits: 100,
      publisherCredits: 0,
    });
    expect(result.payment).toMatchObject({ status: "refunded" });
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]?.paymentId).toBeUndefined();
  });

  it("rejects an underfunded negative adjustment before any ledger side effect", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "underflow");
    await t.mutation(internal.wallets.applyAdminAdjustment, {
      organizationId: s.consumerId,
      amount: 10,
      refId: "admin:underflow:grant",
    });
    await expect(
      t.mutation(internal.wallets.applyAdminAdjustment, {
        organizationId: s.consumerId,
        amount: -11,
        refId: "admin:underflow:debit",
      }),
    ).rejects.toThrow("cannot cover");
    const rows = await t.run(async (ctx) =>
      ctx.db.query("walletEntries").collect(),
    );
    expect(rows.map((row) => [row.refId, row.amount])).toEqual([
      ["admin:underflow:grant", 10],
    ]);
  });

  it("rejects a mutated settlement replay without duplicating financial rows", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "replay");
    await grantPayment(t, s, "replay_payment", 100);
    const event = {
      ...usage(s, "settle:replay", 10),
      consumerClerkOrgId: "org_consumer_replay",
    };
    await t.mutation(internal.wallets.recordUsage, { events: [event] });
    const replay = await t.mutation(internal.wallets.recordUsage, {
      events: [{ ...event, credits: 11 }],
    });
    expect(replay.results).toEqual([
      {
        refId: "settle:replay",
        status: "rejected",
        reason: "settlement replay changed immutable payload or linkage",
        retryable: false,
      },
    ]);
    const counts = await t.run(async (ctx) => ({
      usage: (await ctx.db.query("usageEvents").collect()).length,
      earnings: (await ctx.db.query("publisherEarnings").collect()).length,
      ledger: (await ctx.db.query("walletEntries").collect()).length,
    }));
    expect(counts).toEqual({ usage: 1, earnings: 1, ledger: 2 });
  });

  it("honors a signed pre-refund reservation and records wallet debt", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "race");
    await grantPayment(t, s, "race_payment", 100);
    const reservedAt = Date.now();
    const base = {
      ...usage(s, "settle:race", 20),
      consumerClerkOrgId: "org_consumer_race",
      at: reservedAt + 1,
    };
    const signature = await signReservationProof(GATEWAY_SECRET, {
      consumerClerkOrgId: base.consumerClerkOrgId,
      reservationId: "race",
      credits: 20,
      checkpointSequence: 1,
      authorizedBalance: 100,
      reservedAt,
      keyId: base.keyId,
    });
    await t.mutation(internal.billing.applyRefundProjection, {
      stripeRefundId: "re_race",
      stripeChargeId: "ch_race_payment",
      refundAmount: 1_000,
      totalRefundedAmount: 1_000,
    });
    const settled = await t.mutation(internal.wallets.recordUsage, {
      events: [
        {
          ...base,
          reservationProof: {
            checkpointSequence: 1,
            authorizedBalance: 100,
            reservedAt,
            signature,
          },
        },
      ],
    });
    expect(settled).toMatchObject({
      results: [{ status: "applied" }],
      wallet: { balance: -20, sequence: 3 },
    });
    const result = await t.run(async (ctx) => ({
      wallet: await ctx.db
        .query("wallets")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", s.consumerId),
        )
        .unique(),
      debt: await ctx.db
        .query("walletFundingAllocations")
        .filter((q) => q.eq(q.field("kind"), "reservation_debt"))
        .collect(),
      earnings: await ctx.db.query("publisherEarnings").collect(),
    }));
    expect(result.wallet?.debtCredits).toBe(20);
    expect(result.debt).toHaveLength(1);
    expect(result.debt[0]).toMatchObject({ grossCredits: 20 });
    expect(result.earnings).toHaveLength(1);
  });

  it("bounds lot fan-out and returns retryable without partial financial writes", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "bounded");
    for (let index = 0; index < 17; index += 1) {
      await t.mutation(internal.wallets.applyAdminAdjustment, {
        organizationId: s.consumerId,
        amount: 1,
        refId: `promo:bounded:${index}`,
        promotion: true,
      });
    }
    const result = await t.mutation(internal.wallets.recordUsage, {
      events: [
        {
          ...usage(s, "settle:bounded", 17),
          consumerClerkOrgId: "org_consumer_bounded",
        },
      ],
    });
    expect(result.results).toEqual([
      {
        refId: "settle:bounded",
        status: "rejected",
        reason: "Funding allocation exceeds bounded lot fan-out",
        retryable: true,
      },
    ]);
    const counts = await t.run(async (ctx) => ({
      usage: (await ctx.db.query("usageEvents").collect()).length,
      earnings: (await ctx.db.query("publisherEarnings").collect()).length,
      ledger: (await ctx.db.query("walletEntries").collect()).length,
    }));
    expect(counts).toEqual({ usage: 0, earnings: 0, ledger: 17 });
  });

  it("reconciles a million-credit source through fixed 20-row journal chunks", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "million");
    const paymentId = await grantPayment(t, s, "million_payment", 1_000_000);
    const events = Array.from({ length: 50 }, (_, index) => ({
      ...usage(s, `settle:million:${index}`, 20_000),
      consumerClerkOrgId: "org_consumer_million",
    }));
    await t.mutation(internal.wallets.recordUsage, {
      events: events.slice(0, 25),
    });
    await t.mutation(internal.wallets.recordUsage, {
      events: events.slice(25),
    });
    await t.mutation(internal.billing.applyRefundProjection, {
      stripeRefundId: "re_million",
      stripeChargeId: "ch_million_payment",
      refundAmount: 1_000,
      totalRefundedAmount: 1_000,
    });

    const processed: number[] = [];
    for (let chunk = 0; chunk < 10; chunk += 1) {
      const result = await t.mutation(
        internal.billing.processPublisherReconciliation,
        { paymentId },
      );
      processed.push(result.processed);
      if (result.complete) break;
    }
    expect(processed).toEqual([400_000, 400_000, 200_000, 0]);
    const state = await t.run(async (ctx) => ({
      clawbacks: (await ctx.db.query("publisherClawbacks").collect()).length,
      job: await ctx.db
        .query("publisherReconciliationJobs")
        .withIndex("by_payment", (q) => q.eq("paymentId", paymentId))
        .unique(),
    }));
    expect(state.clawbacks).toBe(50);
    expect(state.job).toMatchObject({ status: "complete", processedChunks: 4 });
  });
});
