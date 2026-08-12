/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

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
    await ctx.db.insert("publisherEarnings", {
      publisherOrganizationId: organizationId,
      consumerOrganizationId: organizationId,
      projectId,
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
        org_role: "org:admin",
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
