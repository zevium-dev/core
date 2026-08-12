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
      refundedAmount: 0,
      refundedCredits: 0,
      reversedCredits: 0,
      walletReversedCredits: 0,
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
    return {
      consumerOrganizationId,
      publisherOrganizationId,
      projectId: project._id,
      paymentId,
    };
  });
}

function usageEvent(seed: SeededWallet, refId: string, credits = 15) {
  return {
    organizationId: seed.publisherOrganizationId,
    projectId: seed.projectId,
    endpoint: "/forecast",
    method: "GET",
    credits,
    status: 200,
    latencyMs: 10,
    keyId: "key_test",
    at: 10,
    settleRefId: refId,
    consumerClerkOrgId: "org_consumer",
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
      endpoint: "/x",
      method: "GET",
      credits: 1,
      status: 200,
      latencyMs: 1,
      keyId: "key",
      at: 1,
      settleRefId: "settle:one",
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
          reason:
            "insufficient balance without authoritative reservation proof",
          retryable: false,
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
