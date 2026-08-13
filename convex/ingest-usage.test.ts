/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  parseIngestUsageBody,
  parseReleaseProbeBody,
  releaseProbeSecretMatches,
} from "./http";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SECRET = "test-gateway-internal-secret";
const RELEASE_SECRET = "release-probe-" + "p".repeat(32);
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_REQUEST_ID = "223e4567-e89b-42d3-a456-426614174000";
const CHALLENGE = "c".repeat(64);
const SECOND_CHALLENGE = "d".repeat(64);
const RELEASE = "a".repeat(40);

type SeededWallet = {
  consumerOrganizationId: Id<"organizations">;
  otherOrganizationId: Id<"organizations">;
  publisherOrganizationId: Id<"organizations">;
  consumerWalletId: Id<"wallets">;
  otherWalletId: Id<"wallets">;
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
    const otherOrganizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_other",
      name: "Other",
      slug: "other",
    });
    const publisherOrganizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_publisher",
      name: "Publisher",
      slug: "publisher",
    });
    const consumerWalletId = await ctx.db.insert("wallets", {
      organizationId: consumerOrganizationId,
      balance: 0,
      sequence: 0,
    });
    const otherWalletId = await ctx.db.insert("wallets", {
      organizationId: otherOrganizationId,
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
      walletReversedCredits: 0,
      publisherClawbackTargetCredits: 0,
      reversalSequence: 0,
      financeMigrationStatus: "verified",
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
      spec: JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Publisher API", version: "1.0.0" },
        paths: {
          "/forecast": {
            get: { operationId: "getForecast", "x-zevium-cost": 15 },
          },
        },
      }),
      publishedAt: 1,
    });
    return {
      consumerOrganizationId,
      otherOrganizationId,
      publisherOrganizationId,
      consumerWalletId,
      otherWalletId,
      projectId: project._id,
      specVersionId,
      paymentId,
    };
  });
}

function usageEvent(
  seed: SeededWallet,
  refId: string,
  credits = 15,
  extras: {
    at?: number;
    releaseChallenge?: string;
    gatewayRelease?: string;
  } = {},
) {
  return {
    organizationId: seed.publisherOrganizationId,
    projectId: seed.projectId,
    specVersionId: seed.specVersionId,
    specVersion: "1.0.0",
    operationId: "getForecast",
    endpoint: "/forecast",
    method: "GET",
    listedCostCredits: credits,
    pricingDecision: "listed_price" as const,
    credits,
    status: 200,
    latencyMs: 10,
    keyId: "key_test",
    keyFamilyId: "key_family_test",
    budgetPeriod: "2026-08",
    budgetUsedBefore: 0,
    budgetReservedBefore: 0,
    budgetReservationCredits: credits,
    at: extras.at ?? 10,
    reservationId: refId.replace(/^settle:/, ""),
    settleRefId: refId,
    consumerClerkOrgId: "org_consumer",
    billingOutcome: credits === 0 ? ("free" as const) : ("settled" as const),
    qualityOutcome: "success" as const,
    ...(extras.releaseChallenge === undefined
      ? {}
      : { releaseChallenge: extras.releaseChallenge }),
    ...(extras.gatewayRelease === undefined
      ? {}
      : { gatewayRelease: extras.gatewayRelease }),
  };
}

function probeBody(
  requestId = REQUEST_ID,
  challenge = CHALLENGE,
  notBefore = Date.now() - 1_000,
) {
  return {
    requestId,
    challenge,
    notBefore,
    expectedGatewayRelease: RELEASE,
  };
}

async function claim(
  t: TestConvex<typeof schema>,
  body: ReturnType<typeof probeBody>,
  now = Date.now(),
) {
  return await t.mutation(internal.wallets.claimReleaseProbeAccounting, {
    ...body,
    now,
  });
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
      specVersion: "1.0.0",
      operationId: "getX",
      endpoint: "/x",
      method: "GET",
      listedCostCredits: 1,
      pricingDecision: "listed_price",
      credits: 1,
      status: 200,
      latencyMs: 1,
      keyId: "key",
      keyFamilyId: "key_family",
      budgetPeriod: "2026-08",
      budgetUsedBefore: 0,
      budgetReservedBefore: 0,
      budgetReservationCredits: 1,
      at: 1,
      reservationId: "one",
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
          reason: "reservation checkpoint is stale after ledger debit",
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
        events: [{ ...usageEvent(seed, "settle:one"), latencyMs: 11 }],
      }),
    });
    expect(await alteredReplay.json()).toEqual({
      results: [
        {
          refId: "settle:one",
          status: "rejected",
          reason: "settlement replay changed immutable payload or linkage",
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
      refId: "stripe:payment_intent:pi_test",
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
        reason: "publisher organization does not own project",
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
      refId: "stripe:payment_intent:pi_test",
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

describe("one-time release proof", () => {
  const previousReleaseSecret = process.env.RELEASE_PROBE_SECRET;

  beforeEach(() => {
    process.env.RELEASE_PROBE_SECRET = RELEASE_SECRET;
  });
  afterEach(() => {
    if (previousReleaseSecret === undefined)
      delete process.env.RELEASE_PROBE_SECRET;
    else process.env.RELEASE_PROBE_SECRET = previousReleaseSecret;
  });

  function probeEvent(
    seed: SeededWallet,
    requestId: string,
    challenge: string,
    at: number,
  ) {
    return usageEvent(seed, `settle:${requestId}`, 15, {
      at,
      releaseChallenge: challenge,
      gatewayRelease: RELEASE,
    });
  }

  async function grant(t: TestConvex<typeof schema>, seed: SeededWallet) {
    await t.mutation(internal.wallets.grantPaymentCredits, {
      organizationId: seed.consumerOrganizationId,
      paymentId: seed.paymentId,
      amount: 100,
      refId: "stripe:payment_intent:pi_test",
    });
  }

  it("accepts exact bounded request shape and fixed-digest credential", async () => {
    const body = probeBody();
    expect(parseReleaseProbeBody(body)).toEqual({ ok: true, ...body });
    expect(parseReleaseProbeBody({ ...body, extra: true }).ok).toBe(false);
    expect(parseReleaseProbeBody({ ...body, challenge: "short" }).ok).toBe(
      false,
    );
    expect(
      await releaseProbeSecretMatches(RELEASE_SECRET, RELEASE_SECRET),
    ).toBe(true);
    expect(
      await releaseProbeSecretMatches(RELEASE_SECRET, `${RELEASE_SECRET}x`),
    ).toBe(false);
    expect(await releaseProbeSecretMatches("short", "short")).toBe(false);
  });

  it("rejects half-present release metadata at ingest boundary", () => {
    const base = {
      organizationId: "publisher",
      projectId: "project",
      specVersionId: "version",
      specVersion: "1.0.0",
      operationId: "getX",
      endpoint: "/x",
      method: "GET",
      listedCostCredits: 1,
      pricingDecision: "listed_price",
      credits: 1,
      status: 200,
      latencyMs: 1,
      keyId: "key",
      keyFamilyId: "key_family",
      budgetPeriod: "2026-08",
      budgetUsedBefore: 0,
      budgetReservedBefore: 0,
      budgetReservationCredits: 1,
      at: 1,
      reservationId: "one",
      settleRefId: "settle:one",
      consumerClerkOrgId: "org_one",
      billingOutcome: "settled",
      qualityOutcome: "success",
    };
    expect(
      parseIngestUsageBody({
        events: [{ ...base, releaseChallenge: CHALLENGE }],
      }).ok,
    ).toBe(false);
    expect(
      parseIngestUsageBody({
        events: [
          { ...base, releaseChallenge: CHALLENGE, gatewayRelease: "bad" },
        ],
      }).ok,
    ).toBe(false);
  });

  it("moves pending to one minimal settled proof and replays the exact result", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWallet(t);
    await grant(t, seed);
    const started = Date.now() - 100;
    const body = probeBody(REQUEST_ID, CHALLENGE, started);

    const pending = await t.fetch("/release-probe-accounting", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-release-probe-secret": RELEASE_SECRET,
      },
      body: JSON.stringify(body),
    });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ status: "pending" });

    await t.mutation(internal.wallets.recordUsage, {
      events: [probeEvent(seed, REQUEST_ID, CHALLENGE, started + 10)],
    });
    const settled = await t.fetch("/release-probe-accounting", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-release-probe-secret": RELEASE_SECRET,
      },
      body: JSON.stringify(body),
    });
    expect(settled.status).toBe(200);
    expect(await settled.json()).toEqual({
      status: "settled",
      requestId: REQUEST_ID,
      challenge: CHALLENGE,
      credits: 15,
      platformFeeCredits: 0.75,
      publisherNetCredits: 14.25,
    });

    const replay = await t.fetch("/release-probe-accounting", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-release-probe-secret": RELEASE_SECRET,
      },
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      status: "settled",
      requestId: REQUEST_ID,
      challenge: CHALLENGE,
      credits: 15,
      platformFeeCredits: 0.75,
      publisherNetCredits: 14.25,
    });

    const mismatchedReplay = await t.fetch("/release-probe-accounting", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-release-probe-secret": RELEASE_SECRET,
      },
      body: JSON.stringify({ ...body, notBefore: body.notBefore + 1 }),
    });
    expect(mismatchedReplay.status).toBe(409);
    expect(await mismatchedReplay.json()).toEqual({
      error: "release probe rejected",
    });
  });

  it("rejects stale usage even when request id and challenge match", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWallet(t);
    await grant(t, seed);
    const now = Date.now();
    await t.mutation(internal.wallets.recordUsage, {
      events: [probeEvent(seed, REQUEST_ID, CHALLENGE, now - 10 * 60_000)],
    });
    await expect(
      claim(t, probeBody(REQUEST_ID, CHALLENGE, now - 11 * 60_000), now),
    ).rejects.toThrow(/usage linkage is invalid/);
  });

  it("rejects cross-wallet ledger linkage", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWallet(t);
    await grant(t, seed);
    const now = Date.now();
    await t.mutation(internal.wallets.recordUsage, {
      events: [probeEvent(seed, REQUEST_ID, CHALLENGE, now)],
    });
    await t.run(async (ctx) => {
      const ledger = await ctx.db
        .query("walletEntries")
        .withIndex("by_ref", (q) => q.eq("refId", `settle:${REQUEST_ID}`))
        .unique();
      if (ledger === null) throw new Error("ledger missing");
      await ctx.db.patch(ledger._id, { walletId: seed.otherWalletId });
    });
    await expect(
      claim(t, probeBody(REQUEST_ID, CHALLENGE, now - 1), now + 1),
    ).rejects.toThrow(/consumer wallet linkage is invalid/);
  });

  it("rejects duplicate settlement references instead of choosing a row", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWallet(t);
    await grant(t, seed);
    const now = Date.now();
    await t.mutation(internal.wallets.recordUsage, {
      events: [probeEvent(seed, REQUEST_ID, CHALLENGE, now)],
    });
    await t.run(async (ctx) => {
      const original = await ctx.db
        .query("walletEntries")
        .withIndex("by_ref", (q) => q.eq("refId", `settle:${REQUEST_ID}`))
        .unique();
      if (original === null) throw new Error("ledger missing");
      await ctx.db.insert("walletEntries", {
        walletId: original.walletId,
        kind: original.kind,
        amount: original.amount,
        refId: original.refId,
        sequence: original.sequence,
        balanceAfter: original.balanceAfter,
        usageEventId: original.usageEventId,
        createdAt: original.createdAt,
      });
    });
    await expect(
      claim(t, probeBody(REQUEST_ID, CHALLENGE, now - 1), now + 1),
    ).rejects.toThrow(/more than one result/);
  });

  it("rejects materialized wallet checkpoint drift", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWallet(t);
    await grant(t, seed);
    const now = Date.now();
    await t.mutation(internal.wallets.recordUsage, {
      events: [probeEvent(seed, REQUEST_ID, CHALLENGE, now)],
    });
    await t.run(async (ctx) => {
      const wallet = await ctx.db.get(seed.consumerWalletId);
      if (wallet === null) throw new Error("wallet missing");
      await ctx.db.patch(wallet._id, { balance: wallet.balance + 1 });
    });
    await expect(
      claim(t, probeBody(REQUEST_ID, CHALLENGE, now - 1), now + 1),
    ).rejects.toThrow(/wallet checkpoint is invalid/);
  });

  it("rejects same challenge on a second request after first claim", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWallet(t);
    await grant(t, seed);
    const now = Date.now();
    await t.mutation(internal.wallets.recordUsage, {
      events: [
        probeEvent(seed, REQUEST_ID, CHALLENGE, now),
        probeEvent(seed, SECOND_REQUEST_ID, CHALLENGE, now + 1),
      ],
    });
    await expect(
      claim(t, probeBody(REQUEST_ID, CHALLENGE, now - 1), now + 2),
    ).resolves.toMatchObject({ requestId: REQUEST_ID, challenge: CHALLENGE });
    await expect(
      claim(t, probeBody(SECOND_REQUEST_ID, CHALLENGE, now - 1), now + 3),
    ).rejects.toThrow(/already claimed/);
  });

  it("enforces auth header, media type, and body size without secret leakage", async () => {
    const t = convexTest(schema, modules);
    const unauthorized = await t.fetch("/release-probe-accounting", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-release-probe-secret": "x".repeat(40),
      },
      body: JSON.stringify(probeBody()),
    });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.text()).not.toContain(RELEASE_SECRET);

    const wrongType = await t.fetch("/release-probe-accounting", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "x-release-probe-secret": RELEASE_SECRET,
      },
      body: JSON.stringify(probeBody()),
    });
    expect(wrongType.status).toBe(415);

    const oversized = await t.fetch("/release-probe-accounting", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-release-probe-secret": RELEASE_SECRET,
      },
      body: JSON.stringify({ ...probeBody(), padding: "x".repeat(2_000) }),
    });
    expect(oversized.status).toBe(413);
  });

  it("keeps independent challenges independent", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWallet(t);
    await grant(t, seed);
    const now = Date.now();
    await t.mutation(internal.wallets.recordUsage, {
      events: [
        probeEvent(seed, REQUEST_ID, CHALLENGE, now),
        probeEvent(seed, SECOND_REQUEST_ID, SECOND_CHALLENGE, now + 1),
      ],
    });
    await expect(
      claim(t, probeBody(REQUEST_ID, CHALLENGE, now - 1), now + 2),
    ).resolves.toMatchObject({ requestId: REQUEST_ID });
    await expect(
      claim(
        t,
        probeBody(SECOND_REQUEST_ID, SECOND_CHALLENGE, now - 1),
        now + 3,
      ),
    ).resolves.toMatchObject({ requestId: SECOND_REQUEST_ID });
  });
});
