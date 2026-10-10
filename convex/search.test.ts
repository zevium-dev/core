/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildEmbedText } from "./search";

const modules = import.meta.glob("./**/*.ts");

/** 768-dim dummy vector — matches the Gemini text-embedding-004 dimensionality. */
function dummyEmbed(fill = 0.01): number[] {
  return Array.from({ length: 768 }, () => fill);
}

function openapiSpec(paths: Record<string, unknown>): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Test", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
    paths,
  });
}

type SeededSearch = {
  orgId: Id<"organizations">;
  publicId: Id<"projects">;
  privateId: Id<"projects">;
  draftId: Id<"projects">;
  publicEmbedId: Id<"specEmbeddings">;
  privateEmbedId: Id<"specEmbeddings">;
  draftEmbedId: Id<"specEmbeddings">;
};

/**
 * Seed three projects + a specEmbeddings row for each (the scenario an attacker
 * cares about: a stale embedding persists after a project goes private/draft).
 * fetchSearchListings must still exclude private + draft.
 */
async function seedSearchWorld(
  t: ReturnType<typeof convexTest>,
): Promise<SeededSearch> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_search",
      name: "Search Co",
      slug: "search-co",
      publicHandle: "search-co",
    });

    const publicId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Weather API",
      slug: "weather",
      description: "Forecasts and climate data",
      status: "published",
      visibility: "public",
      tags: ["climate", "data"],
    });
    await ctx.db.insert("specVersions", {
      projectId: publicId,
      version: "1.0.0",
      publishedAt: 1_700_000_000_000,
      spec: openapiSpec({
        "/forecast": { get: { "x-zevium-cost": 1, summary: "Get forecast" } },
      }),
    });

    const privateId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Secret Billing API",
      slug: "secret-billing",
      description: "Internal only",
      status: "published",
      visibility: "private",
      tags: ["billing"],
    });
    await ctx.db.insert("specVersions", {
      projectId: privateId,
      version: "1.0.0",
      publishedAt: 1_700_000_000_000,
      spec: openapiSpec({
        "/charge": { post: { "x-zevium-cost": 1, summary: "Charge card" } },
      }),
    });

    for (const [projectId, projectSlug] of [
      [publicId, "weather"],
      [privateId, "secret-billing"],
    ] as const) {
      await ctx.db.insert("publicRouteTombstones", {
        organizationId: orgId,
        projectId,
        publisherHandle: "search-co",
        projectSlug,
        reservedAt: 1_700_000_000_000,
      });
    }

    const draftId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Drafty API",
      slug: "drafty",
      description: "Not yet published",
      status: "draft",
      visibility: "public",
      tags: ["wip"],
    });

    // A stale embedding lingers for each project — even private/draft ones.
    const publicEmbedId = await ctx.db.insert("specEmbeddings", {
      projectId: publicId,
      text: "weather",
      embedding: dummyEmbed(0.9),
      updatedAt: 1,
    });
    const privateEmbedId = await ctx.db.insert("specEmbeddings", {
      projectId: privateId,
      text: "secret billing",
      embedding: dummyEmbed(0.8),
      updatedAt: 1,
    });
    const draftEmbedId = await ctx.db.insert("specEmbeddings", {
      projectId: draftId,
      text: "drafty",
      embedding: dummyEmbed(0.7),
      updatedAt: 1,
    });

    return {
      orgId,
      publicId,
      privateId,
      draftId,
      publicEmbedId,
      privateEmbedId,
      draftEmbedId,
    };
  });
}

describe("buildEmbedText", () => {
  it("includes name, description, and tags", () => {
    const text = buildEmbedText(
      { name: "Weather API", description: "Forecasts", tags: ["climate"] },
      null,
    );
    expect(text).toBe("Weather API Forecasts climate");
  });

  it("includes endpoint method/path/summary lines from the spec", () => {
    const text = buildEmbedText(
      { name: "Pay API", description: undefined, tags: [] },
      openapiSpec({
        "/charge": { post: { summary: "Charge a card" } },
        "/refund": {
          get: { summary: "Issue refund" },
        },
      }),
    );
    // name first, then both endpoints (Object key order preserved).
    expect(text).toContain("Pay API");
    expect(text).toContain("POST /charge Charge a card");
    expect(text).toContain("GET /refund Issue refund");
  });

  it("degrades to name/desc/tags when spec JSON is malformed", () => {
    const text = buildEmbedText(
      { name: "X", description: "D", tags: ["t"] },
      "{not valid json",
    );
    expect(text).toBe("X D t");
  });

  it("omits endpoints that lack a summary without breaking the blob", () => {
    const text = buildEmbedText(
      { name: "Y", description: undefined, tags: [] },
      openapiSpec({
        "/ping": { get: {} },
      }),
    );
    expect(text).toBe("Y GET /ping");
  });

  it("handles a project with no description and no tags", () => {
    expect(
      buildEmbedText({ name: "Solo", description: undefined, tags: [] }, null),
    ).toBe("Solo");
  });
});

describe("search.fetchSearchListings", () => {
  it("excludes private and draft projects even with stale embeddings", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedSearchWorld(t);

    const result = await t.query(internal.search.fetchSearchListings, {
      ids: [seed.publicEmbedId, seed.privateEmbedId, seed.draftEmbedId],
      scores: [0.95, 0.9, 0.85],
    });

    expect(result).toHaveLength(1);
    const only = result[0];
    expect(only).toBeDefined();
    expect(only?.slug).toBe("weather");
    expect(only).not.toHaveProperty("projectId");
    expect(only).not.toHaveProperty("organizationId");
    expect(only?.score).toBe(0.95);
    expect(only?.name).toBe("Weather API");
    expect(only?.publisherHandle).toBe("search-co");
    expect(only?.pricing).toEqual({
      minCost: 1,
      maxCost: 1,
      endpointCount: 1,
      hasFreeTier: false,
    });
  });

  it("returns empty when all matches are private/draft", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedSearchWorld(t);

    const result = await t.query(internal.search.fetchSearchListings, {
      ids: [seed.privateEmbedId, seed.draftEmbedId],
      scores: [0.9, 0.8],
    });

    expect(result).toEqual([]);
  });

  it("never attaches quality from a superseded spec version", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedSearchWorld(t);
    const version1 = await t.run(async (ctx) =>
      ctx.db
        .query("specVersions")
        .withIndex("by_project", (q) => q.eq("projectId", seed.publicId))
        .unique(),
    );
    if (version1 === null) throw new Error("version missing");
    await t.run(async (ctx) => {
      await ctx.db.insert("qualitySnapshots", {
        projectId: seed.publicId,
        specVersionId: version1._id,
        reachabilitySampleSize: 3,
        reachabilityResponseCount: 3,
        reachabilityPercent: 100,
        reachabilityLatencyP50Ms: 25,
        insufficientReachabilityData: false,
        apiSampleSize: 20,
        apiSuccessCount: 13,
        apiSuccessRatePercent: 65,
        apiLatencyP50Ms: 25,
        insufficientApiData: false,
        lastProbeOutcome: "healthy",
        lastProbedAt: 1_700_000_010_000,
        publishedAt: version1.publishedAt,
        updatedAt: 1_700_000_010_000,
      });
    });
    const current = await t.query(internal.search.fetchSearchListings, {
      ids: [seed.publicEmbedId],
      scores: [0.9],
    });
    expect(current[0]?.quality).toMatchObject({
      reachabilitySampleSize: 3,
      apiSuccessRatePercent: 65,
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("specVersions", {
        projectId: seed.publicId,
        version: "2.0.0",
        publishedAt: version1.publishedAt + 1,
        spec: openapiSpec({
          "/forecast": { get: { "x-zevium-cost": 2 } },
        }),
      });
    });
    const stale = await t.query(internal.search.fetchSearchListings, {
      ids: [seed.publicEmbedId],
      scores: [0.9],
    });
    expect(stale[0]?.quality).toBeNull();
  });

  it("skips ids whose embedding row was deleted", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedSearchWorld(t);

    // Insert a real row, then delete it — leaves a valid id that db.get misses.
    const deletedId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("specEmbeddings", {
        projectId: seed.publicId,
        text: "ghost",
        embedding: dummyEmbed(),
        updatedAt: 1,
      });
      await ctx.db.delete(id);
      return id;
    });

    const result = await t.query(internal.search.fetchSearchListings, {
      ids: [seed.publicEmbedId, deletedId],
      scores: [0.9, 0.5],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.slug).toBe("weather");
  });

  it("preserves caller-provided order (vectorSearch already ranks)", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedSearchWorld(t);

    // Add a second public+published project so ordering is observable.
    const geoEmbedId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("projects", {
        organizationId: seed.orgId,
        name: "Geo API",
        slug: "geo",
        description: "Geocoding",
        status: "published",
        visibility: "public",
        tags: ["maps"],
      });
      await ctx.db.insert("specVersions", {
        projectId: id,
        version: "1.0.0",
        publishedAt: 1_700_000_001_000,
        spec: openapiSpec({ "/geo": { get: { "x-zevium-cost": 2 } } }),
      });
      await ctx.db.insert("publicRouteTombstones", {
        organizationId: seed.orgId,
        projectId: id,
        publisherHandle: "search-co",
        projectSlug: "geo",
        reservedAt: 1_700_000_001_000,
      });
      return await ctx.db.insert("specEmbeddings", {
        projectId: id,
        text: "geo",
        embedding: dummyEmbed(0.5),
        updatedAt: 2,
      });
    });

    // Input arrives in vectorSearch's ranked order; fetchSearchListings must
    // preserve it after filtering (it does not re-sort by score).
    const result = await t.query(internal.search.fetchSearchListings, {
      ids: [geoEmbedId, seed.publicEmbedId],
      scores: [0.99, 0.7],
    });

    expect(result.map((r) => r.slug)).toEqual(["geo", "weather"]);
    expect(result[0]?.score).toBe(0.99);
  });
});

describe("search.searchCatalogue — degraded path", () => {
  const prevKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    if (prevKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = prevKey;
    }
  });

  it("returns degraded=true and never throws when Gemini key is missing", async () => {
    const t = convexTest(schema, modules);
    const result = await t.action(api.search.searchCatalogue, {
      query: "weather forecasts",
    });
    expect(result).toEqual({ items: [], degraded: true });
  });

  it("returns empty non-degraded result for blank query", async () => {
    const t = convexTest(schema, modules);
    const result = await t.action(api.search.searchCatalogue, { query: "   " });
    expect(result).toEqual({ items: [], degraded: false });
  });
});

describe("search.embedProject — embedding pipeline", () => {
  const prevKey = process.env.GEMINI_API_KEY;
  const prevFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
    globalThis.fetch = (async () => {
      const body = JSON.stringify({ embedding: { values: dummyEmbed() } });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    if (prevKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = prevKey;
    }
    globalThis.fetch = prevFetch;
  });

  it("builds, embeds, and upserts one row per project", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_ep",
        name: "EP Co",
        slug: "ep-co",
        publicHandle: "ep-co",
      });
      const pid = await ctx.db.insert("projects", {
        organizationId: orgId,
        name: "Embed Me",
        slug: "embed-me",
        description: "Pipeline target",
        status: "published",
        visibility: "public",
        tags: ["x"],
      });
      await ctx.db.insert("specVersions", {
        projectId: pid,
        version: "1.0.0",
        publishedAt: 1_700_000_000_000,
        spec: openapiSpec({
          "/do": { post: { "x-zevium-cost": 1, summary: "Do work" } },
        }),
      });
      return pid;
    });

    await t.action(internal.search.embedProject, { projectId });

    const after = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("specEmbeddings")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect();
      return rows;
    });

    expect(after).toHaveLength(1);
    expect(after[0]?.embedding).toHaveLength(768);
    expect(after[0]?.text).toContain("Embed Me");
    expect(after[0]?.text).toContain("POST /do Do work");

    // Idempotent: re-running upserts (patches) the same single row.
    await t.action(internal.search.embedProject, { projectId });
    const afterSecond = await t.run(async (ctx) => {
      return await ctx.db
        .query("specEmbeddings")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect();
    });
    expect(afterSecond).toHaveLength(1);
  });

  it("no-ops gracefully when the project does not exist", async () => {
    const t = convexTest(schema, modules);
    // Valid id that no longer exists — getProjectForEmbed returns null.
    const deletedProjectId = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_gone",
        name: "Gone Co",
        slug: "gone-co",
        publicHandle: "gone-co",
      });
      const pid = await ctx.db.insert("projects", {
        organizationId: orgId,
        name: "Gone",
        slug: "gone",
        status: "draft",
        visibility: "private",
        tags: [],
      });
      await ctx.db.delete(pid);
      return pid;
    });
    await expect(
      t.action(internal.search.embedProject, { projectId: deletedProjectId }),
    ).resolves.toBeNull();
  });
});
