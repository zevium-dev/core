/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { publisherEarningSplit } from "./accounting";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function asIdentity(
  t: ReturnType<typeof convexTest>,
  role: "org:admin" | "org:member" = "org:admin",
  subject = "user_hostile",
) {
  return t.withIdentity({
    subject,
    org_id: "org_hostile",
    org_slug: "hostile",
    org_role: role,
  } as { subject: string; org_id: string; org_slug: string; org_role: string });
}

async function seedOrg(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_hostile",
      name: "Hostile Org",
      slug: "hostile",
      publicHandle: "hostile",
    });
    return organizationId;
  });
}

describe("hostile control-plane state", () => {
  it("tombstones win over stale live rows on key, finance, checkout, and readiness paths", async () => {
    const t = convexTest(schema, modules);
    const organizationId = await seedOrg(t);
    const projectId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        organizationId,
        name: "Dead API",
        slug: "dead-api",
        status: "published",
        visibility: "public",
        tags: [],
      });
      await ctx.db.insert("specs", {
        projectId,
        draft: JSON.stringify({
          servers: [{ url: "https://api.example.com" }],
        }),
        lastSavedAt: 1,
      });
      await ctx.db.insert("organizationTombstones", {
        sourceRevision: 1,
        clerkOrgId: "org_hostile",
        archivedAt: 2,
      });
      return projectId;
    });

    await expect(
      asIdentity(t).mutation(api.keySettings.setCap, {
        keyId: "key_archived",
        monthlyCapCredits: 10,
      }),
    ).rejects.toThrow(/archived/);
    await expect(
      t.mutation(internal.payouts.getConnectProfileForActiveOrg, {
        clerkOrgId: "org_hostile",
      }),
    ).rejects.toThrow(/Active organization/);
    await expect(
      t.mutation(internal.billing.prepareCheckoutIntent, {
        clerkOrgId: "org_hostile",
        packId: "pack_10",
        stripePriceId: "price_hostile",
      }),
    ).rejects.toThrow(/Active organization/);
    await expect(
      t.query(internal.publishReadiness.getTarget, {
        projectId,
        clerkOrgId: "org_hostile",
      }),
    ).rejects.toThrow(/organization/);
  });

  it("members cannot mutate webhooks or read org-wide analytics, and key writes require ownership", async () => {
    const t = convexTest(schema, modules);
    const organizationId = await seedOrg(t);
    const projectId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        organizationId,
        name: "Member API",
        slug: "member-api",
        status: "published",
        visibility: "public",
        tags: [],
      });
      await ctx.db.insert("keySettings", {
        clerkOrgId: "org_hostile",
        keyId: "key_other_member",
        ownerUserId: "user_other",
        disabled: false,
        updatedAt: 1,
      });
      return projectId;
    });
    const member = asIdentity(t, "org:member");
    await expect(
      member.mutation(api.webhooks.upsertEndpoint, {
        projectId,
        url: "https://example.com/hook",
      }),
    ).rejects.toThrow(/admin/);
    await expect(
      member.query(api.analytics.projectAnalytics, {
        orgSlug: "hostile",
        projectSlug: "member-api",
      }),
    ).rejects.toThrow(/admin/);
    await expect(
      member.mutation(api.keySettings.setDisabled, {
        keyId: "key_other_member",
        disabled: true,
      }),
    ).rejects.toThrow(/Verified key not found/);
  });

  it("records provider ownership and keeps unattributed usage fail-closed", async () => {
    const t = convexTest(schema, modules);
    const organizationId = await seedOrg(t);
    const seeded = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        organizationId,
        name: "Owned API",
        slug: "owned-api",
        status: "published",
        visibility: "public",
        tags: [],
      });
      await ctx.db.insert("wallets", {
        organizationId,
        balance: 10,
        sequence: 0,
      });
      const versionId = await ctx.db.insert("specVersions", {
        projectId,
        version: "1.0.0",
        publishedAt: 1,
        spec: "{}",
      });
      return { projectId, versionId };
    });
    const member = asIdentity(t, "org:member");
    await t.mutation(internal.keySettings.recordProviderVerifiedKey, {
      keyId: "key_owned",
      ownerUserId: "user_hostile",
      clerkOrgId: "org_hostile",
    });
    const result = await t.mutation(internal.wallets.recordUsage, {
      events: [
        {
          organizationId,
          projectId: seeded.projectId,
          endpoint: "/run",
          method: "GET",
          credits: 1,
          status: 200,
          latencyMs: 1,
          keyId: "key_owned",
          at: 1,
          settleRefId: "settle:owned",
          consumerClerkOrgId: "org_hostile",
          specVersionId: seeded.versionId,
          billingOutcome: "settled",
          qualityOutcome: "success",
        },
      ],
    });
    expect(result.results[0]?.status).toBe("applied");
    expect(
      await t.run(
        async (ctx) => (await ctx.db.query("usageEvents").first())?.ownerUserId,
      ),
    ).toBe("user_hostile");
  });

  it("rejects safe-integer wallet and ledger overflow", async () => {
    const t = convexTest(schema, modules);
    const organizationId = await seedOrg(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("wallets", {
        organizationId,
        balance: Number.MAX_SAFE_INTEGER,
        sequence: Number.MAX_SAFE_INTEGER,
      });
    });
    await expect(
      t.mutation(internal.wallets.applyAdminAdjustment, {
        organizationId,
        amount: 1,
        refId: "overflow:balance",
      }),
    ).rejects.toThrow(/overflow|safe integer/);
    expect(() => publisherEarningSplit(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /safe integer/,
    );
  });

  it("returns bounded public pages and opaque admin inventory handles", async () => {
    const t = convexTest(schema, modules);
    const organizationId = await seedOrg(t);
    await t.run(async (ctx) => {
      const statsId = await ctx.db.insert("catalogueStats", {
        key: "public",
        publicCount: 101,
        tagCounts: { hostile: 101 },
        freeTierCount: 0,
        projectionComplete: true,
        updatedAt: 1,
      });
      for (let index = 0; index < 101; index += 1) {
        const projectId = await ctx.db.insert("projects", {
          organizationId,
          name: `API ${index}`,
          slug: `api-${index}`,
          status: "published",
          visibility: "public",
          tags: ["hostile"],
        });
        const listingId = await ctx.db.insert("catalogueListings", {
          projectId,
          clerkOrgId: "org_hostile",
          publisherHandle: "hostile",
          orgName: "Hostile Org",
          name: `API ${index}`,
          sortName: `api ${index}`,
          slug: `api-${index}`,
          tags: ["hostile"],
          tagText: "hostile",
          searchText: `api ${index} hostile`,
          publishedAt: index,
          pricingValid: true,
          minCost: 1,
          maxCost: 1,
          endpointCount: 1,
          hasFreeTier: false,
          discoverable: true,
          updatedAt: index,
        });
        await ctx.db.insert("catalogueTagListings", {
          listingId,
          tag: "hostile",
          publishedAt: index,
          sortName: `api ${index}`,
          minCost: 1,
          discoverable: true,
        });
      }
      await ctx.db.patch(statsId, { updatedAt: 2 });
    });
    const page = await t.query(api.catalogue.listPublic, { tag: "hostile" });
    expect(page.items).toHaveLength(24);
    expect(page.nextCursor).not.toBeNull();
    expect(page.total).toBe(101);
    expect(page.facets.tags).toEqual([{ name: "hostile", count: 101 }]);

    vi.stubEnv("ADMIN_USER_IDS", "user_hostile");
    const orgs = await asIdentity(t).query(api.admin.listOrgs, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(orgs.page[0]).not.toHaveProperty("_id");
    expect(orgs.page[0]).not.toHaveProperty("clerkOrgId");
    const projects = await asIdentity(t).query(api.admin.listProjects, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(projects.page[0]).not.toHaveProperty("organizationId");
    expect(projects.page[0]).toHaveProperty("handle");
  });
});
