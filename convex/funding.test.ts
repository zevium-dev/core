/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

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

  it("cannot use a new grant to repair a stale funding watermark", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "grant-fence");
    await grantPayment(t, s, "grant_fence_one", 100);
    await t.run(async (ctx) => {
      const wallet = await ctx.db
        .query("wallets")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", s.consumerId),
        )
        .unique();
      if (wallet === null) throw new Error("wallet missing");
      const state = await ctx.db
        .query("walletFundingStates")
        .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id))
        .unique();
      if (state === null) throw new Error("funding state missing");
      await ctx.db.patch(state._id, { migrationWatermarkSequence: 0 });
      await ctx.db.insert("checkoutIntents", {
        organizationId: s.consumerId,
        packId: "pack_10",
        stripePriceId: "price_grant_fence_two",
        amount: 1_000,
        currency: "usd",
        credits: 100,
        stripeCheckoutSessionId: "cs_grant_fence_two",
        status: "complete",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
    });
    const second = await t.mutation(internal.billing.upsertPaidPayment, {
      stripeCheckoutSessionId: "cs_grant_fence_two",
      stripePaymentIntentId: "pi_grant_fence_two",
      stripeChargeId: "ch_grant_fence_two",
    });
    await expect(
      t.mutation(internal.wallets.grantPaymentCredits, {
        organizationId: s.consumerId,
        paymentId: second.paymentId,
        amount: 100,
        refId: "stripe:payment_intent:pi_grant_fence_two",
      }),
    ).rejects.toThrow(
      "Positive funding source cannot repair an unverified checkpoint",
    );
    const result = await t.run(async (ctx) => ({
      wallet: await ctx.db
        .query("wallets")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", s.consumerId),
        )
        .unique(),
      entries: await ctx.db.query("walletEntries").collect(),
      lots: await ctx.db.query("walletFundingLots").collect(),
    }));
    expect(result.wallet).toMatchObject({ balance: 100, sequence: 1 });
    expect(result.entries).toHaveLength(1);
    expect(result.lots).toHaveLength(1);
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
      status: "succeeded",
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

  it("rejects ambiguous promotion provenance before creating a ledger entry", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "promo-binding");
    await expect(
      t.mutation(internal.wallets.applyAdminAdjustment, {
        organizationId: s.consumerId,
        amount: 10,
        refId: "admin:ambiguous-promotion",
        promotion: true,
      }),
    ).rejects.toThrow("immutable promotion provenance");
    await expect(
      t.mutation(internal.wallets.applyAdminAdjustment, {
        organizationId: s.consumerId,
        amount: 10,
        refId: "promo:missing-flag",
      }),
    ).rejects.toThrow("immutable promotion provenance");
    expect(
      await t.run(async (ctx) => ctx.db.query("walletEntries").collect()),
    ).toEqual([]);
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
    ).rejects.toThrow("authoritative balance");
    const rows = await t.run(async (ctx) =>
      ctx.db.query("walletEntries").collect(),
    );
    expect(rows.map((row) => [row.refId, row.amount])).toEqual([
      ["admin:underflow:grant", 10],
    ]);
  });

  it("binds a replayed negative adjustment before funding allocation", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "admin-replay");
    await t.mutation(internal.wallets.applyAdminAdjustment, {
      organizationId: s.consumerId,
      amount: 100,
      refId: "admin:replay:grant",
    });
    const debit = {
      organizationId: s.consumerId,
      amount: -20,
      refId: "admin:replay:debit",
    };
    expect(
      await t.mutation(internal.wallets.applyAdminAdjustment, debit),
    ).toMatchObject({ applied: true, balance: 80 });
    expect(
      await t.mutation(internal.wallets.applyAdminAdjustment, debit),
    ).toMatchObject({ applied: false, balance: 80 });
    const state = await t.run(async (ctx) => {
      const wallet = await ctx.db
        .query("wallets")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", s.consumerId),
        )
        .unique();
      if (wallet === null) throw new Error("wallet missing");
      return {
        wallet,
        entries: await ctx.db
          .query("walletEntries")
          .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id))
          .collect(),
        allocations: await ctx.db
          .query("walletFundingAllocations")
          .withIndex("by_wallet_created", (q) => q.eq("walletId", wallet._id))
          .collect(),
      };
    });
    expect(state.entries).toHaveLength(2);
    expect(state.allocations).toHaveLength(1);
    expect(state.allocations[0]?.grossCredits).toBe(20);
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

  it("validates publisher and project ownership before duplicate acceptance", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "ownership");
    await grantPayment(t, s, "ownership_payment", 100);
    const event = {
      ...usage(s, "settle:ownership", 10),
      consumerClerkOrgId: "org_consumer_ownership",
    };
    await t.mutation(internal.wallets.recordUsage, { events: [event] });
    const other = await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_other_publisher",
        name: "Other Publisher",
        slug: "other-publisher",
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId,
        name: "Other API",
        slug: "other-api",
        status: "published",
        visibility: "public",
        tags: [],
      });
      return { organizationId, projectId };
    });
    for (const replay of [
      { ...event, organizationId: other.organizationId },
      { ...event, projectId: other.projectId },
    ]) {
      expect(
        (await t.mutation(internal.wallets.recordUsage, { events: [replay] }))
          .results,
      ).toEqual([
        {
          refId: event.settleRefId,
          status: "rejected",
          reason: "publisher organization does not own project",
          retryable: false,
        },
      ]);
    }
  });

  it("caps one settlement transaction by total projected writes", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "write-budget");
    await t.mutation(internal.wallets.applyAdminAdjustment, {
      organizationId: s.consumerId,
      amount: 1,
      refId: "promo:write-budget",
      promotion: true,
    });
    const events = Array.from({ length: 12 }, (_, index) => ({
      ...usage(s, `settle:write-budget:${index}`, 0),
      consumerClerkOrgId: "org_consumer_write-budget",
    }));
    const result = await t.mutation(internal.wallets.recordUsage, { events });
    expect(
      result.results.filter((row) => row.status === "applied"),
    ).toHaveLength(10);
    expect(
      result.results.filter(
        (row) => row.status === "rejected" && row.retryable === true,
      ),
    ).toHaveLength(2);
    const rows = await t.run(async (ctx) => ({
      usage: await ctx.db.query("usageEvents").collect(),
      earnings: await ctx.db.query("publisherEarnings").collect(),
    }));
    expect(rows.usage).toHaveLength(10);
    expect(rows.earnings).toHaveLength(10);
  });

  it("denies a stale reservation after refund without minting debt", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "race");
    await grantPayment(t, s, "race_payment", 100);
    const base = {
      ...usage(s, "settle:race", 20),
      consumerClerkOrgId: "org_consumer_race",
      at: Date.now(),
    };
    await t.mutation(internal.billing.applyRefundProjection, {
      stripeRefundId: "re_race",
      stripeChargeId: "ch_race_payment",
      refundAmount: 1_000,
      totalRefundedAmount: 1_000,
      status: "succeeded",
    });
    const settled = await t.mutation(internal.wallets.recordUsage, {
      events: [base],
    });
    expect(settled).toMatchObject({
      results: [
        {
          status: "rejected",
          retryable: false,
          reason: "reservation checkpoint is stale after ledger debit",
        },
      ],
      wallet: { balance: 0, sequence: 2 },
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
    expect(result.wallet).toMatchObject({ balance: 0, debtCredits: 0 });
    expect(result.debt).toHaveLength(0);
    expect(result.earnings).toHaveLength(0);
  });

  it("restores failed refund inventory through an exact payment funding lot", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "refund-restore");
    const paymentId = await grantPayment(t, s, "refund_restore_payment", 100);

    await t.mutation(internal.billing.applyRefundProjection, {
      stripeRefundId: "re_restore",
      stripeChargeId: "ch_refund_restore_payment",
      refundAmount: 1_000,
      totalRefundedAmount: 1_000,
      status: "pending",
    });
    await t.mutation(internal.billing.applyRefundProjection, {
      stripeRefundId: "re_restore",
      stripeChargeId: "ch_refund_restore_payment",
      refundAmount: 1_000,
      totalRefundedAmount: 0,
      status: "failed",
    });

    const result = await t.run(async (ctx) => {
      const wallet = await ctx.db
        .query("wallets")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", s.consumerId),
        )
        .unique();
      if (wallet === null) throw new Error("wallet missing");
      return {
        wallet,
        payment: await ctx.db.get(paymentId),
        state: await ctx.db
          .query("walletFundingStates")
          .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id))
          .unique(),
        entries: await ctx.db
          .query("walletEntries")
          .withIndex("by_wallet_sequence", (q) => q.eq("walletId", wallet._id))
          .collect(),
        lots: await ctx.db
          .query("walletFundingLots")
          .withIndex("by_payment_created", (q) => q.eq("paymentId", paymentId))
          .collect(),
        reversals: await ctx.db
          .query("walletFundingReversals")
          .withIndex("by_payment_created", (q) => q.eq("paymentId", paymentId))
          .collect(),
      };
    });
    expect(result.wallet).toMatchObject({ balance: 100, sequence: 3 });
    expect(result.payment).toMatchObject({
      status: "paid",
      refundedAmount: 0,
      refundedCredits: 0,
      reversedCredits: 0,
      walletReversedCredits: 0,
      publisherClawbackTargetCredits: 0,
    });
    expect(result.entries.map((entry) => [entry.kind, entry.amount])).toEqual([
      ["payment_grant", 100],
      ["refund_reversal", -100],
      ["refund_restoration", 100],
    ]);
    expect(result.lots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKind: "stripe_payment",
          grantedCredits: 100,
          availableCredits: 0,
          reversedCredits: 100,
        }),
        expect.objectContaining({
          sourceKind: "restoration",
          grantedCredits: 100,
          availableCredits: 100,
          reversedCredits: 0,
        }),
      ]),
    );
    expect(result.reversals).toHaveLength(1);
    expect(result.state).toMatchObject({
      refundableAvailableCredits: 100,
      allocatedCredits: 0,
      reversedCredits: 100,
      migrationWatermarkSequence: 3,
    });
    expect(result.lots.reduce((sum, lot) => sum + lot.grantedCredits, 0)).toBe(
      (result.state?.refundableAvailableCredits ?? 0) +
        (result.state?.allocatedCredits ?? 0) +
        (result.state?.reversedCredits ?? 0),
    );
  });

  it("compacts fragmented lots and preserves every root source", async () => {
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
      { refId: "settle:bounded", status: "applied" },
    ]);
    const counts = await t.run(async (ctx) => ({
      usage: (await ctx.db.query("usageEvents").collect()).length,
      earnings: (await ctx.db.query("publisherEarnings").collect()).length,
      ledger: (await ctx.db.query("walletEntries").collect()).length,
      roots: (await ctx.db.query("walletFundingLots").collect()).filter(
        (lot) => lot.sourceKind !== "compaction",
      ),
      lineage: await ctx.db.query("walletFundingLotComponents").collect(),
      allocations: await ctx.db.query("walletFundingAllocations").collect(),
    }));
    expect(counts.usage).toBe(1);
    expect(counts.earnings).toBe(1);
    expect(counts.ledger).toBe(18);
    expect(counts.roots).toHaveLength(17);
    expect(counts.lineage.length).toBeGreaterThan(0);
    expect(counts.allocations).toHaveLength(1);
    expect(
      counts.allocations.reduce((sum, row) => sum + row.grossCredits, 0),
    ).toBe(17);
  });

  it("reconciles a million-credit source through fixed eight-row journal chunks", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "million");
    const paymentId = await grantPayment(t, s, "million_payment", 1_000_000);
    const events = Array.from({ length: 50 }, (_, index) => ({
      ...usage(s, `settle:million:${index}`, 20_000),
      consumerClerkOrgId: "org_consumer_million",
    }));
    let pending = [...events];
    for (let attempt = 0; pending.length > 0 && attempt < 20; attempt += 1) {
      const batch = pending.slice(0, 25);
      const rest = pending.slice(25);
      const result = await t.mutation(internal.wallets.recordUsage, {
        events: batch,
      });
      const retry = new Set(
        result.results
          .filter((row) => row.status === "rejected" && row.retryable === true)
          .map((row) => row.refId),
      );
      pending = [
        ...rest,
        ...batch.filter((event) => retry.has(event.settleRefId)),
      ];
    }
    expect(pending).toHaveLength(0);
    await t.mutation(internal.billing.applyRefundProjection, {
      stripeRefundId: "re_million",
      stripeChargeId: "ch_million_payment",
      refundAmount: 1_000,
      totalRefundedAmount: 1_000,
      status: "succeeded",
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
    expect(processed).toEqual([
      160_000, 160_000, 160_000, 160_000, 160_000, 160_000, 40_000, 0,
    ]);
    const state = await t.run(async (ctx) => ({
      clawbacks: (await ctx.db.query("publisherClawbacks").collect()).length,
      job: await ctx.db
        .query("publisherReconciliationJobs")
        .withIndex("by_payment", (q) => q.eq("paymentId", paymentId))
        .unique(),
    }));
    expect(state.clawbacks).toBe(50);
    expect(state.job).toMatchObject({ status: "complete", processedChunks: 8 });
  });
});
