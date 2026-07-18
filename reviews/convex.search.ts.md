# Tiger-Style Review — `convex/search.ts`

Catalogue semantic search: Gemini embedding generation (`gemini-embedding-001`,
768-dim) + vector search over `specEmbeddings.by_embedding`. Public action
`searchCatalogue`; internal embed pipeline (`embedProject`, `embedAllPublished`).

## Verdict

**Incorrect** — model + dimensionality + taskType are correct, and the
post-search PUBLIC/PUBLISHED security gate is sound, but there are real
correctness/operability defects: the Gemini API key is exposed in a URL query
string, the returned vector dimension is never validated (a silent model/API
regression to 3072-dim turns `embedProject` into an infinite retry loop),
`searchCatalogue`'s "never throw to client" contract is broken for
`vectorSearch` failures, there is no empty/oversized-text guard, and the
backfill schedules every project's embed at `t=0` (thundering herd, no
rate-limit handling).

## File Stats

- File: `convex/search.ts` (384 lines)
- Functions: `buildEmbedText`, `embedText`, `getProjectForEmbed`,
  `upsertEmbedding`, `embedProject`, `listPublishedPublicProjects`,
  `embedAllPublished`, `fetchSearchListings`, `searchCatalogue`
- Correctness checks (per task contract):
  - Model: `gemini-embedding-001` ✅ (dead `text-embedding-004` not used)
  - `outputDimensionality: 768` set ✅ (would mismatch 3072 default otherwise)
  - `taskType`: `RETRIEVAL_DOCUMENT` for indexing (`embedProject`),
    `RETRIEVAL_QUERY` for search (`searchCatalogue`) ✅
  - Degraded path on Gemini failure (`searchCatalogue`) ✅ (partial — see P2 #3)

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

**Problem** — The Gemini API key is interpolated into the request URL as a
query parameter. Outgoing fetch URLs are routinely captured by HTTP clients,
proxy/egress logs, APM telemetry, Convex action logs, and error reporters.
Any of those becomes a credential-leak surface. The Gemini `generativelanguage`
API equally accepts the key via the `x-goog-api-key` request header, which
keeps the secret out of URLs entirely.

**Impact** — Latent credential exposure; any logging/proxy layer that records
request URLs leaks the production Gemini key. Single most exploitable defect in
the file.

**Fix** — Move the key to a header and drop it from the URL:

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

**Problem** — `embedText` checks only that `values` is a non-empty array. It
never asserts `values.length === EMBED_DIMENSIONS` (768). The whole file is
pinned on 768 to match the `by_embedding` vectorIndex; the comment at line 56
even calls this out. If Gemini ever returns the default 3072-dim vector (API
revision, `outputDimensionality` silently ignored for a new model version,
or a malformed response), the bad vector flows downstream:

- `embedProject` → `upsertEmbedding` → Convex rejects the `embedding` write
  because the vectorIndex declares 768 dims → the scheduled action throws →
  Convex retries the scheduled function indefinitely (no permanent-failure
  escape). The project's embedding is stuck forever.
- `searchCatalogue` → `ctx.vectorSearch` with a 3072-dim query vector against
  a 768-dim index throws — and that throw is **outside** the `try/catch`
  around `embedText` (see P2 #3), so it surfaces to the client instead of
  degrading.

**Impact** — A silent Gemini dimension regression wedges `embedProject` in an
infinite retry loop and breaks `searchCatalogue` with an uncaught throw.

**Fix** — Validate before returning:

```ts
if (!Array.isArray(values) || values.length !== EMBED_DIMENSIONS) {
  throw new Error(
    `Gemini embed returned ${Array.isArray(values) ? values.length : "non-array"} dims, expected ${EMBED_DIMENSIONS}`,
  );
}
return values;
```

---

### [SEV: P2] `searchCatalogue` "never throw to client" contract is broken for `vectorSearch` failures

**Location** — `convex/search.ts:370-385` (`searchCatalogue`)

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

**Problem** — The degrade-to-empty contract is only applied to `embedText`.
`ctx.vectorSearch` and `ctx.runQuery(fetchSearchListings)` are both outside the
guard. The doc comment claims "A Gemini failure ... returns degraded without
ever reaching vectorSearch" — true for Gemini failures, but `vectorSearch`
itself can throw (dimension mismatch from P2 #2, transient Convex vector
index errors, etc.), as can `fetchSearchListings`. Any of those propagates as
an uncaught exception to the catalogue UI, which the action explicitly promises
not to do.

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
`embedContent` call. Gemini enforces per-project/per-key RPM limits; a
backfill over N projects at once will trip 429s. There is no jitter, no
staggering, no batching, and no 429/5xx retry/backoff in `embedText` — a 429
throws, `embedProject` throws, and Convex retries the scheduled function
(with backoff) but with no awareness that the failure was a rate limit
applying to the whole batch, so the retry storm continues.

**Impact** — Backfill over more than a handful of projects rate-limits and
partially fails; some projects' embeddings never land (scheduler retries
exhaust). Already observed `{ "scheduled": 5 }` in dev — at catalogue scale
this breaks.

**Fix** — Stagger the schedules (and consider batching via
`batchEmbedContents`):

```ts
for (let i = 0; i < projectIds.length; i++) {
  await ctx.scheduler.runAfter(i * 1, internal.search.embedProject, {
    projectId: projectIds[i],
  });
}
```

Plus bounded retry/backoff in `embedText` for 429/5xx (transient) vs.
400 (permanent — do not retry).

---

### [SEV: P2] No empty-text guard in `embedProject`

**Location** — `convex/search.ts:213-226` (`embedProject`) and `buildEmbedText`

```ts
const text = buildEmbedText(data, data.specJson);
const embedding = await embedText(text, {
  taskType: "RETRIEVAL_DOCUMENT",
});
```

**Problem** — `buildEmbedText` can return `""`: a project with empty `name`
(the schema allows `name: v.string()` with no min length), empty/undefined
description, no tags, and either no published spec or an unparseable spec
returns `""` after the `.filter((p) => p.length > 0).join(" ").trim()` at
lines 78-81. `embedText("")` then calls Gemini with `content.parts[0].text =
""`, which Gemini rejects with HTTP 400. `embedProject` throws, the
scheduler retries — forever, because the input never changes. There is no
guard for empty text on either the embed or search path (the search path
trims and short-circuits, but the embed path does not).

**Impact** — A degenerate-but-valid project record wedges `embedProject` in an
infinite retry loop and never produces an embedding.

**Fix** — Short-circuit in `embedProject` (and treat empty text as a
no-op, not a retryable failure):

```ts
const text = buildEmbedText(data, data.specJson);
if (text.length === 0) return;
const embedding = await embedText(text, { taskType: "RETRIEVAL_DOCUMENT" });
```

---

### [SEV: P2] No input-size cap on embedded text — oversized specs cause permanent failure

**Location** — `convex/search.ts:30-72` (`buildEmbedText`) / `embedText`

**Problem** — `buildEmbedText` concatenates the project name, description,
tags, and one `METHOD path summary` line per endpoint of the latest published
OpenAPI spec. A large spec (hundreds/thousands of endpoints, long summaries)
produces a text blob that exceeds Gemini `embedContent`'s input token limit
(~2048 input tokens for `gemini-embedding-001`). Gemini returns HTTP 400,
`embedText` throws, `embedProject` retries indefinitely (input never changes).
`searchCatalogue` is not affected because query text is user-typed and short.

**Impact** — A publisher with a large OpenAPI spec can wedge their own
embedding in an unrecoverable retry loop; the project never becomes searchable.

**Fix** — Truncate the embedded text to a safe character/token budget before
calling `embedText` (e.g. cap total length and/or endpoint-line count), and
distinguish 400 (permanent — do not retry) from 429/5xx (transient — retry)
inside `embedText` so permanent failures don't loop forever.

---

### [SEV: P2] `embedText` does not distinguish transient (429/5xx) from permanent (400) failures — `embedProject` retries forever on permanent errors

**Location** — `convex/search.ts:123-125` (`embedText`)

```ts
if (!res.ok) {
  throw new Error(`Gemini embed failed (${res.status})`);
}
```

**Problem** — Every non-2xx is thrown identically. `embedProject`'s contract is
"A Gemini failure throws here so Convex retries the scheduled function"
(file comment line 208). For 429/5xx that is correct; for 400 (bad input —
empty text, oversized text, malformed request) the input never changes
between retries, so the scheduler retries a permanently-failing call
indefinitely. Combined with P2 #5 and #6, a single bad project record can
produce an unbounded stream of failed scheduled runs.

**Impact** — Wasted scheduler capacity; noisy permanent failures that never
self-heal; the project is never searchable and the operator gets no signal.

**Fix** — Throw a tagged error for 4xx and either skip-and-log or surface
to the caller so `embedProject` can choose not to retry:

```ts
if (!res.ok) {
  const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
  throw new Error(
    `Gemini embed failed (${res.status})${permanent ? " [permanent]" : ""}`,
  );
}
```

…and have `embedProject` catch permanent errors, log, and return (not throw).

---

### [SEV: P3] `embedProject` never removes stale embeddings for projects that are no longer public+published

**Location** — `convex/search.ts:210-227` (`embedProject`)

**Problem** — `embedProject` is only scheduled on publish / backfill. When a
project later flips to `private` or `draft` (via `specs.ts`/admin flows), no
caller schedules an embed cleanup, so the stale `specEmbeddings` row persists.
The file's security comment (lines 12-16) and `fetchSearchListings` correctly
filter these out at query time, so this is not a leak — but the stale rows
still occupy vectorSearch result slots, meaning a search with `limit: 20`
that returns 20 stale-private ids yields zero listings to the user even when
20 valid public projects exist. There is no over-fetch to compensate.

**Impact** — Degraded search recall proportional to the stale-embedding
ratio; no correctness leak.

**Fix** — Either delete the `specEmbeddings` row when the project leaves
`public+published` (schedule a cleanup from the visibility/status mutation),
or over-fetch in `searchCatalogue` (e.g. `limit * 3`, capped) and let
`fetchSearchListings` filter down to `limit`.

---

### [SEV: P3] `fetchSearchListings` N+1 db round-trips (bounded by limit=20)

**Location** — `convex/search.ts:312-360` (`fetchSearchListings`)

```ts
for (let i = 0; i < args.ids.length; i++) {
  const embeddingRow = await ctx.db.get(args.ids[i]);
  ...
  const project = await ctx.db.get(embeddingRow.projectId);
  ...
  const org = await ctx.db.get(project.organizationId);
  ...
  const latest = await ctx.db
    .query("specVersions")
    .withIndex("by_project_published", ...)
    .order("desc")
    .first();
  ...
}
```

**Problem** — Per result: 1 `db.get(embeddingRow)` + 1 `db.get(project)` + 1
`db.get(org)` + 1 `specVersions` indexed query = 4 db round-trips. At
`limit=20` that's ~80 sequential round-trips per search. Bounded, so not a
defect, but it is the hot path for every catalogue search and could be a
single batched `db.query("projects").withIndex(...)` etc.

**Impact** — Latency on the public search path; not a correctness issue.

**Fix** — Batch-fetch projects and orgs via indexed queries over the
candidate ids rather than per-row `db.get`.

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
Convex's `vectorSearch` `limit` is an integer; a float either throws or is
silently coerced depending on runtime.

**Impact** — Unpredictable behavior if a caller passes a float; no observed
caller does today.

**Fix** — `Math.floor` / `Math.trunc` after clamping, or coerce with `| 0`.

---

### [SEV: P3] `fetchSearchListings` does not enforce `ids.length === scores.length`

**Location** — `convex/search.ts:304-310`

```ts
args: {
  ids: v.array(v.id("specEmbeddings")),
  scores: v.array(v.float64()),
},
```

**Problem** — Parallel-array contract is implicit. The only caller
(`searchCatalogue`) builds both arrays from the same `results` array, so they
are equal length in practice — but nothing in the function enforces it. A
mismatched caller would silently pair the wrong score with the wrong id (the
loop indexes both by `i` and uses `args.scores[i] ?? 0`).

**Impact** — No current caller misbehaves; fragile against future callers.

**Fix** — Add a runtime guard at the top of the handler:

```ts
if (args.ids.length !== args.scores.length) {
  throw new Error("ids and scores must be the same length");
}
```

---

### [SEV: P3] `getProjectForEmbed` may embed a *deprecated* latest version

**Location** — `convex/search.ts:163-184` (`getProjectForEmbed`)

```ts
const latest = await ctx.db
  .query("specVersions")
  .withIndex("by_project_published", (q) =>
    q.eq("projectId", args.projectId),
  )
  .order("desc")
  .first();
```

**Problem** — `by_project_published` orders by `publishedAt`; `.order("desc").first()`
returns the newest published version regardless of its `deprecatedAt` marker.
If the newest version is deprecated, the embedding reflects a deprecated API
surface, while the catalogue listing (`catalogue.ts`) may serve a different
(currently-active) version. Search relevance and listing display can diverge.

**Impact** — Embedding can represent a deprecated API; minor relevance skew.
Not a correctness/security defect.

**Fix** — Filter out deprecated versions when selecting the embed source, or
match whatever `catalogue.listPublic` resolves as "current."

---

## Summary

- **Findings:** 12 (P0: 0, P1: 1, P2: 6, P3: 5)
- **Top 3:**
  1. **P1 — API key in URL query string** (`embedText:113`). Move to
     `x-goog-api-key` header; latent credential exposure via any URL-logging
     layer.
  2. **P2 — Unvalidated returned vector dimension** (`embedText:135`). A
     silent Gemini regression to 3072 dims wedges `embedProject` in infinite
     retry and breaks `searchCatalogue` with an uncaught throw.
  3. **P2 — `searchCatalogue` degrades only on `embedText` failure, not
     `vectorSearch`/`fetchSearchListings` failure** (`searchCatalogue:370`).
     The documented "never throw to client" contract is violated for non-Gemini
     failures.

**Correctness of the headline contract** (model = `gemini-embedding-001`,
`outputDimensionality: 768`, `taskType` `RETRIEVAL_DOCUMENT`/`RETRIEVAL_QUERY`,
degraded path on Gemini failure) is satisfied on the happy path; the defects
above are in error/edge paths and operational robustness, not in the core
embed/search wiring.
