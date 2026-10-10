/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { fundingExpiresAt, machineWalletId } from "@zevium/shared";
import { parseIngestUsageBody } from "./http";
const modules = import.meta.glob("./**/*.ts");
const payer = "0x" + "a".repeat(40);
const network = "eip155:8453";
const walletId = machineWalletId(network, payer);
const payment = (n: number) => ({
  paymentId: `pi_test${n}`,
  transaction: "0x" + String(n).repeat(64),
  payer,
  network,
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      name: "Publisher",
      slug: "pub",
      clerkOrgId: "org_publisher",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: "API",
      slug: "api",
      status: "published",
      visibility: "public",
      tags: [],
    });
    const specVersionId = await ctx.db.insert("specVersions", {
      projectId,
      version: "1",
      spec: "{}",
      publishedAt: 1,
    });
    return { organizationId, projectId, specVersionId };
  });
  const usage = (
    ref: string,
    sourceRef: string,
    admittedAt: number,
    credits = 1000,
  ) => ({
    ...ids,
    specVersion: "1",
    operationId: "GET /echo",
    endpoint: "/echo",
    method: "GET",
    listedCostCredits: credits,
    pricingDecision: "listed_price" as const,
    credits,
    billingOutcome: "settled" as const,
    qualityOutcome: "success" as const,
    status: 200,
    latencyMs: 2,
    keyId: walletId,
    keyFamilyId: walletId,
    budgetPeriod: "2026-10",
    budgetUsedBefore: 0,
    budgetReservedBefore: 0,
    budgetReservationCredits: credits,
    at: Date.now(),
    reservationId: ref,
    settleRefId: `settle:${ref}`,
    consumerClerkOrgId: walletId,
    machineFunding: { admittedAt, lots: [{ sourceRef, credits }] },
  });
  return { t, usage };
}

describe("anonymous wallet ledger", () => {
  it("requires the gateway secret on the HTTP funding boundary", async () => {
    const { t } = await fixture();
    vi.stubEnv("GATEWAY_INTERNAL_SECRET", "fixture-internal-secret");
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payment(1)),
    };
    expect((await t.fetch("/machine-fund", request)).status).toBe(401);
    const good = await t.fetch("/machine-fund", {
      ...request,
      headers: {
        ...request.headers,
        "x-internal-secret": "fixture-internal-secret",
      },
    });
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ applied: true, credits: 10_000 });
  });
  it("funds exactly once per Stripe payment and transaction, without signup credit or Clerk membership", async () => {
    const { t } = await fixture();
    const grant = await t.mutation(internal.machinePayments.fund, payment(1));
    expect(grant).toMatchObject({ walletId, credits: 10_000, applied: true });
    expect(grant.expiresAt).toBe(fundingExpiresAt(grant.createdAt));
    expect(
      await t.mutation(internal.machinePayments.fund, payment(1)),
    ).toMatchObject({ ...grant, applied: false });
    await expect(
      t.mutation(internal.machinePayments.fund, {
        ...payment(1),
        paymentId: "pi_different",
      }),
    ).rejects.toThrow("Transaction already funded");
    await expect(
      t.mutation(internal.machinePayments.fund, {
        ...payment(1),
        payer: "0x" + "b".repeat(40),
      }),
    ).rejects.toThrow("Payment replay changed identity");
    const state = await t.run(async (ctx) => ({
      wallets: await ctx.db.query("wallets").collect(),
      lots: await ctx.db.query("walletFundingLots").collect(),
      entries: await ctx.db.query("walletEntries").collect(),
      promotions: await ctx.db.query("signupCreditGrants").collect(),
    }));
    expect(state.wallets).toHaveLength(1);
    expect(state.wallets[0]?.balance).toBe(10_000);
    expect(state.lots).toHaveLength(1);
    expect(state.entries).toHaveLength(1);
    expect(state.promotions).toHaveLength(0);
  });
  it("preserves 95/5 earnings and exact lot attribution across out-of-order delivery and expiry", async () => {
    const { t, usage } = await fixture();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const first = await t.mutation(internal.machinePayments.fund, payment(1));
    clock.mockReturnValue(now + 1000);
    const second = await t.mutation(internal.machinePayments.fund, payment(2));
    clock.mockReturnValue(first.expiresAt + 100);
    const later = usage("later", second.sourceRef, second.createdAt, 2000);
    const earlier = usage(
      "earlier",
      first.sourceRef,
      first.expiresAt - 1,
      1000,
    );
    const lateResult = await t.mutation(internal.wallets.recordUsage, {
      events: [later],
    });
    expect(lateResult.results).toMatchObject([{ status: "applied" }]);
    expect(
      (await t.mutation(internal.wallets.recordUsage, { events: [earlier] }))
        .results,
    ).toMatchObject([{ status: "applied" }]);
    expect(
      (await t.mutation(internal.wallets.recordUsage, { events: [earlier] }))
        .results,
    ).toMatchObject([{ status: "already_applied" }]);
    const changed = {
      ...earlier,
      machineFunding: {
        ...earlier.machineFunding,
        lots: [{ sourceRef: second.sourceRef, credits: 1000 }],
      },
    };
    expect(
      (await t.mutation(internal.wallets.recordUsage, { events: [changed] }))
        .results,
    ).toMatchObject([{ status: "rejected", retryable: false }]);
    const expired = usage("expired", first.sourceRef, first.expiresAt);
    expect(
      (await t.mutation(internal.wallets.recordUsage, { events: [expired] }))
        .results,
    ).toMatchObject([{ status: "rejected", retryable: false }]);
    const state = await t.run(async (ctx) => ({
      lots: await ctx.db.query("walletFundingLots").collect(),
      earnings: await ctx.db.query("publisherEarnings").collect(),
      entries: await ctx.db.query("walletEntries").collect(),
    }));
    expect(state.lots.map((l) => l.availableCredits)).toEqual([9000, 8000]);
    expect(state.lots.every((l) => l.sourceKind === "machine_payment")).toBe(
      true,
    );
    expect(state.earnings.reduce((sum, e) => sum + e.netCredits, 0)).toBe(2850);
    expect(
      state.earnings.reduce((sum, e) => sum + e.platformFeeCredits, 0),
    ).toBe(150);
    expect(state.entries.map((e) => e.amount)).toEqual([
      10_000, 10_000, -2000, -1000,
    ]);
  });
  it("rejects missing, foreign and overspent allocations; validates the HTTP ingest boundary", async () => {
    const { t, usage } = await fixture();
    const grant = await t.mutation(internal.machinePayments.fund, payment(1));
    const good = usage("ok", grant.sourceRef, grant.createdAt);
    expect(parseIngestUsageBody({ events: [good] })).toMatchObject({
      ok: true,
      events: [{ machineFunding: good.machineFunding }],
    });
    expect(
      parseIngestUsageBody({
        events: [
          {
            ...good,
            machineFunding: {
              admittedAt: grant.createdAt,
              lots: [{ sourceRef: grant.sourceRef, credits: -1 }],
            },
          },
        ],
      }),
    ).toMatchObject({ ok: false });
    for (const event of [
      { ...good, machineFunding: undefined },
      {
        ...good,
        machineFunding: {
          admittedAt: grant.createdAt,
          lots: [{ sourceRef: "x402:pi_unknown", credits: 1000 }],
        },
      },
      usage("over", grant.sourceRef, grant.createdAt, 11_000),
    ]) {
      expect(
        (await t.mutation(internal.wallets.recordUsage, { events: [event] }))
          .results,
      ).toMatchObject([{ status: "rejected", retryable: false }]);
    }
    expect(
      (await t.mutation(internal.wallets.recordUsage, { events: [good] }))
        .results,
    ).toMatchObject([{ status: "applied" }]);
  });
});
