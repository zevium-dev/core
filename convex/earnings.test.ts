/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { publisherEarningSplit } from "./accounting";

const modules = import.meta.glob("./**/*.ts");

type EarningsSeed = {
  organizationId: Id<"organizations">;
  projectId: Id<"projects">;
};

async function seedEarnings(
  t: TestConvex<typeof schema>,
): Promise<EarningsSeed> {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_publisher",
      name: "Publisher",
      slug: "publisher",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: "Forecast",
      slug: "forecast",
      status: "published",
      visibility: "public",
      tags: [],
    });
    const earningId = await ctx.db.insert("publisherEarnings", {
      publisherOrganizationId: organizationId,
      consumerOrganizationId: organizationId,
      projectId,
      projectName: "Forecast",
      projectSlug: "forecast",
      usageSettlementRefId: "settle:one",
      grossCredits: 100_001,
      platformFeeAtoms: 50_000_500,
      publisherNetAtoms: 950_009_500,
      platformFeeCredits: 5_000.05,
      netCredits: 95_000.95,
      clawedBackGrossCredits: 0,
      clawedBackAtoms: 0,
      releasedAtoms: 950_009_500,
      availableAt: 1,
      status: "available",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const publisherBalanceId = await ctx.db.insert("publisherBalances", {
      publisherOrganizationId: organizationId,
      availableAtoms: 950_009_500,
      allocatedAtoms: 0,
      paidAtoms: 0,
      pendingRiskAtoms: 0,
      reversedAtoms: 0,
      failedAtoms: 0,
      sequence: 1,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("publisherSettlementEntries", {
      publisherBalanceId,
      publisherOrganizationId: organizationId,
      kind: "earning_release",
      availableDeltaAtoms: 950_009_500,
      allocatedDeltaAtoms: 0,
      paidDeltaAtoms: 0,
      refId: `publisher:earning:${earningId}:release`,
      sequence: 1,
      earningId,
      createdAt: Date.now(),
    });
    return { organizationId, projectId };
  });
}

describe("earnings.forOrg", () => {
  it("requires the active organization and reads immutable earning records", async () => {
    const t = convexTest(schema, modules);
    await seedEarnings(t);
    await expect(
      t.query(api.earnings.forOrg, { orgSlug: "publisher" }),
    ).rejects.toThrow("Not authenticated");
    const result = await t
      .withIdentity({
        subject: "publisher",
        org_id: "org_publisher",
        org_role: "org:member",
      } as {
        subject: string;
        org_id: string;
        org_role: string;
      })
      .query(api.earnings.forOrg, { orgSlug: "publisher" });
    expect(result.allTime).toEqual({
      calls: 1,
      grossCredits: 100_001,
      netCredits: 95_000.95,
    });
    expect(result.byProject).toHaveLength(1);
    expect(result.byProject[0]).toMatchObject({
      name: "Forecast",
      slug: "forecast",
      calls: 1,
      grossCredits: 100_001,
      netCredits: 95_000.95,
    });
  });
});

describe("publisher earnings accounting precision", () => {
  it.each([
    { prices: [7, 7], net: 13.3 },
    { prices: [7, 7, 7], net: 19.95 },
    { prices: [1], net: 0.95 },
    { prices: [0], net: 0 },
  ])(
    "agrees across analytics, statement, and ledger for $prices",
    async ({ prices, net }) => {
      const t = convexTest(schema, modules);
      const { organizationId, projectId } = await seedEarnings(t);
      await t.run(async (ctx) => {
        const existing = await ctx.db.query("publisherEarnings").collect();
        for (const row of existing) await ctx.db.delete(row._id);
        let totalAtoms = 0;
        for (const [index, grossCredits] of prices.entries()) {
          const split = publisherEarningSplit(grossCredits);
          totalAtoms += split.publisherNetAtoms;
          await ctx.db.insert("publisherEarnings", {
            publisherOrganizationId: organizationId,
            consumerOrganizationId: organizationId,
            projectId,
            projectName: "Forecast",
            projectSlug: "forecast",
            usageSettlementRefId: `settle:precision:${index}`,
            grossCredits,
            platformFeeAtoms: split.platformFeeAtoms,
            publisherNetAtoms: split.publisherNetAtoms,
            platformFeeCredits: split.platformFeeCredits,
            // Deliberately stale display cache: every reader must use atoms.
            netCredits: 123,
            clawedBackGrossCredits: 0,
            clawedBackAtoms: 0,
            releasedAtoms: 0,
            availableAt: Date.now() + 86_400_000,
            status: "pending_risk",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
        const balance = await ctx.db.query("publisherBalances").unique();
        await ctx.db.patch(balance!._id, {
          availableAtoms: 0,
          pendingRiskAtoms: totalAtoms,
        });
      });
      const publisher = t.withIdentity({
        subject: "publisher",
        org_id: "org_publisher",
        org_role: "org:admin",
      } as { subject: string; org_id: string; org_role: string });
      const analytics = await publisher.query(api.analytics.projectAnalytics, {
        orgSlug: "publisher",
        projectSlug: "forecast",
        rangeDays: 7,
      });
      const statement = await publisher.query(api.earnings.forOrg, {
        orgSlug: "publisher",
      });
      const ledger = await publisher.query(api.payouts.getPayoutState, {});
      expect(analytics?.netCredits).toBe(net);
      expect(statement.byProject[0]?.netCredits).toBe(net);
      expect(statement.month.netCredits).toBe(net);
      expect(statement.allTime.netCredits).toBe(net);
      expect(ledger.earnings.pendingRisk).toBe(net);
      expect(statement.allTime.grossCredits).toBe(
        prices.reduce((sum, price) => sum + price, 0),
      );
    },
  );
});
