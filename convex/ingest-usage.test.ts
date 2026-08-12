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
const INGEST_SECRET = "gateway-internal-" + "g".repeat(32);
const RELEASE_SECRET = "release-probe-" + "p".repeat(32);
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_REQUEST_ID = "223e4567-e89b-42d3-a456-426614174000";
const CHALLENGE = "c".repeat(64);
const SECOND_CHALLENGE = "d".repeat(64);
const RELEASE = "a".repeat(40);

type Seed = {
  consumerOrganizationId: Id<"organizations">;
  otherOrganizationId: Id<"organizations">;
  publisherOrganizationId: Id<"organizations">;
  consumerWalletId: Id<"wallets">;
  otherWalletId: Id<"wallets">;
  projectId: Id<"projects">;
  paymentId: Id<"payments">;
};

async function seedWallet(t: TestConvex<typeof schema>): Promise<Seed> {
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
      status: "paid",
      createdAt: 1,
      updatedAt: 1,
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: publisherOrganizationId,
      name: "Publisher API",
      slug: "publisher-api",
      status: "published",
      visibility: "public",
      tags: [],
    });
    return {
      consumerOrganizationId,
      otherOrganizationId,
      publisherOrganizationId,
      consumerWalletId,
      otherWalletId,
      projectId,
      paymentId,
    };
  });
}

function usageEvent(
  seed: Seed,
  requestId: string,
  challenge: string,
  at: number,
  credits = 15,
) {
  return {
    organizationId: seed.publisherOrganizationId,
    projectId: seed.projectId,
    endpoint: "/forecast",
    method: "GET",
    credits,
    status: 200,
    latencyMs: 10,
    keyId: "key_test",
    at,
    settleRefId: `settle:${requestId}`,
    consumerClerkOrgId: "org_consumer",
    releaseChallenge: challenge,
    gatewayRelease: RELEASE,
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

async function grant(t: TestConvex<typeof schema>, seed: Seed) {
  await t.mutation(internal.wallets.grantPaymentCredits, {
    organizationId: seed.consumerOrganizationId,
    paymentId: seed.paymentId,
    amount: 100,
    refId: "stripe:payment_intent:pi_test",
  });
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

describe("wallet settlement and one-time release proof", () => {
  const previousIngestSecret = process.env.GATEWAY_INTERNAL_SECRET;
  const previousReleaseSecret = process.env.RELEASE_PROBE_SECRET;

  beforeEach(() => {
    process.env.GATEWAY_INTERNAL_SECRET = INGEST_SECRET;
    process.env.RELEASE_PROBE_SECRET = RELEASE_SECRET;
  });

  afterEach(() => {
    if (previousIngestSecret === undefined)
      delete process.env.GATEWAY_INTERNAL_SECRET;
    else process.env.GATEWAY_INTERNAL_SECRET = previousIngestSecret;
    if (previousReleaseSecret === undefined)
      delete process.env.RELEASE_PROBE_SECRET;
    else process.env.RELEASE_PROBE_SECRET = previousReleaseSecret;
  });

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

  it("rejects mixed consumers and half-present release metadata at ingest boundary", () => {
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
      consumerClerkOrgId: "org_one",
    };
    expect(
      parseIngestUsageBody({
        events: [
          base,
          { ...base, settleRefId: "settle:two", consumerClerkOrgId: "org_two" },
        ],
      }).ok,
    ).toBe(false);
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

  it("moves pending to one minimal settled proof and rejects replay", async () => {
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
      events: [usageEvent(seed, REQUEST_ID, CHALLENGE, started + 10)],
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
      platformFeeCredits: 0,
      publisherNetCredits: 15,
    });

    const replay = await t.fetch("/release-probe-accounting", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-release-probe-secret": RELEASE_SECRET,
      },
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: "release probe rejected" });
  });

  it("deduplicates settlement without duplicate usage, ledger, or earning", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWallet(t);
    await grant(t, seed);
    const event = usageEvent(seed, REQUEST_ID, CHALLENGE, Date.now());
    const first = await t.mutation(internal.wallets.recordUsage, {
      events: [event],
    });
    const second = await t.mutation(internal.wallets.recordUsage, {
      events: [event],
    });
    expect(first.results).toEqual([
      { refId: `settle:${REQUEST_ID}`, status: "applied" },
    ]);
    expect(second.results).toEqual([
      { refId: `settle:${REQUEST_ID}`, status: "already_applied" },
    ]);
    const counts = await t.run(async (ctx) => ({
      usage: (await ctx.db.query("usageEvents").collect()).length,
      settlements: (await ctx.db.query("walletEntries").collect()).filter(
        (entry) => entry.kind === "usage_settlement",
      ).length,
      earnings: (await ctx.db.query("publisherEarnings").collect()).length,
    }));
    expect(counts).toEqual({ usage: 1, settlements: 1, earnings: 1 });
  });

  it("rejects stale usage even when request id and challenge match", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWallet(t);
    await grant(t, seed);
    const now = Date.now();
    await t.mutation(internal.wallets.recordUsage, {
      events: [usageEvent(seed, REQUEST_ID, CHALLENGE, now - 10 * 60_000)],
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
      events: [usageEvent(seed, REQUEST_ID, CHALLENGE, now)],
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
      events: [usageEvent(seed, REQUEST_ID, CHALLENGE, now)],
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
      events: [usageEvent(seed, REQUEST_ID, CHALLENGE, now)],
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
        usageEvent(seed, REQUEST_ID, CHALLENGE, now),
        usageEvent(seed, SECOND_REQUEST_ID, CHALLENGE, now + 1),
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
        usageEvent(seed, REQUEST_ID, CHALLENGE, now),
        usageEvent(seed, SECOND_REQUEST_ID, SECOND_CHALLENGE, now + 1),
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
