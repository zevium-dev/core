/**
 * Dev-only tooling: junk cleanup + demo catalogue seeding.
 * internalMutation only — never client-exposed, never imported by app code.
 * Run via `npx convex run dev:cleanupTestProjects` / `npx convex run dev:seedDemoProjects`.
 */
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { validateOpenApiSpec } from "./lib/validate";
import { isPublishedSurfaceAllowed } from "./lib/publicClaims";

// ---------------------------------------------------------------------------
// cleanupTestProjects
// ---------------------------------------------------------------------------

const JUNK_SLUG_PREFIXES = ["e2e-weather-"];
const JUNK_SLUGS = new Set(["manual-repro-1628", "scroll-test-1"]);

function isJunkSlug(slug: string): boolean {
  if (JUNK_SLUGS.has(slug)) return true;
  return JUNK_SLUG_PREFIXES.some((prefix) => slug.startsWith(prefix));
}

export type CleanupCounts = {
  projects: number;
  specs: number;
  specVersions: number;
  specEmbeddings: number;
  webhookEndpoints: number;
  webhookDeliveries: number;
};

/**
 * Delete e2e/manual-repro junk projects and every row that references them
 * (specs draft, specVersions, specEmbeddings, webhookEndpoints + their
 * deliveries). Matches slug prefix `e2e-weather-` or exact `manual-repro-1628`
 * / `scroll-test-1`. Idempotent — running twice is a no-op the second time.
 */
export const cleanupTestProjects = internalMutation({
  args: {},
  handler: async (ctx): Promise<CleanupCounts> => {
    const allProjects = await ctx.db.query("projects").collect();
    const junk = allProjects.filter((p) => isJunkSlug(p.slug));

    const counts: CleanupCounts = {
      projects: 0,
      specs: 0,
      specVersions: 0,
      specEmbeddings: 0,
      webhookEndpoints: 0,
      webhookDeliveries: 0,
    };

    for (const project of junk) {
      const specRow = await ctx.db
        .query("specs")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .unique();
      if (specRow !== null) {
        await ctx.db.delete(specRow._id);
        counts.specs += 1;
      }

      const versions = await ctx.db
        .query("specVersions")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();
      for (const version of versions) {
        await ctx.db.delete(version._id);
        counts.specVersions += 1;
      }

      const embeddings = await ctx.db
        .query("specEmbeddings")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();
      for (const embedding of embeddings) {
        await ctx.db.delete(embedding._id);
        counts.specEmbeddings += 1;
      }

      const endpoints = await ctx.db
        .query("webhookEndpoints")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();
      for (const endpoint of endpoints) {
        const deliveries = await ctx.db
          .query("webhookDeliveries")
          .withIndex("by_endpoint", (q) => q.eq("endpointId", endpoint._id))
          .collect();
        for (const delivery of deliveries) {
          await ctx.db.delete(delivery._id);
          counts.webhookDeliveries += 1;
        }
        await ctx.db.delete(endpoint._id);
        counts.webhookEndpoints += 1;
      }

      await ctx.db.delete(project._id);
      counts.projects += 1;
    }

    return counts;
  },
});

// ---------------------------------------------------------------------------
// seedDemoProjects
// ---------------------------------------------------------------------------

const DEMO_ORG_SLUG = "test-org";
const DEMO_VERSION = "1.0.0";

type DemoProjectDef = {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  spec: Record<string, unknown>;
};

const DEMO_PROJECTS: DemoProjectDef[] = [
  {
    slug: "weather-forecast",
    name: "Weather Forecast",
    description:
      "Free, no-signup weather API delivering current conditions and hourly forecasts worldwide by latitude and longitude.",
    tags: ["weather", "forecast"],
    spec: {
      openapi: "3.1.0",
      info: { title: "Weather Forecast", version: DEMO_VERSION },
      servers: [{ url: "https://api.open-meteo.com" }],
      paths: {
        "/v1/forecast": {
          get: {
            operationId: "getForecast",
            summary: "Current weather + hourly forecast by lat/lon",
            "x-zevium-cost": 3,
            parameters: [
              {
                name: "latitude",
                in: "query",
                required: true,
                schema: { type: "number" },
              },
              {
                name: "longitude",
                in: "query",
                required: true,
                schema: { type: "number" },
              },
              {
                name: "current_weather",
                in: "query",
                required: false,
                schema: { type: "boolean" },
              },
            ],
            responses: {
              "200": { description: "Forecast payload" },
            },
          },
        },
      },
    },
  },
  {
    slug: "random-user",
    name: "Random User Data",
    description:
      "Generates random, realistic user profile data — names, addresses, emails, photos — for testing and prototyping.",
    tags: ["testing", "data"],
    spec: {
      openapi: "3.1.0",
      info: { title: "Random User Data", version: DEMO_VERSION },
      servers: [{ url: "https://randomuser.me" }],
      paths: {
        "/api": {
          get: {
            operationId: "getRandomUser",
            summary: "Fetch one or more random user profiles",
            "x-zevium-cost": 2,
            "x-zevium-free-tier": 25,
            parameters: [
              {
                name: "results",
                in: "query",
                required: false,
                schema: { type: "integer" },
              },
            ],
            responses: {
              "200": { description: "Random user profiles" },
            },
          },
        },
      },
    },
  },
  {
    slug: "http-echo",
    name: "HTTP Echo",
    description:
      "Echoes back whatever you send — query params, headers, and JSON bodies — for testing HTTP clients and gateway wiring.",
    tags: ["testing", "http"],
    spec: {
      openapi: "3.1.0",
      info: { title: "HTTP Echo", version: DEMO_VERSION },
      servers: [{ url: "https://postman-echo.com" }],
      paths: {
        "/get": {
          get: {
            operationId: "echoGet",
            summary: "Echo query params + headers back as JSON",
            "x-zevium-cost": 1,
            "x-zevium-free-tier": 100,
            responses: {
              "200": { description: "Echoed request" },
            },
          },
        },
        "/post": {
          post: {
            operationId: "echoPost",
            summary: "Echo posted JSON body back as JSON",
            "x-zevium-cost": 1,
            responses: {
              "200": { description: "Echoed request" },
            },
          },
        },
      },
    },
  },
];

export type SeedResult = {
  created: string[];
  skipped: string[];
  updated: string[];
};

/**
 * Seed 3 published+public demo projects (real free upstreams, valid specs
 * with x-zevium-cost) into the `test-org` org for catalogue/e2e use.
 * Idempotent — skips any slug that already exists in the org.
 * The org must already exist (mirrored via Clerk sign-in) before seeding.
 */
export const seedDemoProjects = internalMutation({
  args: {},
  handler: async (ctx): Promise<SeedResult> => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", DEMO_ORG_SLUG))
      .unique();
    if (org === null) {
      throw new Error(
        `Org "${DEMO_ORG_SLUG}" not found. Sign in via Clerk once (mirrors the org via ensureOrganization) before seeding.`,
      );
    }

    const result: SeedResult = { created: [], skipped: [], updated: [] };

    for (const def of DEMO_PROJECTS) {
      const existing = await ctx.db
        .query("projects")
        .withIndex("by_org_slug", (q) =>
          q.eq("organizationId", org._id).eq("slug", def.slug),
        )
        .unique();
      // Pretty-print: this text IS the publisher-facing draft in the editor.
      const specJson = JSON.stringify(def.spec, null, 2);
      const issues = validateOpenApiSpec(specJson);
      const hasError = issues.some((issue) => issue.level === "error");
      if (
        hasError ||
        !isPublishedSurfaceAllowed(
          existing ?? {
            name: def.name,
            slug: def.slug,
            description: def.description,
            tags: def.tags,
          },
          org,
          {
            version: DEMO_VERSION,
            spec: specJson,
            deprecationMessage: undefined,
          },
        )
      ) {
        throw new Error(
          `Demo spec "${def.slug}" failed validation or public-copy policy: ${JSON.stringify(issues)}`,
        );
      }

      if (existing !== null) {
        // Refresh only mutable draft text. Published snapshots are immutable.
        const draft = await ctx.db
          .query("specs")
          .withIndex("by_project", (q) => q.eq("projectId", existing._id))
          .unique();
        if (draft !== null && draft.draft !== specJson) {
          await ctx.db.patch(draft._id, {
            draft: specJson,
            lastSavedAt: Date.now(),
          });
          result.updated.push(def.slug);
        } else {
          result.skipped.push(def.slug);
        }
        continue;
      }
      const now = Date.now();
      const projectId: Id<"projects"> = await ctx.db.insert("projects", {
        organizationId: org._id,
        name: def.name,
        slug: def.slug,
        description: def.description,
        status: "published",
        visibility: "public",
        tags: def.tags,
      });

      await ctx.db.insert("specs", {
        projectId,
        draft: specJson,
        lastSavedAt: now,
      });

      await ctx.db.insert("specVersions", {
        projectId,
        version: DEMO_VERSION,
        spec: specJson,
        publishedAt: now,
      });

      await ctx.scheduler.runAfter(0, internal.search.embedProject, {
        projectId,
      });

      result.created.push(def.slug);
    }

    return result;
  },
});
