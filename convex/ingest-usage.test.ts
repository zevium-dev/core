/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { parseIngestUsageBody } from "./http";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SECRET = "test-gateway-internal-secret";

type SeededWallet = {
  consumerOrganizationId: Id<"organizations">;
  publisherOrganizationId: Id<"organizations">;
  projectId: Id<"projects">;
  specVersionId: Id<"specVersions">;
  paymentId: Id<"payments">;
};

async function seedWallet(t: TestConvex<typeof schema>): Promise<SeededWallet> {
  return await t.run(async (ctx) => {
    const consumerOrganizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_consumer",
      name: "Consumer",
      slug: "consumer",
    });
    const publisherOrganizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_publisher",
      name: "Publisher",
      slug: "publisher",
    });
    await ctx.db.insert("wallets", {
      organizationId: consumerOrganizationId,
      balance: 0,
      sequence: 0,
    });
    const intentId = await ctx.db.insert("checkoutIntents", {
      organizationId: consumerOrganizationId,
      packId: "pack_10",
      stripePriceId: "price_test",
      amount: 1000,
      currency: "usd",
      credits: 100,
      stripeCheckoutSessionId: "cs_test",
      stripePaymentIntentId: "pi_test",
      status: "complete",
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    });
    const paymentId = await ctx.db.insert("payments", {
      organizationId: consumerOrganizationId,
      checkoutIntentId: intentId,
      stripeCheckoutSessionId: "cs_test",
      stripePaymentIntentId: "pi_test",
      amount: 1000,
      currency: "usd",
      grantedCredits: 100,
      reversedCredits: 0,
      refundedAmount: 0,
      refundedCredits: 0,
      publisherClawbackTargetCredits: 0,
      status: "paid",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("organizationPayments", {
      organizationId: consumerOrganizationId,
      stripeCustomerId: "cus_test",
      detailsSubmitted: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      requirements: [],
      updatedAt: 1,
    });
    await ctx.db.insert("projects", {
      organizationId: publisherOrganizationId,
      name: "Publisher API",
      slug: "publisher-api",
      status: "published",
      visibility: "public",
      tags: [],
    });
    const project = await ctx.db
      .query("projects")
      .withIndex("by_org_slug", (q) =>
        q
          .eq("organizationId", publisherOrganizationId)
          .eq("slug", "publisher-api"),
      )
      .unique();
    if (project === null) throw new Error("Failed to seed project");
    const specVersionId = await ctx.db.insert("specVersions", {
      projectId: project._id,
      version: "1.0.0",
      spec: "{}",
      publishedAt: 1,
    });
    return {
      consumerOrganizationId,
      publisherOrganizationId,
      projectId: project._id,
      specVersionId,
      paymentId,
    };
  });
}

function usageEvent(seed: SeededWallet, refId: string, credits = 15) {
  return {
    organizationId: seed.publisherOrganizationId,
    projectId: seed.projectId,
    specVersionId: seed.specVersionId,
    endpoint: "/forecast",
    method: "GET",
    credits,
    status: 200,
    latencyMs: 10,
    keyId: "key_test",
    at: 10,
    settleRefId: refId,
    consumerClerkOrgId: "org_consumer",
    billingOutcome: credits === 0 ? ("free" as const) : ("settled" as const),
    qualityOutcome: "success" as const,
  };
}

describe("wallet settlement ingest contract", () => {
  const previousSecret = process.env.GATEWAY_INTERNAL_SECRET;

  beforeEach(() => {
    process.env.GATEWAY_INTERNAL_SECRET = SECRET;
  });
  afterEach(() => {
    if (previousSecret === undefined)
      delete process.env.GATEWAY_INTERNAL_SECRET;
    else process.env.GATEWAY_INTERNAL_SECRET = previousSecret;
  });

  it("requires one consumer organization in every parsed batch", () => {
    expect(parseIngestUsageBody({ events: [] }).ok).toBe(false);
    const base = {
      organizationId: "publisher",
      projectId: "project",
      specVersionId: "version",
      endpoint: "/x",
      method: "GET",
      credits: 1,
      status: 200,
      latencyMs: 1,
      keyId: "key",
      at: 1,
      settleRefId: "settle:one",
      billingOutcome: "settled",
      qualityOutcome: "success",
    };
    expect(parseIngestUsageBody({ events: [base] }).ok).toBe(false);
    expect(
      parseIngestUsageBody({
        events: [
          { ...base, consumerClerkOrgId: "org_one" },
          { ...base, settleRefId: "settle:two", consumerClerkOrgId: "org_two" },
        ],
      }).ok,
    ).toBe(false);
    expect(
      parseIngestUsageBody({
        events: Array.from({ length: 101 }, (_, index) => ({
          ...base,
          settleRefId: `settle:${index}`,
          consumerClerkOrgId: "org_one",
        })),
      }),
    ).toEqual({ ok: false, status: 400, error: "invalid event count" });
    expect(
      parseIngestUsageBody({
        events: [
          { ...base, consumerClerkOrgId: "org_one" },
          { ...base, consumerClerkOrgId: "org_one" },
        ],
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "duplicate settlement reference",
    });
  });

  it("returns applied, already_applied, rejected and an authoritative checkpoint", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWallet(t);
    await t.mutation(internal.wallets.grantPaymentCredits, {
      organizationId: seed.consumerOrganizationId,
      paymentId: seed.paymentId,
      amount: 100,
      refId: "stripe:payment_intent:pi_test",
    });
    const first = await t.fetch("/ingest-usage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": SECRET,
      },
      body: JSON.stringify({
        events: [
          usageEvent(seed, "settle:one"),
          usageEvent(seed, "settle:too-expensive", 200),
        ],
      }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      results: [
        { refId: "settle:one", status: "applied" },
        {
          refId: "settle:too-expensive",
          status: "rejected",
          reason: "insufficient authoritative balance",
          retryable: true,
        },
      ],
      wallet: { clerkOrgId: "org_consumer", balance: 85, sequence: 2 },
    });
    const duplicate = await t.fetch("/ingest-usage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": SECRET,
      },
      body: JSON.stringify({ events: [usageEvent(seed, "settle:one")] }),
    });
    expect(await duplicate.json()).toEqual({
      results: [{ refId: "settle:one", status: "already_applied" }],
      wallet: { clerkOrgId: "org_consumer", balance: 85, sequence: 2 },
    });
    const durableEvidence = await t.run(async (ctx) => ({
      usage: await ctx.db
        .query("usageEvents")
        .withIndex("by_org_project_settlement", (q) =>
          q
            .eq("organizationId", seed.consumerOrganizationId)
            .eq("projectId", seed.projectId)
            .eq("settleRefId", "settle:one"),
        )
        .unique(),
      quality: await ctx.db
        .query("gatewayQualitySamples")
        .withIndex("by_ref", (q) => q.eq("refId", "settle:one"))
        .unique(),
    }));
    expect(durableEvidence.usage).toMatchObject({
      specVersionId: seed.specVersionId,
      billingOutcome: "settled",
      qualityOutcome: "success",
    });
    expect(durableEvidence.quality).toMatchObject({
      projectId: seed.projectId,
      specVersionId: seed.specVersionId,
      refId: "settle:one",
      outcome: "success",
    });

    const alteredReplay = await t.fetch("/ingest-usage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": SECRET,
      },
      body: JSON.stringify({
        events: [{ ...usageEvent(seed, "settle:one"), credits: 16 }],
      }),
    });
    expect(await alteredReplay.json()).toEqual({
      results: [
        {
          refId: "settle:one",
          status: "rejected",
          reason: "settlement reference payload conflict",
          retryable: false,
        },
      ],
      wallet: { clerkOrgId: "org_consumer", balance: 85, sequence: 2 },
    });
  });

  it("rejects impossible telemetry and a publisher/project ownership mismatch", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWallet(t);
    await t.mutation(internal.wallets.grantPaymentCredits, {
      organizationId: seed.consumerOrganizationId,
      paymentId: seed.paymentId,
      amount: 100,
      refId: "grant:boundaries",
    });

    const result = await t.mutation(internal.wallets.recordUsage, {
      events: [
        { ...usageEvent(seed, "settle:bad-status"), status: 700 },
        {
          ...usageEvent(seed, "settle:bad-latency"),
          latencyMs: 86_400_001,
        },
        {
          ...usageEvent(seed, "settle:forged-outcome"),
          status: 503,
          qualityOutcome: "success",
        },
        {
          ...usageEvent(seed, "settle:wrong-publisher"),
          organizationId: seed.consumerOrganizationId,
        },
      ],
    });

    expect(result.results).toEqual([
      {
        refId: "settle:bad-status",
        status: "rejected",
        reason: "invalid settlement",
        retryable: false,
      },
      {
        refId: "settle:bad-latency",
        status: "rejected",
        reason: "invalid settlement",
        retryable: false,
      },
      {
        refId: "settle:forged-outcome",
        status: "rejected",
        reason: "invalid settlement",
        retryable: false,
      },
      {
        refId: "settle:wrong-publisher",
        status: "rejected",
        reason: "settlement publisher does not own project",
        retryable: false,
      },
    ]);
    expect(result.wallet).toMatchObject({ balance: 100, sequence: 1 });
  });

  it("freezes new consumers at deprecation while backfilling historical eligibility", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWallet(t);
    await t.mutation(internal.wallets.grantPaymentCredits, {
      organizationId: seed.consumerOrganizationId,
      paymentId: seed.paymentId,
      amount: 100,
      refId: "grant:retirement-freeze",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(seed.projectId, {
        deprecationStartedAt: 20,
        sunsetAt: 20 + 7 * 24 * 60 * 60 * 1000,
        retirementState: "scheduled",
      });
    });

    const blocked = await t.mutation(internal.wallets.recordUsage, {
      events: [{ ...usageEvent(seed, "settle:new-after-freeze"), at: 20 }],
    });
    expect(blocked.results).toEqual([
      {
        refId: "settle:new-after-freeze",
        status: "rejected",
        reason: "consumer became eligible after retirement freeze",
        retryable: false,
      },
    ]);

    await t.run(async (ctx) => {
      await ctx.db.insert("usageEvents", {
        organizationId: seed.consumerOrganizationId,
        projectId: seed.projectId,
        endpoint: "/forecast",
        method: "GET",
        credits: 1,
        status: 200,
        latencyMs: 1,
        keyId: "legacy-key",
        at: 19,
      });
    });
    const grandfathered = await t.mutation(internal.wallets.recordUsage, {
      events: [{ ...usageEvent(seed, "settle:historical-consumer"), at: 21 }],
    });
    expect(grandfathered.results).toEqual([
      { refId: "settle:historical-consumer", status: "applied" },
    ]);
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("projectConsumerEntitlements")
          .withIndex("by_project_consumer", (q) =>
            q
              .eq("projectId", seed.projectId)
              .eq("consumerOrganizationId", seed.consumerOrganizationId),
          )
          .unique(),
      ),
    ).toMatchObject({ firstUsedAt: 19 });
  });

  it("keeps materialized balance and sequence equal to the append-only ledger", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWallet(t);
    await t.mutation(internal.wallets.grantPaymentCredits, {
      organizationId: seed.consumerOrganizationId,
      paymentId: seed.paymentId,
      amount: 100,
      refId: "stripe:payment_intent:pi_test",
    });
    await t.mutation(internal.wallets.recordUsage, {
      events: [usageEvent(seed, "settle:one", 20)],
    });
    const invariant = await t.run(async (ctx) => {
      const wallet = await ctx.db
        .query("wallets")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.consumerOrganizationId),
        )
        .unique();
      if (wallet === null) throw new Error("wallet missing");
      const entries = await ctx.db
        .query("walletEntries")
        .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id))
        .collect();
      return {
        balance: wallet.balance,
        sequence: wallet.sequence,
        ledgerBalance: entries.reduce((sum, entry) => sum + entry.amount, 0),
        entries: entries.length,
      };
    });
    expect(invariant).toEqual({
      balance: 80,
      sequence: 2,
      ledgerBalance: 80,
      entries: 2,
    });
  });
});
