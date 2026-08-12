/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { summarizePublishedPricing } from "./catalogue";

const modules = import.meta.glob("./**/*.ts");

afterEach(() => vi.useRealTimers());

type SeededCatalogue = {
  orgId: Id<"organizations">;
  cheapId: Id<"projects">;
  freeId: Id<"projects">;
  expensiveId: Id<"projects">;
  privateId: Id<"projects">;
  draftId: Id<"projects">;
  t0: number;
  t1: number;
  t2: number;
};

function openapiSpec(paths: Record<string, unknown>): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Test", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
    paths,
  });
}

async function seedCatalogue(
  t: ReturnType<typeof convexTest>,
): Promise<SeededCatalogue> {
  const t0 = 1_700_000_000_000;
  const t1 = t0 + 60_000;
  const t2 = t0 + 120_000;

  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_pub",
      name: "Pub Co",
      slug: "pub-co",
      publicHandle: "pub-co",
    });

    // Public + published, minCost 1, no free tier. Newest-ish.
    const cheapId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Cheap API",
      slug: "cheap",
      description: "Low cost endpoints",
      status: "published",
      visibility: "public",
      tags: ["tools"],
    });
    await ctx.db.insert("specVersions", {
      projectId: cheapId,
      version: "1.0.0",
      publishedAt: t1,
      spec: openapiSpec({
        "/ping": {
          get: { "x-zevium-cost": 1, summary: "Ping" },
        },
        "/work": {
          post: { "x-zevium-cost": 3, summary: "Work" },
        },
      }),
    });

    // Public + published, free tier, minCost 2. Oldest publish.
    const freeId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Free Tier API",
      slug: "free-tier",
      description: "Has free calls",
      status: "published",
      visibility: "public",
      tags: ["free", "tools"],
    });
    await ctx.db.insert("specVersions", {
      projectId: freeId,
      version: "1.0.0",
      publishedAt: t0,
      spec: openapiSpec({
        "/a": {
          get: {
            "x-zevium-cost": 2,
            "x-zevium-free-tier": 5,
            summary: "A",
          },
        },
        "/b": {
          post: { "x-zevium-cost": 8, summary: "B" },
        },
      }),
    });

    // Public + published, expensive minCost 10. Middle publish.
    const expensiveId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Expensive API",
      slug: "expensive",
      status: "published",
      visibility: "public",
      tags: [],
    });
    await ctx.db.insert("specVersions", {
      projectId: expensiveId,
      version: "2.0.0",
      publishedAt: t2,
      spec: openapiSpec({
        "/gold": {
          get: { "x-zevium-cost": 10, summary: "Gold" },
        },
        "/platinum": {
          post: { "x-zevium-cost": 50, summary: "Platinum" },
        },
      }),
    });

    // Private published — must never list.
    const privateId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Secret API",
      slug: "secret",
      status: "published",
      visibility: "private",
      tags: ["tools"],
    });
    await ctx.db.insert("specVersions", {
      projectId: privateId,
      version: "1.0.0",
      publishedAt: t2 + 1,
      spec: openapiSpec({
        "/hidden": {
          get: { "x-zevium-cost": 1, summary: "Hidden" },
        },
      }),
    });

    for (const [projectId, projectSlug] of [
      [cheapId, "cheap"],
      [freeId, "free-tier"],
      [expensiveId, "expensive"],
      [privateId, "secret"],
    ] as const) {
      await ctx.db.insert("publicRouteTombstones", {
        organizationId: orgId,
        projectId,
        publisherHandle: "pub-co",
        projectSlug,
        reservedAt: t0,
      });
    }

    // Public draft — must never list.
    const draftId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Drafty API",
      slug: "drafty",
      status: "draft",
      visibility: "public",
      tags: ["tools"],
    });
    // Draft body only — no published version.
    await ctx.db.insert("specs", {
      projectId: draftId,
      draft: openapiSpec({
        "/draft": {
          get: { "x-zevium-cost": 1, summary: "Draft only" },
        },
      }),
      lastSavedAt: t2,
    });

    return {
      orgId,
      cheapId,
      freeId,
      expensiveId,
      privateId,
      draftId,
      t0,
      t1,
      t2,
    };
  });
}

describe("summarizePublishedPricing", () => {
  it("computes min/max/count/free from ops", () => {
    const summary = summarizePublishedPricing(
      openapiSpec({
        "/a": {
          get: { "x-zevium-cost": 2, "x-zevium-free-tier": 3 },
        },
        "/b": {
          post: { "x-zevium-cost": 8 },
        },
      }),
    );
    expect(summary).toEqual({
      minCost: 2,
      maxCost: 8,
      endpointCount: 2,
      hasFreeTier: true,
    });
  });

  it("defaults missing cost to 1 and empty paths to zeros", () => {
    expect(
      summarizePublishedPricing(
        openapiSpec({
          "/x": { get: { summary: "no cost" } },
        }),
      ),
    ).toEqual({
      minCost: 1,
      maxCost: 1,
      endpointCount: 1,
      hasFreeTier: false,
    });

    expect(summarizePublishedPricing(openapiSpec({}))).toEqual({
      minCost: 0,
      maxCost: 0,
      endpointCount: 0,
      hasFreeTier: false,
    });
  });

  it("returns null on invalid JSON", () => {
    expect(summarizePublishedPricing("{nope")).toBeNull();
  });
});

describe("catalogue.listPublic", () => {
  it("excludes private and draft projects", async () => {
    const t = convexTest(schema, modules);
    await seedCatalogue(t);

    const result = await t.query(api.catalogue.listPublic, {});
    const slugs = result.items.map((i) => i.slug).sort();

    expect(slugs).toEqual(["cheap", "expensive", "free-tier"]);
    expect(slugs).not.toContain("secret");
    expect(slugs).not.toContain("drafty");
  });

  it("attaches pricing summary from latest published spec", async () => {
    const t = convexTest(schema, modules);
    await seedCatalogue(t);

    const result = await t.query(api.catalogue.listPublic, {});
    const bySlug = Object.fromEntries(
      result.items.map((item) => [item.slug, item]),
    );

    expect(bySlug.cheap?.pricing).toEqual({
      minCost: 1,
      maxCost: 3,
      endpointCount: 2,
      hasFreeTier: false,
    });
    expect(bySlug["free-tier"]?.pricing).toEqual({
      minCost: 2,
      maxCost: 8,
      endpointCount: 2,
      hasFreeTier: true,
    });
    expect(bySlug.expensive?.pricing).toEqual({
      minCost: 10,
      maxCost: 50,
      endpointCount: 2,
      hasFreeTier: false,
    });
    expect(bySlug.cheap).not.toHaveProperty("projectId");
    expect(bySlug.cheap).not.toHaveProperty("organizationId");
  });

  it("shows quality only when snapshot belongs to latest immutable version", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedCatalogue(t);
    const version1 = await t.run(async (ctx) =>
      ctx.db
        .query("specVersions")
        .withIndex("by_project", (q) => q.eq("projectId", seed.cheapId))
        .unique(),
    );
    if (version1 === null) throw new Error("version missing");
    await t.run(async (ctx) => {
      await ctx.db.insert("qualitySnapshots", {
        projectId: seed.cheapId,
        specVersionId: version1._id,
        reachabilitySampleSize: 3,
        reachabilityResponseCount: 3,
        reachabilityPercent: 100,
        reachabilityLatencyP50Ms: 12,
        insufficientReachabilityData: false,
        apiSampleSize: 20,
        apiSuccessCount: 20,
        apiSuccessRatePercent: 100,
        apiLatencyP50Ms: 12,
        insufficientApiData: false,
        lastProbeOutcome: "healthy",
        lastProbedAt: seed.t2,
        publishedAt: version1.publishedAt,
        updatedAt: seed.t2,
      });
    });
    const current = await t.query(api.catalogue.listPublic, { sort: "name" });
    expect(
      current.items.find((item) => item.slug === "cheap")?.quality,
    ).toMatchObject({
      reachabilitySampleSize: 3,
      apiSuccessRatePercent: 100,
    });
    const detail = await t.query(api.catalogue.getPublicDetail, {
      publisherHandle: "pub-co",
      projectSlug: "cheap",
    });
    expect(detail?.quality).toMatchObject({ reachabilityLatencyP50Ms: 12 });

    await t.run(async (ctx) => {
      await ctx.db.insert("specVersions", {
        projectId: seed.cheapId,
        version: "2.0.0",
        publishedAt: seed.t2 + 1,
        spec: openapiSpec({
          "/ping": { get: { "x-zevium-cost": 2 } },
        }),
      });
    });
    const stale = await t.query(api.catalogue.listPublic, { sort: "name" });
    expect(
      stale.items.find((item) => item.slug === "cheap")?.quality,
    ).toBeNull();
    const staleDetail = await t.query(api.catalogue.getPublicDetail, {
      publisherHandle: "pub-co",
      projectSlug: "cheap",
    });
    expect(staleDetail?.quality).toBeNull();
  });

  it("filters by hasFreeTier", async () => {
    const t = convexTest(schema, modules);
    await seedCatalogue(t);

    const result = await t.query(api.catalogue.listPublic, {
      hasFreeTier: true,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.slug).toBe("free-tier");
    expect(result.items[0]?.pricing?.hasFreeTier).toBe(true);
  });

  it("filters by maxCost against minCost", async () => {
    const t = convexTest(schema, modules);
    await seedCatalogue(t);

    // minCost <= 2 → cheap (1) + free-tier (2); expensive (10) out
    const result = await t.query(api.catalogue.listPublic, { maxCost: 2 });
    const slugs = result.items.map((i) => i.slug).sort();
    expect(slugs).toEqual(["cheap", "free-tier"]);

    const onlyOne = await t.query(api.catalogue.listPublic, { maxCost: 1 });
    expect(onlyOne.items.map((i) => i.slug)).toEqual(["cheap"]);
  });

  it("sorts newest, name, cheapest", async () => {
    const t = convexTest(schema, modules);
    await seedCatalogue(t);

    const newest = await t.query(api.catalogue.listPublic, { sort: "newest" });
    expect(newest.items.map((i) => i.slug)).toEqual([
      "expensive", // t2
      "cheap", // t1
      "free-tier", // t0
    ]);

    const byName = await t.query(api.catalogue.listPublic, { sort: "name" });
    expect(byName.items.map((i) => i.name)).toEqual([
      "Cheap API",
      "Expensive API",
      "Free Tier API",
    ]);

    const cheapest = await t.query(api.catalogue.listPublic, {
      sort: "cheapest",
    });
    expect(cheapest.items.map((i) => i.slug)).toEqual([
      "cheap", // min 1
      "free-tier", // min 2
      "expensive", // min 10
    ]);
  });

  it("substring search still works with filters", async () => {
    const t = convexTest(schema, modules);
    await seedCatalogue(t);

    const result = await t.query(api.catalogue.listPublic, {
      search: "free",
      sort: "name",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.slug).toBe("free-tier");
  });

  it("getPublicDetail hides private and draft", async () => {
    const t = convexTest(schema, modules);
    await seedCatalogue(t);

    await expect(
      t.query(api.catalogue.getPublicDetail, {
        publisherHandle: "pub-co",
        projectSlug: "secret",
      }),
    ).resolves.toBeNull();

    await expect(
      t.query(api.catalogue.getPublicDetail, {
        publisherHandle: "pub-co",
        projectSlug: "drafty",
      }),
    ).resolves.toBeNull();

    const publicDetail = await t.query(api.catalogue.getPublicDetail, {
      publisherHandle: "pub-co",
      projectSlug: "cheap",
    });
    expect(publicDetail?.project._id).toBeDefined();
    expect(publicDetail?.org).not.toHaveProperty("_id");
    expect(publicDetail?.project.slug).toBe("cheap");
    expect(publicDetail?.latestVersion?.version).toBe("1.0.0");
  });

  it("backfills and traverses a large projection with opaque gap-free cursors", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_scale",
        name: "Scale Publisher",
        slug: "scale-publisher",
        publicHandle: "scale-publisher",
      });
      for (let index = 0; index < 61; index += 1) {
        const suffix = String(index).padStart(3, "0");
        const projectId = await ctx.db.insert("projects", {
          organizationId: orgId,
          name: `API ${suffix}`,
          slug: `api-${suffix}`,
          status: "published",
          visibility: "public",
          tags: ["scale"],
        });
        await ctx.db.insert("specVersions", {
          projectId,
          version: "1.0.0",
          publishedAt: index + 1,
          spec: openapiSpec({
            "/call": { get: { "x-zevium-cost": index + 1 } },
          }),
        });
      }
    });

    expect(
      await t.mutation(internal.catalogue.backfillCatalogueListingsPage, {
        cursor: null,
      }),
    ).toEqual({ processed: 25, done: false });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    const names: string[] = [];
    let cursor: string | null = null;
    let total = 0;
    do {
      const page = await t.query(api.catalogue.listPublic, {
        sort: "name",
        ...(cursor === null ? {} : { cursor }),
      });
      names.push(...page.items.map((item) => item.name));
      total = page.total;
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(names).toHaveLength(61);
    expect(new Set(names).size).toBe(61);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(total).toBe(61);
  });
});
