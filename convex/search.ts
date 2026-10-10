/**
 * Catalogue semantic search.
 *
 * Embeddings: Gemini gemini-embedding-001 pinned to 768 dims (matches the
 * pre-existing `specEmbeddings` by_embedding vectorIndex). Schema is owned
 * by schema.ts — `specEmbeddings` (by_project index + by_embedding) exists already.
 * One embedding row per project, built from the latest published spec on publish.
 *
 * Security invariant: vector search returns specEmbeddings ids only. The
 * `fetchSearchListings` query re-checks every project is PUBLIC + PUBLISHED
 * before shaping a card — never leak private or draft projects, even if a
 * stale embedding lingers after a visibility/status flip.
 */
import { isPublishedSurfaceAllowed } from "./lib/publicSurface";
import { parseSpec } from "@zevium/shared";
import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import type { Doc } from "./_generated/dataModel";
import { summarizePublishedPricing, type PublicListing } from "./catalogue";
import { getActiveOrgById } from "./lib/auth";
import { qualitySnapshotContract } from "./lib/qualityContract";
import {
  getActivePublicRouteBinding,
  isOrganizationActive,
  isProjectRetired,
} from "./lib/publicRoutes";

/** Max results returned by a semantic search (VectorSearchQuery.limit caps at 256). */
const SEARCH_LIMIT_MAX = 20;
const SEARCH_LIMIT_DEFAULT = 10;

/**
 * Gemini embedContent endpoint. We use `gemini-embedding-001` pinned to
 * `outputDimensionality: 768` to match the pre-existing `by_embedding`
 * vectorIndex (768 dims). Google still lists this stable text model, while
 * `gemini-embedding-2` is newer and would require re-embedding all stored data
 * because the two embedding spaces are incompatible.
 */
const GEMINI_EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";
/** Must match the `by_embedding` vectorIndex dimensions in schema.ts. */
const EMBED_DIMENSIONS = 768;

const QUERY_CACHE_TTL_MS = 24 * 60 * MINUTE;
const QUERY_EMBED_LEASE_MS = 30_000;
const searchRateLimiter = new RateLimiter(components.rateLimiter, {
  gatewayOrgSearch: {
    kind: "token bucket",
    rate: 20,
    period: MINUTE,
    capacity: 20,
  },
  gatewayKeySearch: {
    kind: "token bucket",
    rate: 20,
    period: MINUTE,
    capacity: 20,
  },
  signedInSearch: {
    kind: "token bucket",
    rate: 20,
    period: MINUTE,
    capacity: 20,
  },
  anonymousSearch: {
    kind: "token bucket",
    rate: 30,
    period: MINUTE,
    capacity: 30,
  },
  searchBudget: {
    kind: "token bucket",
    rate: 120,
    period: MINUTE,
    capacity: 120,
  },
});

type QueryEmbeddingAdmission =
  | { status: "limited" }
  | { status: "pending" }
  | { status: "cached"; embedding: number[] }
  | {
      status: "admitted";
      id: Doc<"searchQueryEmbeddings">["_id"];
      leaseToken: string;
    };

const gatewayCaller = v.object({ orgId: v.string(), keyId: v.string() });
type GatewayCaller = { orgId: string; keyId: string };

/** Atomically rate-limit and claim cache misses, including concurrent searches. */
export const prepareQueryEmbedding = internalMutation({
  args: { query: v.string(), gatewayCaller: v.optional(gatewayCaller) },
  handler: async (ctx, args): Promise<QueryEmbeddingAdmission> => {
    const identity = await ctx.auth.getUserIdentity();
    // Convex actions have no trusted client IP/session for anonymous callers.
    // A shared bucket cannot be bypassed by rotating a caller-supplied id.
    if (args.gatewayCaller !== undefined) {
      const org = await searchRateLimiter.limit(ctx, "gatewayOrgSearch", {
        key: args.gatewayCaller.orgId,
      });
      if (!org.ok) return { status: "limited" };
      const key = await searchRateLimiter.limit(ctx, "gatewayKeySearch", {
        key: JSON.stringify([
          args.gatewayCaller.orgId,
          args.gatewayCaller.keyId,
        ]),
      });
      if (!key.ok) return { status: "limited" };
    } else {
      const caller =
        identity === null
          ? await searchRateLimiter.limit(ctx, "anonymousSearch")
          : await searchRateLimiter.limit(ctx, "signedInSearch", {
              key: identity.tokenIdentifier,
            });
      if (!caller.ok) return { status: "limited" };
    }
    const budget = await searchRateLimiter.limit(ctx, "searchBudget");
    if (!budget.ok) return { status: "limited" };

    const cacheKey = `gemini-embedding-001:768:RETRIEVAL_QUERY:${args.query}`;
    const existing = await ctx.db
      .query("searchQueryEmbeddings")
      .withIndex("by_cache_key", (q) => q.eq("cacheKey", cacheKey))
      .unique();
    if (existing !== null && existing.expiresAt > Date.now()) {
      return existing.embedding === undefined
        ? { status: "pending" }
        : { status: "cached", embedding: existing.embedding };
    }
    const leaseToken = crypto.randomUUID();
    const expiresAt = Date.now() + QUERY_EMBED_LEASE_MS;
    let id;
    if (existing === null) {
      id = await ctx.db.insert("searchQueryEmbeddings", {
        cacheKey,
        leaseToken,
        expiresAt,
      });
    } else {
      id = existing._id;
      await ctx.db.patch(id, { embedding: undefined, leaseToken, expiresAt });
    }
    await ctx.scheduler.runAt(expiresAt, internal.search.expireQueryEmbedding, {
      id,
    });
    return { status: "admitted", id, leaseToken };
  },
});

export const finishQueryEmbedding = internalMutation({
  args: {
    id: v.id("searchQueryEmbeddings"),
    leaseToken: v.string(),
    embedding: v.optional(v.array(v.float64())),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null || row.leaseToken !== args.leaseToken) return;
    if (args.embedding === undefined) {
      await ctx.db.delete(row._id);
      return;
    }
    const expiresAt = Date.now() + QUERY_CACHE_TTL_MS;
    await ctx.db.patch(row._id, { embedding: args.embedding, expiresAt });
    await ctx.scheduler.runAt(expiresAt, internal.search.expireQueryEmbedding, {
      id: row._id,
    });
  },
});

export const expireQueryEmbedding = internalMutation({
  args: { id: v.id("searchQueryEmbeddings") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row !== null && row.expiresAt <= Date.now())
      await ctx.db.delete(row._id);
  },
});

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly; no Convex runtime needed)
// ---------------------------------------------------------------------------

type EmbeddableProject = Pick<Doc<"projects">, "name" | "description" | "tags">;

/**
 * Build the single text blob embedded for a project: name + description +
 * tags + per-endpoint `METHOD path summary` lines from the latest published
 * OpenAPI doc. Unparseable specs degrade to name/desc/tags only.
 */
export function buildEmbedText(
  project: EmbeddableProject,
  specJson: string | null,
): string {
  const parts: string[] = [project.name];
  if (project.description !== undefined && project.description.length > 0) {
    parts.push(project.description);
  }
  parts.push(...project.tags);

  if (specJson !== null) {
    try {
      const spec = parseSpec(specJson);
      for (const [path, item] of Object.entries(spec.paths)) {
        if (item === undefined) continue;
        for (const [method, op] of Object.entries(item)) {
          if (op === undefined || Array.isArray(op)) continue;
          const summary =
            typeof op.summary === "string" && op.summary.length > 0
              ? op.summary
              : "";
          parts.push(`${method.toUpperCase()} ${path} ${summary}`.trim());
        }
      }
    } catch {
      // Malformed JSON — embed text still carries name/desc/tags.
    }
  }

  return parts
    .filter((p) => p.length > 0)
    .join(" ")
    .trim();
}

type GeminiEmbedResponse = {
  embedding?: { values?: number[] };
};

export type EmbedOptions = {
  apiKey?: string;
  /** Document text uses RETRIEVAL_DOCUMENT; query text uses RETRIEVAL_QUERY. */
  taskType?: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";
  /** Injectable for tests — no live Gemini in the suite. */
  fetchImpl?: typeof fetch;
};

/**
 * Call Gemini gemini-embedding-001 (pinned to 768 dims) and return the vector.
 * Throws on missing key, non-2xx, or malformed body — callers decide whether
 * that is fatal (embedProject, retried by scheduler) or degradable
 * (searchCatalogue, falls back to substring).
 */
export async function embedText(
  text: string,
  opts: EmbedOptions = {},
): Promise<number[]> {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("GEMINI_API_KEY is not configured");
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const taskType = opts.taskType ?? "RETRIEVAL_DOCUMENT";

  const res = await fetchImpl(`${GEMINI_EMBED_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: EMBED_DIMENSIONS,
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini embed failed (${res.status})`);
  }

  const body = (await res.json()) as GeminiEmbedResponse;
  const values = body.embedding?.values;
  if (
    !Array.isArray(values) ||
    values.length !== EMBED_DIMENSIONS ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Gemini embed returned no vector");
  }
  return values;
}

// ---------------------------------------------------------------------------
// Embedding pipeline
// ---------------------------------------------------------------------------

/** Load a project + its latest published spec body for embedding. */
export const getProjectForEmbed = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    name: string;
    description: string | undefined;
    tags: string[];
    specJson: string | null;
  } | null> => {
    const project = await ctx.db.get(args.projectId);
    if (project === null || (await isProjectRetired(ctx, project))) return null;
    const organization = await ctx.db.get(project.organizationId);
    if (
      organization === null ||
      !(await isOrganizationActive(ctx, organization))
    ) {
      return null;
    }

    const latest = await ctx.db
      .query("specVersions")
      .withIndex("by_project_published", (q) =>
        q.eq("projectId", args.projectId),
      )
      .order("desc")
      .first();

    if (latest === null || !isPublishedSurfaceAllowed(organization, latest)) {
      return null;
    }

    return {
      name: project.name,
      description: project.description,
      tags: project.tags,
      specJson: latest.spec,
    };
  },
});

/** Upsert the single specEmbeddings row for a project (one per project). */
export const upsertEmbedding = internalMutation({
  args: {
    projectId: v.id("projects"),
    text: v.string(),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query("specEmbeddings")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();

    const updatedAt = Date.now();
    if (existing === null) {
      await ctx.db.insert("specEmbeddings", {
        projectId: args.projectId,
        text: args.text,
        embedding: args.embedding,
        updatedAt,
      });
    } else {
      await ctx.db.patch(existing._id, {
        text: args.text,
        embedding: args.embedding,
        updatedAt,
      });
    }
  },
});

/**
 * Build + persist a project's embedding from its latest published spec.
 * Scheduled on publish (specs.publish) and by embedAllPublished backfill.
 * A Gemini failure throws here so Convex retries the scheduled function.
 */
export const embedProject = internalAction({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<void> => {
    const data = await ctx.runQuery(internal.search.getProjectForEmbed, {
      projectId: args.projectId,
    });
    if (data === null) return;

    const text = buildEmbedText(data, data.specJson);
    const embedding = await embedText(text, {
      taskType: "RETRIEVAL_DOCUMENT",
    });
    await ctx.runMutation(internal.search.upsertEmbedding, {
      projectId: args.projectId,
      text,
      embedding,
    });
  },
});

/** All published+public project ids — for backfill. */
export const listPublishedPublicProjects = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("projects")
      .withIndex("by_visibility_status", (q) =>
        q.eq("visibility", "public").eq("status", "published"),
      )
      .paginate({ cursor: args.cursor, numItems: 100, maximumRowsRead: 101 });
    return {
      ids: rows.page.map((row) => row._id),
      continueCursor: rows.continueCursor,
      isDone: rows.isDone,
    };
  },
});

/**
 * Backfill embeddings for every published+public project.
 * Run once via `npx convex run search:embedAllPublished`.
 */
export const embedAllPublished = internalAction({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args): Promise<{ scheduled: number }> => {
    const page = await ctx.runQuery(
      internal.search.listPublishedPublicProjects,
      { cursor: args.cursor ?? null },
    );
    for (const projectId of page.ids) {
      await ctx.scheduler.runAfter(0, internal.search.embedProject, {
        projectId,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.search.embedAllPublished, {
        cursor: page.continueCursor,
      });
    }
    return { scheduled: page.ids.length };
  },
});

// ---------------------------------------------------------------------------
// Search pipeline
// ---------------------------------------------------------------------------

/** Same card shape as catalogue.listPublic items, plus a relevance score. */
export type SearchListing = PublicListing & {
  /** Cosine similarity −1..1 from vectorSearch, or 0 when score missing. */
  score: number;
};

/**
 * Post-vectorSearch filter + shape. SECURITY GATE: every project must be
 * re-verified as PUBLIC + PUBLISHED here — a stale embedding row must never
 * surface a project that was later made private or reverted to draft.
 *
 * `ids` and `scores` are parallel arrays (same length, same order as the
 * vectorSearch result, which is already relevance-ranked). Output preserves
 * relevance order after exclusion, breaking ties with measured API quality.
 */
export const fetchSearchListings = internalQuery({
  args: {
    ids: v.array(v.id("specEmbeddings")),
    scores: v.array(v.float64()),
  },
  handler: async (ctx, args): Promise<SearchListing[]> => {
    if (
      args.ids.length !== args.scores.length ||
      args.ids.length > SEARCH_LIMIT_MAX
    ) {
      throw new Error("Invalid search result page");
    }
    const out: SearchListing[] = [];

    for (let i = 0; i < args.ids.length; i++) {
      const embeddingRow = await ctx.db.get(args.ids[i]);
      if (embeddingRow === null) continue;

      const project = await ctx.db.get(embeddingRow.projectId);
      if (project === null) continue;
      if (project.visibility !== "public") continue;
      if (project.status !== "published") continue;
      if (project.deprecationStartedAt !== undefined) continue;

      const org = await getActiveOrgById(ctx, project.organizationId);
      if (org === null) continue;
      if ((await getActivePublicRouteBinding(ctx, org, project)) === null) {
        continue;
      }
      if (org.publicHandle === undefined || org.publicHandle === "") continue;

      const latest = await ctx.db
        .query("specVersions")
        .withIndex("by_project_published", (q) =>
          q.eq("projectId", project._id),
        )
        .order("desc")
        .first();

      if (!isPublishedSurfaceAllowed(org, latest)) {
        continue;
      }

      const pricing =
        latest === null ? null : summarizePublishedPricing(latest.spec);
      const snapshot = await ctx.db
        .query("qualitySnapshots")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .unique();

      out.push({
        name: project.name,
        slug: project.slug,
        description: project.description,
        tags: project.tags,
        orgName: org.name,
        publisherHandle: org.publicHandle,
        publishedAt: latest?.publishedAt ?? null,
        pricing,
        quality:
          snapshot === null ||
          latest === null ||
          snapshot.specVersionId !== latest._id
            ? null
            : qualitySnapshotContract(snapshot),
        score: args.scores[i] ?? 0,
      });
    }

    return out.sort(compareSearchListings);
  },
});

/** Relevance first; fresh, sufficient gateway measurements break exact ties. */
export function compareSearchListings(
  a: SearchListing,
  b: SearchListing,
): number {
  const measured = (item: SearchListing) => {
    const q = item.quality;
    return q !== null &&
      !q.insufficientApiData &&
      q.freshness.status === "fresh"
      ? q
      : null;
  };
  const aq = measured(a);
  const bq = measured(b);
  return (
    b.score - a.score ||
    (bq?.apiSuccessRatePercent ?? -1) - (aq?.apiSuccessRatePercent ?? -1) ||
    (aq?.apiLatencyP50Ms ?? Number.MAX_VALUE) -
      (bq?.apiLatencyP50Ms ?? Number.MAX_VALUE) ||
    a.publisherHandle.localeCompare(b.publisherHandle) ||
    a.slug.localeCompare(b.slug)
  );
}

export type SearchCatalogueResult = {
  items: SearchListing[];
  /** True when limited, already embedding, or Gemini failed; use keyword fallback. */
  degraded: boolean;
};

/**
 * Public semantic search over the catalogue. Embeds the query (Gemini), runs
 * vector search on by_embedding, then re-filters to PUBLIC + PUBLISHED only.
 * A Gemini failure (missing key, non-2xx) returns { items: [], degraded: true }
 * without ever reaching vectorSearch — callers must fall back to substring.
 */
export const searchCatalogue = action({
  args: { query: v.string(), limit: v.optional(v.number()) },
  handler: (ctx, args): Promise<SearchCatalogueResult> =>
    searchCatalogueForCaller(ctx, args),
});

/** Only the secret-authenticated gateway HTTP route can supply caller attribution. */
export const searchCatalogueForGateway = internalAction({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    gatewayCaller: v.optional(gatewayCaller),
  },
  handler: (ctx, args): Promise<SearchCatalogueResult> =>
    searchCatalogueForCaller(ctx, args),
});

async function searchCatalogueForCaller(
  ctx: ActionCtx,
  args: { query: string; limit?: number; gatewayCaller?: GatewayCaller },
): Promise<SearchCatalogueResult> {
  const trimmed = args.query.trim().slice(0, 200);
  if (trimmed.length === 0) {
    return { items: [], degraded: false };
  }

  const requestedLimit = args.limit ?? SEARCH_LIMIT_DEFAULT;
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), SEARCH_LIMIT_MAX)
    : SEARCH_LIMIT_DEFAULT;

  const admission = await ctx.runMutation(
    internal.search.prepareQueryEmbedding,
    { query: trimmed, gatewayCaller: args.gatewayCaller },
  );
  if (admission.status === "limited" || admission.status === "pending") {
    return { items: [], degraded: true };
  }
  let queryEmbedding: number[];
  if (admission.status === "cached") {
    queryEmbedding = admission.embedding;
  } else {
    try {
      queryEmbedding = await embedText(trimmed, {
        taskType: "RETRIEVAL_QUERY",
      });
    } catch {
      await ctx.runMutation(internal.search.finishQueryEmbedding, {
        id: admission.id,
        leaseToken: admission.leaseToken,
      });
      return { items: [], degraded: true };
    }
    await ctx.runMutation(internal.search.finishQueryEmbedding, {
      id: admission.id,
      leaseToken: admission.leaseToken,
      embedding: queryEmbedding,
    });
  }

  const results = await ctx.vectorSearch("specEmbeddings", "by_embedding", {
    vector: queryEmbedding,
    limit: SEARCH_LIMIT_MAX,
  });

  const items = await ctx.runQuery(internal.search.fetchSearchListings, {
    ids: results.map((r) => r._id),
    scores: results.map((r) => r._score),
  });

  return { items: items.slice(0, limit), degraded: false };
}
