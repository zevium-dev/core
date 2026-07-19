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
import { parseSpec } from "@zevium/shared";
import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { summarizePublishedPricing, type PublicListing } from "./catalogue";

/** Max results returned by a semantic search (VectorSearchQuery.limit caps at 256). */
const SEARCH_LIMIT_MAX = 20;
const SEARCH_LIMIT_DEFAULT = 10;

/**
 * Gemini embedContent endpoint. We use `gemini-embedding-001` pinned to
 * `outputDimensionality: 768` to match the pre-existing `by_embedding`
 * vectorIndex (768 dims). `text-embedding-004` (also 768-dim) was removed
 * from the v1beta API (HTTP 404); this is the current 768-dim replacement.
 */
const GEMINI_EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";
/** Must match the `by_embedding` vectorIndex dimensions in schema.ts. */
const EMBED_DIMENSIONS = 768;

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
          if (op === undefined) continue;
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
  if (!Array.isArray(values) || values.length === 0) {
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
    if (project === null) return null;

    const latest = await ctx.db
      .query("specVersions")
      .withIndex("by_project_published", (q) =>
        q.eq("projectId", args.projectId),
      )
      .order("desc")
      .first();

    return {
      name: project.name,
      description: project.description,
      tags: project.tags,
      specJson: latest === null ? null : latest.spec,
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
  args: {},
  handler: async (ctx): Promise<Id<"projects">[]> => {
    const rows = await ctx.db
      .query("projects")
      .withIndex("by_visibility_status", (q) =>
        q.eq("visibility", "public").eq("status", "published"),
      )
      .collect();
    return rows.map((r) => r._id);
  },
});

/**
 * Backfill embeddings for every published+public project.
 * Run once via `npx convex run search:embedAllPublished`.
 */
export const embedAllPublished = internalAction({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const projectIds = await ctx.runQuery(
      internal.search.listPublishedPublicProjects,
      {},
    );
    for (const projectId of projectIds) {
      await ctx.scheduler.runAfter(0, internal.search.embedProject, {
        projectId,
      });
    }
    return { scheduled: projectIds.length };
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
 * that order after exclusion.
 */
export const fetchSearchListings = internalQuery({
  args: {
    ids: v.array(v.id("specEmbeddings")),
    scores: v.array(v.float64()),
  },
  handler: async (ctx, args): Promise<SearchListing[]> => {
    const out: SearchListing[] = [];

    for (let i = 0; i < args.ids.length; i++) {
      const embeddingRow = await ctx.db.get(args.ids[i]);
      if (embeddingRow === null) continue;

      const project = await ctx.db.get(embeddingRow.projectId);
      if (project === null) continue;
      if (project.visibility !== "public") continue;
      if (project.status !== "published") continue;

      const org = await ctx.db.get(project.organizationId);
      if (org === null) continue;
      if (org.publicHandle === undefined || org.publicHandle === "") continue;

      const latest = await ctx.db
        .query("specVersions")
        .withIndex("by_project_published", (q) =>
          q.eq("projectId", project._id),
        )
        .order("desc")
        .first();

      const pricing =
        latest === null ? null : summarizePublishedPricing(latest.spec);

      out.push({
        projectId: project._id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        tags: project.tags,
        organizationId: org._id,
        orgName: org.name,
        publisherHandle: org.publicHandle,
        publishedAt: latest?.publishedAt ?? null,
        pricing,
        score: args.scores[i] ?? 0,
      });
    }

    return out;
  },
});

export type SearchCatalogueResult = {
  items: SearchListing[];
  /** True when Gemini failed — caller falls back to substring silently. */
  degraded: boolean;
};

/**
 * Public semantic search over the catalogue. Embeds the query (Gemini), runs
 * vector search on by_embedding, then re-filters to PUBLIC + PUBLISHED only.
 * A Gemini failure (missing key, non-2xx) returns { items: [], degraded: true }
 * without ever reaching vectorSearch — callers must fall back to substring.
 */
export const searchCatalogue = action({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SearchCatalogueResult> => {
    const trimmed = args.query.trim();
    if (trimmed.length === 0) {
      return { items: [], degraded: false };
    }

    const limit = Math.min(
      Math.max(args.limit === undefined ? SEARCH_LIMIT_DEFAULT : args.limit, 1),
      SEARCH_LIMIT_MAX,
    );

    let queryEmbedding: number[];
    try {
      queryEmbedding = await embedText(trimmed, {
        taskType: "RETRIEVAL_QUERY",
      });
    } catch {
      // Gemini down / unconfigured — degrade gracefully, never throw to client.
      return { items: [], degraded: true };
    }

    const results = await ctx.vectorSearch("specEmbeddings", "by_embedding", {
      vector: queryEmbedding,
      limit,
    });

    const items = await ctx.runQuery(internal.search.fetchSearchListings, {
      ids: results.map((r) => r._id),
      scores: results.map((r) => r._score),
    });

    return { items, degraded: false };
  },
});
