/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { summarizePublishedPricing } from "./catalogue";

const modules = import.meta.glob("./**/*.ts");

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
    const seed = await seedCatalogue(t);

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
    expect(bySlug.cheap?.projectId).toBe(seed.cheapId);
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
        orgSlug: "pub-co",
        projectSlug: "secret",
      }),
    ).resolves.toBeNull();

    await expect(
      t.query(api.catalogue.getPublicDetail, {
        orgSlug: "pub-co",
        projectSlug: "drafty",
      }),
    ).resolves.toBeNull();

    const publicDetail = await t.query(api.catalogue.getPublicDetail, {
      orgSlug: "pub-co",
      projectSlug: "cheap",
    });
    expect(publicDetail?.project.slug).toBe("cheap");
    expect(publicDetail?.latestVersion?.version).toBe("1.0.0");
  });
});
