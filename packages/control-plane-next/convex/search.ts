import { listing } from "./lib/catalogue";
import { extractPricing, parseSpec, sha256Hex } from "@zevium/shared";
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
import { type PublicListing } from "./catalogue";
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
    shards: 16,
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
  args: {
    query: v.string(),
    gatewayCaller: v.optional(gatewayCaller),
    trustedAnonymousKey: v.optional(v.string()),
  },
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
          ? args.trustedAnonymousKey
            ? await searchRateLimiter.limit(ctx, "anonymousSearch", {
                key: args.trustedAnonymousKey,
              })
            : { ok: false }
          : await searchRateLimiter.limit(ctx, "signedInSearch", {
              key: identity.tokenIdentifier,
            });
      if (!caller.ok) return { status: "limited" };
    }

    const cacheKey = await sha256Hex(
      args.query.trim().toLowerCase().replace(/\s+/g, " "),
    );
    const existing = await ctx.db
      .query("searchQueryEmbeddings")
      .withIndex("by_query", (q) =>
        q.eq("model", "gemini-embedding-001").eq("queryHash", cacheKey),
      )
      .unique();
    if (existing && existing.expiresAt > Date.now()) {
      return existing.embedding.length === 0
        ? { status: "pending" }
        : { status: "cached", embedding: existing.embedding };
    }
    const budget = await searchRateLimiter.limit(ctx, "searchBudget");
    if (!budget.ok) return { status: "limited" };
    const leaseToken = crypto.randomUUID();
    const expiresAt = Date.now() + QUERY_EMBED_LEASE_MS;
    let id;
    if (existing === null) {
      id = await ctx.db.insert("searchQueryEmbeddings", {
        model: "gemini-embedding-001",
        queryHash: cacheKey,
        embedding: [],
        leaseToken,
        expiresAt,
      });
    } else {
      id = existing._id;
      await ctx.db.patch(id, { embedding: [], leaseToken, expiresAt });
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
    if (!row || row.leaseToken !== args.leaseToken) return;
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
    if (row && row.expiresAt <= Date.now()) await ctx.db.delete(row._id);
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
          if (extractPricing(op) === null) continue;
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

export const getProjectForEmbed = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project?.latestVersionId || !(await listing(ctx, project)))
      return null;
    const version = await ctx.db.get(project.latestVersionId);
    return version
      ? {
          name: project.name,
          description: project.description,
          tags: project.tags,
          specJson: version.spec,
          specVersionId: version._id,
          revision: project.revision,
        }
      : null;
  },
});
export const upsertEmbedding = internalMutation({
  args: {
    projectId: v.id("projects"),
    specVersionId: v.id("specVersions"),
    revision: v.number(),
    text: v.string(),
    embedding: v.array(v.number()),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (
      !project ||
      project.revision !== args.revision ||
      project.latestVersionId !== args.specVersionId ||
      !(await listing(ctx, project))
    )
      return;
    if (
      args.embedding.length !== 768 ||
      args.embedding.some((n) => !Number.isFinite(n))
    )
      throw new Error("Invalid embedding");
    const existing = await ctx.db
      .query("specEmbeddings")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    const value = {
      kind: "listing" as const,
      model: "gemini-embedding-001",
      dimensions: 768 as const,
      contentHash: await sha256Hex(args.text),
      projectId: args.projectId,
      specVersionId: args.specVersionId,
      text: args.text,
      embedding: args.embedding,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.replace(existing._id, value);
    else await ctx.db.insert("specEmbeddings", value);
  },
});
export const embedProject = internalAction({
  args: { projectId: v.id("projects"), attempt: v.optional(v.number()) },
  handler: async (ctx, args): Promise<void> => {
    if (!process.env.GEMINI_API_KEY) return;
    const data = await ctx.runQuery(internal.search.getProjectForEmbed, {
      projectId: args.projectId,
    });
    if (!data) return;
    try {
      const text = buildEmbedText(data, data.specJson),
        embedding = await embedText(text);
      await ctx.runMutation(internal.search.upsertEmbedding, {
        projectId: args.projectId,
        specVersionId: data.specVersionId,
        revision: data.revision,
        text,
        embedding,
      });
    } catch {
      if ((args.attempt ?? 0) < 4)
        await ctx.scheduler.runAfter(
          60000 * 2 ** (args.attempt ?? 0),
          internal.search.embedProject,
          { projectId: args.projectId, attempt: (args.attempt ?? 0) + 1 },
        );
    }
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
      if (embeddingRow?.kind !== "listing") continue;
      const project = await ctx.db.get(embeddingRow.projectId);
      if (!project || project.latestVersionId !== embeddingRow.specVersionId)
        continue;
      const item = await listing(ctx, project);
      if (item) out.push({ ...item, score: args.scores[i] ?? 0 });
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
    trustedAnonymousKey: v.optional(v.string()),
  },
  handler: (ctx, args): Promise<SearchCatalogueResult> =>
    searchCatalogueForCaller(ctx, args),
});

async function searchCatalogueForCaller(
  ctx: ActionCtx,
  args: {
    query: string;
    limit?: number;
    gatewayCaller?: GatewayCaller;
    trustedAnonymousKey?: string;
  },
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
    {
      query: trimmed,
      gatewayCaller: args.gatewayCaller,
      trustedAnonymousKey: args.trustedAnonymousKey,
    },
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
    filter: (q) => q.eq("kind", "listing"),
    limit: SEARCH_LIMIT_MAX,
  });

  const items = await ctx.runQuery(internal.search.fetchSearchListings, {
    ids: results.map((r) => r._id),
    scores: results.map((r) => r._score),
  });

  return { items: items.slice(0, limit), degraded: false };
}
