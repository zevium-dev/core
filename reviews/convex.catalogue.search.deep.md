# Tiger-Style Deep Review — `convex/catalogue.ts` + `convex/search.ts`

Joint deep-dive of the public catalogue listing (`catalogue.listPublic`,
`catalogue.getPublicDetail`, `summarizePublishedPricing`) and the semantic
search pipeline (`search.searchCatalogue`, the embed pipeline, and
`fetchSearchListings`). Cross-checked against `convex/schema.ts`,
`convex/specs.ts`, `convex/admin.ts`, `convex/projects.ts`, `convex/lib/auth.ts`,
`packages/shared/src/openapi.ts`, and both test files. Prior reviews
(catalogue: 2 P1 + 5 P2; search: 1 P1 + 6 P2) were verified and expanded.

## Verdict

**Incorrect — multiple P1 defects.** The core happy path is sound: model is
`gemini-embedding-001` (not the dead `text-embedding-004`), `outputDimensionality:
768` is set, `taskType` is `RETRIEVAL_DOCUMENT` for indexing vs
`RETRIEVAL_QUERY` for search, draft/private projects are filtered at both the
catalogue and search layers, and Gemini failure degrades silently. But the
public search action is an **unauthenticated, uncached, unthrottled paid-API
trigger**; the Gemini key rides in a URL query string; stale/orphaned
`specEmbeddings` rows accumulate across three separate visibility/delete
call sites with no cleanup, silently degrading search recall to zero as the
catalogue churns; `listPublic` does a redundant unbounded `.collect()` plus a
second `.take(1000)` on the same index on every page load; and a silent
Gemini dimension regression wedges `embedProject` in an infinite retry loop.

## File Stats

- `convex/catalogue.ts` (326 lines): `summarizePublishedPricing`,
  `parseSort`, `listPublic`, `getPublicDetail`.
- `convex/search.ts` (384 lines): `buildEmbedText`, `embedText`,
  `getProjectForEmbed`, `upsertEmbedding`, `embedProject`,
  `listPublishedPublicProjects`, `embedAllPublished`, `fetchSearchListings`,
  `searchCatalogue`.
- `convex/catalogue.test.ts` (357 lines), `convex/search.test.ts` (416 lines).
- Headline contract verification (all confirmed against source):
  - Model `gemini-embedding-001` ✅ (`search.ts:51-54`, URL at `:55-56`).
  - `outputDimensionality: 768` ✅ (`search.ts:119`, `EMBED_DIMENSIONS` at `:58`).
  - `taskType`: `RETRIEVAL_DOCUMENT` for `embedProject` ✅ (`search.ts:215`);
    `RETRIEVAL_QUERY` for `searchCatalogue` ✅ (`search.ts:362`).
  - Degraded path on Gemini failure ✅ (partial — see P2 #5).
  - Draft/private exclusion: `listPublic` index `by_visibility_status` ✅
    (`catalogue.ts:127-129`); `getPublicDetail` re-checks ✅ (`catalogue.ts:286`);
    `fetchSearchListings` re-checks ✅ (`search.ts:297-298`).
  - `specEmbeddings.by_embedding` vectorIndex is 768-dim ✅ (`schema.ts`).
  - Schema comment "Gemini text-embedding-004" is a stale lie (see P3 #18).

## Findings

---

### [SEV: P1] Gemini API key passed in URL query string

**Location** — `convex/search.ts:113` (`embedText`)

```ts
const res = await fetchImpl(`${GEMINI_EMBED_URL}?key=${apiKey}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ... }),
});
```

**Problem** — The production Gemini key is interpolated into the request URL
as a query parameter. Outgoing fetch URLs are routinely captured by HTTP
clients, egress/proxy logs, APM/OTel telemetry, Convex action logs, and any
error reporter that serializes the request. Each of those is a credential-
leak surface. The Gemini `generativelanguage` API equally accepts the key via
the `x-goog-api-key` header, which keeps the secret out of URLs entirely.

**Impact** — Latent credential exposure; any URL-logging layer leaks the
production Gemini key. Single most exploitable defect in the file.

**Fix** —

```ts
const res = await fetchImpl(GEMINI_EMBED_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  },
  body: JSON.stringify({
    content: { parts: [{ text }] },
    taskType,
    outputDimensionality: EMBED_DIMENSIONS,
  }),
});
```

---

### [SEV: P1] `searchCatalogue` is an unauthenticated, uncached, unthrottled paid-API trigger

**Location** — `convex/search.ts:345-386` (`searchCatalogue`)

```ts
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
    const limit = Math.min(Math.max(... args.limit ..., 1), SEARCH_LIMIT_MAX);

    let queryEmbedding: number[];
    try {
      queryEmbedding = await embedText(trimmed, {
        taskType: "RETRIEVAL_QUERY",
      });
    } catch {
      return { items: [], degraded: true };
    }
    const results = await ctx.vectorSearch("specEmbeddings", "by_embedding", {
      vector: queryEmbedding,
      limit,
    });
    ...
  },
});
```

**Problem** — `searchCatalogue` is a top-level `action` (not `internalAction`),
so it is reachable by any client with the Convex deployment URL — no Clerk
session, no org membership, no per-IP throttle, no per-query cache, no
deduplication of concurrent identical queries. Every single call issues a
paid `gemini-embedding-001` `embedContent` request to Google. There is no
length cap on `args.query` (`v.string()`), no rate limit, no short-TTL cache
key on the hashed query string. An attacker (or a buggy/looping client) can
spray arbitrary queries at the endpoint and run up Gemini billings / exhaust
the per-key RPM quota, which then degrades search for every legitimate user
(`degraded: true` for everyone until the quota resets).

Contrast with `catalogue.listPublic` / `getPublicDetail`: those are pure DB
reads Convex rate-limits per connection; `searchCatalogue` is the only public
function that triggers an external paid call per request.

**Impact** — Direct cost-abuse / denial-of-wallet vector against the
production Gemini key, with a side effect of starving legitimate search
traffic when the quota is exhausted.

**Fix** — Layered: (a) bound `args.query` length (e.g. `v.string()` + a
`trim().length <= 512` guard returning `{ items: [], degraded: false }`);
(b) cache query embeddings by `hash(trimmed)` for a short TTL (Convex table
or KV) so repeated identical queries cost one Gemini call; (c) add a
per-IP / per-session rate limit (Convex `rateLimit` helper or a
`querySearchRateLimit` table) before calling `embedText`; (d) consider
making `searchCatalogue` require a Clerk session if the catalogue search is
gated anyway.

---

### [SEV: P1] Stale / orphaned `specEmbeddings` rows never cleaned up across three call sites → search recall collapses to zero

**Location** — `convex/admin.ts:229` (`setProjectVisibility`),
`convex/projects.ts:151-153,186-188` (`update` when `visibility` flips),
`convex/projects.ts:204-226` (`remove`), vs. `convex/search.ts:283-340`
(`fetchSearchListings`).

**Problem** — `fetchSearchListings` correctly re-checks `visibility ===
"public"` && `status === "published"` per result, so private/draft/deleted
projects never *leak* into cards — the security invariant holds. But nothing
ever *deletes* the `specEmbeddings` row when a project leaves the
public+published set:

1. `admin.setProjectVisibility` patches `visibility` and fires a webhook +
   notification, but schedules **no** embedding cleanup.
2. `projects.update` patches `visibility` (and `name`/`description`/`tags`
   that the embed text is built from) with **no** embedding rebuild and no
   cleanup. So renaming a published public project leaves the embedding
   referencing the old name forever — search-by-name silently breaks.
3. `projects.remove` deletes the project, draft, and all `specVersions`, but
   leaves the `specEmbeddings` row orphaned (its `projectId` now points at a
   deleted doc).

`searchCatalogue` requests `limit` (default 10, max 20) results from
`vectorSearch`. If those `limit` slots are filled with stale private/draft/orphaned
ids, `fetchSearchListings` filters them all out and returns `[]` — even when
20 valid public projects exist. There is no over-fetch to compensate. As the
catalogue churns (projects deleted, flipped private, renamed), the stale ratio
in the vector index grows monotonically and recall collapses toward zero.

**Impact** — Silent, monotonic search-recall degradation proportional to
catalogue churn. No correctness leak, but the feature becomes useless well
before any operator signal. The `projects.update` name-change case is the
nastiest: a public, published project that is merely renamed becomes
un-searchable by its new name with no visibility flip to alert on.

**Fix** — Schedule a cleanup from each flip site, plus rebuild on metadata
change:

- `admin.setProjectVisibility`: if flipping to `private`, schedule a mutation
  that deletes the `specEmbeddings` row (`by_project` unique).
- `projects.update`: if `visibility` flips to `private`, delete the row; if
  `name`/`description`/`tags` change on a public+published project, schedule
  `embedProject` to rebuild the text + vector.
- `projects.remove`: delete the `specEmbeddings` row before/after deleting
  the project.
- Defense-in-depth: over-fetch in `searchCatalogue` (e.g. `Math.min(limit *
  3, 256)`) and slice to `limit` after `fetchSearchListings` filters, so a
  bounded stale ratio does not zero out results.

---

### [SEV: P2] `listPublic` does two full index scans of the same data on every page load

**Location** — `convex/catalogue.ts:126-142` (`listPublic`)

```ts
const candidates = await ctx.db
  .query("projects")
  .withIndex("by_visibility_status", (q) =>
    q.eq("visibility", "public").eq("status", "published"),
  )
  .collect();

// Total public+published count, decoupled from search/tag/price filtering
// below ... Bounded at 1000 docs ...
const totalDocs = await ctx.db
  .query("projects")
  .withIndex("by_visibility_status", (q) =>
    q.eq("visibility", "public").eq("status", "published"),
  )
  .take(1000);
const total = totalDocs.length;
```

**Problem** — The handler issues the *same* `by_visibility_status`
(`public`+`published`) index scan twice: once unbounded via `.collect()` into
`candidates`, and again via `.take(1000)` into `totalDocs` solely to compute
`total`. `total` is `Math.min(candidates.length, 1000)` for free — the second
scan is pure waste. Every catalogue page load (landing + every pagination
cursor) pays double the reads.

**Impact** — 2× the indexed reads on the hottest public read path for zero
informational gain. Becomes meaningful as the catalogue grows.

**Fix** —

```ts
const candidates = await ctx.db
  .query("projects")
  .withIndex("by_visibility_status", (q) =>
    q.eq("visibility", "public").eq("status", "published"),
  )
  .collect();
const total = Math.min(candidates.length, 1000);
```

(And drop the misleading "Bounded at 1000 docs" comment from the return type
— `candidates` is unbounded, only `total` is capped.)

---

### [SEV: P2] `listPublic` `.collect()` is unbounded; in-memory filter + sort + offset pagination is O(N) per page

**Location** — `convex/catalogue.ts:126-235` (`listPublic`)

**Problem** — The handler `.collect()`s every public+published project (no
cap), then filters by `tag`/`search`/`hasFreeTier`/`maxCost` in memory, then
sorts in memory, then `.slice(start, start + PAGE_SIZE)`. Each of those
steps is O(N) over the full catalogue, and every paginated cursor re-runs the
whole pipeline. The comment "Public catalogue is still small" punts the
scaling problem with no guardrail:

- Memory: `candidates` holds every project doc plus, per project, one
  `organizations` `db.get`, one `specVersions` indexed query, and a
  `summarizePublishedPricing` parse of the full spec JSON. On a catalogue
  with thousands of projects and large OpenAPI specs, this is multi-MB per
  request and per cursor page.
- Latency: deep pages re-scan + re-sort the entire filtered set, so page 50
  costs the same as page 1 plus an offset slice.
- DoS: a public, unauthenticated query; an attacker hitting
  `listPublic({ cursor: "999999" })` in a loop still forces the full
  `.collect()` + filter + sort each time.

**Impact** — Latency and memory blow up linearly with catalogue size on the
hottest public read path; unauthenticated abuse surface.

**Fix** — Move filtering into the index where possible (a `searchIndex` on
`tags` for the `tag` filter; push `search` to the vector pipeline —
`searchCatalogue` already exists). Cap `candidates` with `.take(N)` (e.g.
1000) and document the cap in the return type. For sort-by-`name`/`cheapest`,
consider dedicated indexes. At minimum, short-circuit the per-project
`specVersions` query + `summarizePublishedPricing` parse until *after* the
slice, so only `PAGE_SIZE` specs are parsed instead of `N`.

---

### [SEV: P2] Returned embedding dimension is never validated against `EMBED_DIMENSIONS`

**Location** — `convex/search.ts:135-141` (`embedText`)

```ts
const body = (await res.json()) as GeminiEmbedResponse;
const values = body.embedding?.values;
if (!Array.isArray(values) || values.length === 0) {
  throw new Error("Gemini embed returned no vector");
}
return values;
```

**Problem** — `embedText` only checks `values` is a non-empty array; it never
asserts `values.length === EMBED_DIMENSIONS` (768). The whole file is pinned
on 768 to match the `by_embedding` vectorIndex (comment at `:57-58`). If
Gemini ever returns the default 3072-dim vector (API revision,
`outputDimensionality` silently ignored for a new model version, or a
malformed response), the bad vector flows downstream:

- `embedProject` → `upsertEmbedding` → Convex rejects the write because the
  vectorIndex declares 768 dims → the scheduled action throws → Convex
  retries the scheduled function indefinitely (no permanent-failure escape,
  see P2 #9). The project's embedding is stuck forever.
- `searchCatalogue` → `ctx.vectorSearch` with a 3072-dim query vector against
  a 768-dim index throws — and that throw is **outside** the `try/catch`
  around `embedText` (see P2 #7), so it surfaces to the client instead of
  degrading.

**Impact** — A silent Gemini dimension regression wedges `embedProject` in
an infinite retry loop and breaks `searchCatalogue` with an uncaught throw.

**Fix** —

```ts
if (!Array.isArray(values) || values.length !== EMBED_DIMENSIONS) {
  throw new Error(
    `Gemini embed returned ${Array.isArray(values) ? values.length : "non-array"} dims, expected ${EMBED_DIMENSIONS}`,
  );
}
return values;
```

---

### [SEV: P2] `searchCatalogue` "never throw to client" contract is broken for `vectorSearch` / `fetchSearchListings` failures

**Location** — `convex/search.ts:357-385` (`searchCatalogue`)

```ts
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
```

**Problem** — The degrade-to-empty contract is applied only to `embedText`.
`ctx.vectorSearch` and `ctx.runQuery(fetchSearchListings)` are both outside
the guard. The doc comment claims "A Gemini failure ... returns degraded
without ever reaching vectorSearch" — true for Gemini failures, but
`vectorSearch` itself can throw (dimension mismatch from P2 #6, transient
Convex vector-index errors), as can `fetchSearchListings`. Any of those
propagates as an uncaught exception to the catalogue UI, which the action
explicitly promises not to do.

**Impact** — A transient vector-index error or a dimension regression breaks
the catalogue search page with a thrown error instead of the documented
silent substring fallback.

**Fix** — Wrap the post-embed pipeline in the same degrade guard:

```ts
try {
  const results = await ctx.vectorSearch("specEmbeddings", "by_embedding", {
    vector: queryEmbedding,
    limit,
  });
  const items = await ctx.runQuery(internal.search.fetchSearchListings, {
    ids: results.map((r) => r._id),
    scores: results.map((r) => r._score),
  });
  return { items, degraded: false };
} catch {
  return { items: [], degraded: true };
}
```

---

### [SEV: P2] `embedAllPublished` schedules every project's embed at `t=0` — thundering herd, no rate-limit handling

**Location** — `convex/search.ts:248-262` (`embedAllPublished`)

```ts
for (const projectId of projectIds) {
  await ctx.scheduler.runAfter(0, internal.search.embedProject, {
    projectId,
  });
}
return { scheduled: projectIds.length };
```

**Problem** — Every published+public project is scheduled with `runAfter(0,
…)`, so all embeds fire simultaneously. Each `embedProject` issues one Gemini
`embedContent` call. Gemini enforces per-key RPM limits; a backfill over N
projects at once trips 429s. There is no jitter, no staggering, no batching
(`batchEmbedContents` exists), and no 429/5xx retry/backoff in `embedText` —
a 429 throws, `embedProject` throws, and Convex retries the scheduled
function (with backoff) but with no awareness that the failure was a rate
limit applying to the whole batch, so the retry storm continues.

**Impact** — Backfill over more than a handful of projects rate-limits and
partially fails; some projects' embeddings never land (scheduler retries
exhaust).

**Fix** — Stagger the schedules and/or batch:

```ts
for (let i = 0; i < projectIds.length; i++) {
  await ctx.scheduler.runAfter(i, internal.search.embedProject, {
    projectId: projectIds[i],
  });
}
```

Plus bounded retry/backoff in `embedText` for 429/5xx (transient) vs 400
(permanent — do not retry, see P2 #9).

---

### [SEV: P2] No empty-text guard in `embedProject`

**Location** — `convex/search.ts:213-226` (`embedProject`) + `buildEmbedText`

```ts
const text = buildEmbedText(data, data.specJson);
const embedding = await embedText(text, {
  taskType: "RETRIEVAL_DOCUMENT",
});
```

**Problem** — `buildEmbedText` can return `""`: a project with empty `name`
(`v.string()` has no min length), empty/undefined description, no tags, and
either no published spec or an unparseable spec returns `""` after the
`.filter((p) => p.length > 0).join(" ").trim()` at `:78-81`. `embedText("")`
then calls Gemini with `content.parts[0].text = ""`, which Gemini rejects
with HTTP 400. `embedProject` throws, the scheduler retries — forever, because
the input never changes (see P2 #9). The search path trims and short-circuits
empty queries; the embed path does not.

**Impact** — A degenerate-but-valid project record wedges `embedProject` in
an infinite retry loop and never produces an embedding.

**Fix** —

```ts
const text = buildEmbedText(data, data.specJson);
if (text.length === 0) return;
const embedding = await embedText(text, { taskType: "RETRIEVAL_DOCUMENT" });
```

---

### [SEV: P2] No input-size cap on embedded text — oversized specs wedge `embedProject`

**Location** — `convex/search.ts:30-72` (`buildEmbedText`) + `embedText`

**Problem** — `buildEmbedText` concatenates the project name, description,
tags, and one `METHOD path summary` line per endpoint of the latest
published OpenAPI spec. A large spec (hundreds/thousands of endpoints, long
summaries) produces a text blob that exceeds `gemini-embedding-001`'s input
token limit (~2048 input tokens for `taskType: RETRIEVAL_DOCUMENT` is the
common guidance, the actual cap is model-dependent). Gemini returns HTTP 400,
`embedText` throws, `embedProject` retries indefinitely (input never changes).
`searchCatalogue` is unaffected because query text is user-typed and short,
but the same P1 #2 attack surface means an attacker could pass a 1MB `query`
string straight to Gemini (bandwidth + cost) before the 400 degrades.

**Impact** — A publisher with a large OpenAPI spec wedges their own
embedding in an unrecoverable retry loop; the project never becomes
searchable. Combined with P1 #2, an attacker can push oversized queries to
Gemini.

**Fix** — Truncate the embedded text to a safe character/token budget before
calling `embedText` (cap total length and/or endpoint-line count), cap
`searchCatalogue`'s `args.query` length, and distinguish 400 (permanent — do
not retry) from 429/5xx (transient — retry) inside `embedText` (P2 #9).

---

### [SEV: P2] `embedText` does not distinguish transient (429/5xx) from permanent (400) failures — `embedProject` retries forever on permanent errors

**Location** — `convex/search.ts:123-125` (`embedText`)

```ts
if (!res.ok) {
  throw new Error(`Gemini embed failed (${res.status})`);
}
```

**Problem** — Every non-2xx is thrown identically. `embedProject`'s contract
is "A Gemini failure throws here so Convex retries the scheduled function"
(file comment `:208`). For 429/5xx that is correct; for 400 (bad input —
empty text from P2 #8, oversized text from P2 #9, malformed request) the
input never changes between retries, so the scheduler retries a
permanently-failing call indefinitely. Combined with P2 #6, P2 #8, P2 #9, a
single bad project record produces an unbounded stream of failed scheduled
runs with no operator signal.

**Impact** — Wasted scheduler capacity; noisy permanent failures that never
self-heal; the project is never searchable and the operator gets no signal.

**Fix** — Tag permanent vs transient and let `embedProject` choose not to
retry on permanent:

```ts
if (!res.ok) {
  const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
  throw new Error(
    `Gemini embed failed (${res.status})${permanent ? " [permanent]" : ""}`,
  );
}
```

…and have `embedProject` catch `[permanent]` errors, log, and return (not
throw).

---

### [SEV: P3] `fetchSearchListings` N+1 db round-trips (bounded by `limit=20`)

**Location** — `convex/search.ts:312-360` (`fetchSearchListings`)

**Problem** — Per result: 1 `db.get(embeddingRow)` + 1 `db.get(project)` + 1
`db.get(org)` + 1 `specVersions` indexed query + 1 `summarizePublishedPricing`
parse = ~4 db round-trips + a JSON parse. At `limit=20` that's ~80 sequential
round-trips per search on the hot path. Bounded, so not a correctness defect,
but it is the hot path for every catalogue search.

**Impact** — Latency on the public search path; not a correctness issue.

**Fix** — Batch-fetch projects and orgs via indexed queries over the
candidate ids rather than per-row `db.get`; defer `summarizePublishedPricing`
to the caller if the card doesn't strictly need pricing.

---

### [SEV: P3] `searchCatalogue` accepts fractional `limit`; `vectorSearch` expects an integer

**Location** — `convex/search.ts:359-363`

```ts
const limit = Math.min(
  Math.max(args.limit === undefined ? SEARCH_LIMIT_DEFAULT : args.limit, 1),
  SEARCH_LIMIT_MAX,
);
```

**Problem** — `args.limit` is `v.optional(v.number())`, which permits floats.
`Math.max(1.5, 1)` → `1.5`, passed straight to `ctx.vectorSearch({ limit })`.
Convex `vectorSearch` `limit` is an integer; a float either throws or is
silently coerced depending on runtime.

**Impact** — Unpredictable behavior if a caller passes a float; no observed
caller does today.

**Fix** — `Math.trunc(...)` after clamping, or coerce with `| 0`.

---

### [SEV: P3] `fetchSearchListings` does not enforce `ids.length === scores.length`

**Location** — `convex/search.ts:304-310`

**Problem** — Parallel-array contract is implicit. The only caller
(`searchCatalogue`) builds both arrays from the same `results` array, so
they are equal length in practice — but nothing enforces it. A mismatched
caller would silently pair the wrong score with the wrong id (the loop
indexes both by `i` and uses `args.scores[i] ?? 0`).

**Impact** — No current caller misbehaves; fragile against future callers.

**Fix** — Runtime guard at the top of the handler:
`if (args.ids.length !== args.scores.length) throw new Error(...)`.

---

### [SEV: P3] `getProjectForEmbed` / `fetchSearchListings` / `listPublic` all pick latest-by-`publishedAt` regardless of `deprecatedAt`

**Location** — `convex/search.ts:163-184` (`getProjectForEmbed`),
`convex/search.ts:319-324` (`fetchSearchListings`), `convex/catalogue.ts:159-164`
(`listPublic`), `convex/catalogue.ts:289-296` (`getPublicDetail`).

**Problem** — All four sites resolve "the latest published version" via
`.withIndex("by_project_published").order("desc").first()`, which orders by
`publishedAt` and ignores the `deprecatedAt` marker. If the newest version is
deprecated, the embedding, the catalogue listing, and the public detail all
serve the deprecated surface *consistently* — so this is NOT a
divergence between search and catalogue (correcting the prior review's
framing). It is, however, a behavioural question: there is no flow that
publishes a non-deprecated successor and surfaces it as "current" while the
deprecated version remains the newest by `publishedAt`. The deprecation
metadata (`deprecatedAt`, `sunsetAt`, `deprecationMessage`) is surfaced to
`getPublicDetail` callers, so consumers can warn — but `listPublic` cards
have no deprecation signal at all.

**Impact** — No correctness/security defect. Search and catalogue agree.
Minor UX gap: `listPublic` cards do not surface deprecation.

**Fix** — If deprecation should hide/flag listings, decide explicitly and
apply the same filter at all four sites. Otherwise document that
"latest by publishedAt, deprecated or not" is the intended resolution.

---

### [SEV: P3] Schema comment lies: `specEmbeddings` documented as "Gemini text-embedding-004"

**Location** — `convex/schema.ts` (`specEmbeddings` table comment)

```ts
// Catalogue semantic search (embedded on publish; Gemini text-embedding-004)
specEmbeddings: defineTable({ ... })
```

**Problem** — The schema comment says `text-embedding-004`, but `search.ts`
uses `gemini-embedding-001` (`text-embedding-004` was removed from the v1beta
API and returns HTTP 404 — see the memory note and `search.ts:51-54`). The
comment is a stale lie that will mislead the next maintainer into thinking
the model is the dead one.

**Impact** — Misleading documentation; future maintainer confusion.

**Fix** — Update the schema comment to `gemini-embedding-001 (768-dim)`.

---

### [SEV: P3] `search.test.ts` `dummyEmbed` comment references the dead model

**Location** — `convex/search.test.ts:18`

```ts
/** 768-dim dummy vector — matches the Gemini text-embedding-004 dimensionality. */
function dummyEmbed(fill = 0.01): number[] {
  return Array.from({ length: 768 }, () => fill);
}
```

**Problem** — Same stale-model reference as P3 #18; the production model is
`gemini-embedding-001`, not `text-embedding-004`.

**Impact** — Misleading test documentation.

**Fix** — `matches the Gemini gemini-embedding-001 dimensionality (768)`.

---

### [SEV: P3] `listPublic` `total` is silently capped at 1000 and returned as a plain number

**Location** — `convex/catalogue.ts:137-142` + return-type comment

**Problem** — `total` is `totalDocs.length` from a `.take(1000)`, so once the
catalogue exceeds 1000 public+published projects, the "APIs listed" stat
flatlines at 1000 with no signal to the caller that it is saturated. The
return-type comment ("Bounded at 1000 docs ... catalogue growth past that
undercounts the stat") admits the lie but the field shape (`total: number`)
gives the UI no way to know it is capped.

**Impact** — Misleading catalogue-size stat at scale; minor.

**Fix** — Either drop the cap and accept the count cost (the index already
supports it), or expose `totalIsCapped: boolean` / return `total: null` past
the cap so the UI can render "1000+".

---

## Summary

- **Findings:** 19 (P0: 0, P1: 3, P2: 9, P3: 7)
- **Top 3:**
  1. **P1 — Gemini API key in URL query string** (`search.ts:113`). Latent
     credential exposure via any URL-logging layer; move to `x-goog-api-key`
     header.
  2. **P1 — `searchCatalogue` is an unauthenticated, uncached, unthrottled
     paid-API trigger** (`search.ts:345`). Cost-abuse / denial-of-wallet
     against the production Gemini key with a side effect of starving
     legitimate search when the quota is exhausted.
  3. **P1 — Stale/orphaned `specEmbeddings` rows never cleaned up across
     `admin.setProjectVisibility`, `projects.update`, and `projects.remove`**
     (`admin.ts:229`, `projects.ts:151-153,186-188,204-226`). Search recall
     collapses monotonically toward zero as the catalogue churns; renaming a
     public project silently breaks search-by-name. Security invariant holds,
     but the feature dies.

**Headline contract status:** model `gemini-embedding-001` ✅,
`outputDimensionality: 768` ✅, `taskType` `RETRIEVAL_DOCUMENT`/`RETRIEVAL_QUERY`
✅, draft/private exclusion at both layers ✅, degraded path on Gemini
failure ✅ (partial — P2 #7). The defects above are in cost/abuse, error and
edge paths, operational robustness, recall hygiene, and scaling — not in the
core happy-path wiring.
