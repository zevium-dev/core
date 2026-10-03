/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { legacySettlementFacts } from "./lib/legacySettlement";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const consumer = await ctx.db.insert("organizations", {
      clerkOrgId: "org_v1_consumer",
      name: "Consumer",
      slug: "consumer",
    });
    const publisher = await ctx.db.insert("organizations", {
      clerkOrgId: "org_v1_publisher",
      name: "Publisher",
      slug: "publisher",
    });
    const project = await ctx.db.insert("projects", {
      organizationId: publisher,
      name: "Original API",
      slug: "original-api",
      status: "published",
      visibility: "public",
      tags: [],
    });
    const wallet = await ctx.db.insert("wallets", {
      organizationId: consumer,
      balance: 980,
      sequence: 3,
    });
    await ctx.db.insert("walletEntries", {
      walletId: wallet,
      kind: "admin_adjustment",
      amount: 1000,
      refId: "promo:v1",
      sequence: 1,
      createdAt: 1,
    });
    const settlements = [];
    for (const [index, credits] of [20, 0].entries()) {
      const ref = `settle:v1-${index}`;
      const usage = await ctx.db.insert("usageEvents", {
        organizationId: consumer,
        projectId: project,
        endpoint: "/",
        method: "POST",
        credits,
        status: 200,
        latencyMs: 10,
        keyId: "original-key",
        at: index + 2,
        settleRefId: ref,
      });
      const entry = await ctx.db.insert("walletEntries", {
        walletId: wallet,
        kind: "usage_settlement",
        amount: -credits,
        refId: ref,
        usageEventId: usage,
        sequence: index + 2,
        createdAt: index + 6,
      });
      const earning = await ctx.db.insert("publisherEarnings", {
        publisherOrganizationId: publisher,
        projectId: project,
        usageSettlementRefId: ref,
        grossCredits: credits,
        platformFeeCredits: credits / 20,
        netCredits: credits * 0.95,
        availableAt: 1,
        status: "available",
        createdAt: index + 6,
        updatedAt: index + 6,
      });
      settlements.push({ usage, entry, earning, ref });
    }
    return { consumer, publisher, project, wallet, settlements };
  });
  return { t, ids };
}

describe("original settlement financial recovery", () => {
  it("verifies paid and free legacy history without inventing v2 metadata or changing money", async () => {
    const { t, ids } = await seed();
    const jobId = await t.mutation(internal.financeMigration.startOperator, {});
    for (let i = 0; i < 250; i++) {
      const job = await t.run((ctx) => ctx.db.get(jobId));
      if (job?.status === "verified") break;
      if (job?.status === "failed") throw new Error(job.lastError);
      await t.mutation(internal.financeMigration.runChunk, { jobId });
    }
    const result = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      wallet: await ctx.db.get(ids.wallet),
      usage: await ctx.db.query("usageEvents").collect(),
      earnings: await ctx.db.query("publisherEarnings").collect(),
      entries: await ctx.db.query("walletEntries").collect(),
    }));
    expect(result.job?.status).toBe("verified");
    expect(result.wallet).toMatchObject({ balance: 980, sequence: 3 });
    expect(
      result.earnings.map((e) => [
        e.grossCredits,
        e.netCredits,
        e.platformFeeCredits,
      ]),
    ).toEqual([
      [20, 19, 1],
      [0, 0, 0],
    ]);
    for (const usage of result.usage) {
      expect(usage.specVersionId).toBeUndefined();
      expect(usage.operationId).toBeUndefined();
      expect(usage.settlementIdentityVersion).toBeUndefined();
      expect(usage.reservationId).toBeUndefined();
      expect(usage.projectName).toBe("Original API");
    }
    for (const earning of result.earnings)
      expect(earning.specVersionId).toBeUndefined();
    for (const entry of result.entries.filter(
      (e) => e.kind === "usage_settlement",
    ))
      expect(entry.settlementFingerprint).toMatch(
        /^legacy-finance-v1:[0-9a-f]{64}$/,
      );
  });

  it.each([
    "missing-earning",
    "cross-scope",
    "wrong-split",
    "partial-v2",
    "wrong-debit",
    "tampered-fingerprint",
  ] as const)(
    "rejects %s rather than treating it as verified legacy money",
    async (fault) => {
      const { t, ids } = await seed();
      const row = ids.settlements[0];
      await t.run(async (ctx) => {
        if (fault === "missing-earning") await ctx.db.delete(row.earning);
        if (fault === "cross-scope")
          await ctx.db.patch(row.earning, {
            consumerOrganizationId: ids.publisher,
          });
        if (fault === "wrong-split")
          await ctx.db.patch(row.earning, { netCredits: 20 });
        if (fault === "partial-v2")
          await ctx.db.patch(row.usage, { operationId: "POST /" });
        if (fault === "wrong-debit")
          await ctx.db.patch(row.entry, { amount: -19 });
        if (fault === "tampered-fingerprint")
          await ctx.db.patch(row.entry, {
            settlementFingerprint: "v2-fingerprint",
          });
      });
      await expect(
        t.run(async (ctx) => {
          const usage = await ctx.db.get(row.usage);
          if (!usage) throw new Error("Fixture missing");
          return legacySettlementFacts(ctx, usage, row.ref);
        }),
      ).rejects.toThrow(/Legacy settlement/);
      expect(await t.run((ctx) => ctx.db.get(ids.wallet))).toMatchObject({
        balance: 980,
        sequence: 3,
      });
    },
  );
});
