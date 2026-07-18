# Tiger Review — `apps/gateway/src/catalogue-source.ts`

## Verdict

**incorrect** — 2 correctness/DoS bugs (P2) plus several latent design defects. The cache layer caches error responses as valid empty pages, returns mutable references to shared cached state, and forwards unbounded user-controlled search strings (via unauthenticated `/mcp` `search_apis`) into both the cache key and the upstream Convex query with zero length validation.

## File Stats

- File: `apps/gateway/src/catalogue-source.ts`
- Lines reviewed: full file (~230 LOC) + `spec-source.ts`, `convex/catalogue.ts`, `convex/specs.ts`, `apps/gateway/src/mcp.ts`, `apps/gateway/src/discovery.ts`, `apps/gateway/src/index.ts` for boundary context.
- Findings: 8 (P0: 0, P1: 0, P2: 3, P3: 5)

---

## Findings

### [SEV: P2] Error responses cached as valid empty pages for 60s

**Location:** `apps/gateway/src/catalogue-source.ts:131-143` (`ConvexCatalogueSource.listPublic`) + `:90-103` (`CachedCatalogueSource.listPublic`).

```ts
async listPublic(args?: CatalogueListArgs): Promise<CataloguePage> {
  try {
    const value = await this.#client.query(listPublicRef, {
      search: args?.search,
      tag: args?.tag,
      cursor: args?.cursor,
    });
    return parseCataloguePage(value) ?? { items: [], nextCursor: null };
  } catch (err) {
    console.error("ConvexCatalogueSource.listPublic failed", err);
    return { items: [], nextCursor: null };   // ← indistinguishable from a real empty page
  }
}
```

```ts
// CachedCatalogueSource.listPublic
const value = await this.#inner.listPublic(args);
…
this.#cache.set(key, { value, expiresAt: now + this.#ttlMs });  // ← caches the empty page
return value;
```

**Problem:** `ConvexCatalogueSource` swallows every Convex error (network blip, 5xx, timeout, malformed payload) and returns `{ items: [], nextCursor: null }`. `CachedCatalogueSource` cannot distinguish this sentinel from a genuinely empty catalogue and caches it for the full 60s TTL.

**Impact:** A transient Convex outage of 5s becomes a 60s catalogue blackout *per distinct query* (each `search`/`tag`/`cursor` combo caches its own empty page). The discovery endpoint (`/discovery`, which calls `listPublic()` with no args) and every `search_apis` query made during the blip serve empty results for 60s even after Convex recovers. The error is also silently logged-and-discarded — callers never see a failure, only an empty list, so no retry/backpressure signal propagates.

**Fix:** Propagate errors out of `ConvexCatalogueSource.listPublic` (or return a tagged failure) and have `CachedCatalogueSource` skip caching on error, e.g.:

```ts
// ConvexCatalogueSource
async listPublic(args?: CatalogueListArgs): Promise<CataloguePage> {
  const value = await this.#client.query(listPublicRef, {
    search: args?.search,
    tag: args?.tag,
    cursor: args?.cursor,
  });
  return parseCataloguePage(value) ?? { items: [], nextCursor: null };
}
```
```ts
// CachedCatalogueSource — only cache on success
try {
  const value = await this.#inner.listPublic(args);
  this.#cache.set(key, { value, expiresAt: now + this.#ttlMs });
  return value;
} catch {
  // Don't cache failure; let the next call retry.
  throw err;
}
```

---

### [SEV: P2] No length validation on `search`/`tag`/`cursor`; unauthenticated via `/mcp` `search_apis`

**Location:** `apps/gateway/src/catalogue-source.ts:68-74` (`cacheKey`) + `:131-143` (`ConvexCatalogueSource.listPublic`); reachable unauthenticated via `apps/gateway/src/mcp.ts:204-207` (`handleSearchApis`) and `apps/gateway/src/index.ts:192-196` (`/mcp` route — no auth gate).

```ts
function cacheKey(args: CatalogueListArgs | undefined): string {
  const search = args?.search ?? "";
  const tag = args?.tag ?? "";
  const cursor = args?.cursor ?? "";
  return `${search}\0${tag}\0${cursor}`;   // ← unbounded length, stored in Map
}
```
```ts
// mcp.ts — no auth on /mcp, no length check on query
const query = asString(args.query) ?? "";
const page = await deps.catalogueSource.listPublic({
  search: query.trim() === "" ? undefined : query,   // ← raw, unbounded
});
```

**Problem:** `/mcp` is unauthenticated at the router (`index.ts:192` calls `handleMcpRequest` with no key check; only `call_api` internally requires a key). `search_apis` accepts `args.query` of any length (`asString` only checks `typeof === "string"`; the tool schema declares no `maxLength`). The string flows unvalidated into (a) the cache key — stored verbatim in the `Map` — and (b) the upstream Convex `listPublic` query, where it is `trim().toLowerCase()`'d (doubling memory) and then matched via `haystack.includes(search)` against every public project (`convex/catalogue.ts:135-140`).

**Impact:** Unauthenticated memory amplification + upstream DoS. An attacker can:
1. Send a 1 MB `query` → cache key is 1 MB; with `MEMORY_MAX=64`, up to ~64 MB of key memory per isolate, multiplied across every Cloudflare isolate the request lands on.
2. Send many distinct long queries → each forces an O(projects × |search|) `includes()` scan in Convex, amplifying load on the control plane.
3. Send 64+ distinct short queries → thrash the 64-slot cache, evicting legitimate entries and forcing every subsequent request to bypass the cache.

The cache bounds the *number* of entries (64) and TTL (60s), but not the *size* of each key, and the forwarding path has no length gate at all.

**Fix:** Cap `search`/`tag`/`cursor` length at the gateway boundary before caching or forwarding, e.g. in `cacheKey` and `ConvexCatalogueSource.listPublic`:

```ts
const MAX_SEARCH_LEN = 256;
function cacheKey(args: CatalogueListArgs | undefined): string {
  const search = (args?.search ?? "").slice(0, MAX_SEARCH_LEN);
  const tag = (args?.tag ?? "").slice(0, 64);
  const cursor = (args?.cursor ?? "").slice(0, 32);
  return `${search}\0${tag}\0${cursor}`;
}
```

---

### [SEV: P2] Cache returns mutable references — latent cache poisoning

**Location:** `apps/gateway/src/catalogue-source.ts:90-103` (`CachedCatalogueSource.listPublic`).

```ts
async listPublic(args?: CatalogueListArgs): Promise<CataloguePage> {
  const key = cacheKey(args);
  const now = this.#now();
  const hit = this.#cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;   // ← shared mutable ref

  const value = await this.#inner.listPublic(args);
  …
  this.#cache.set(key, { value, expiresAt: now + this.#ttlMs });
  return value;                                        // ← same ref just stored
}
```

**Problem:** Both the cache-hit path and the cache-fill path return the *same* `CataloguePage` object reference that lives in `#cache`. `CataloguePage` (`items: CatalogueListing[]`) and each `CatalogueListing` are plain mutable objects. Any consumer that mutates `page.items` (push/sort/splice/reverse) or mutates a listing field corrupts the cached entry for every subsequent caller within the 60s TTL window.

**Impact:** No *current* caller in `discovery.ts` or `mcp.ts` mutates the page (both iterate read-only), so this is latent. But the cache is shared mutable state with no defensive barrier — a single future `page.items.sort(…)` or `page.items.push(…)` in any downstream consumer silently poisons every other request's view for up to 60s. This is the textbook shared-cache-returns-mutable-references anti-pattern; the fix is trivial and proportionate.

**Fix:** Freeze or shallow-clone before caching/returning:

```ts
this.#cache.set(key, {
  value: Object.freeze({ ...value, items: Object.freeze([...value.items]) }),
  expiresAt: now + this.#ttlMs,
});
```

---

### [SEV: P3] `listPublicRef` type annotation drifts from the real Convex query

**Location:** `apps/gateway/src/catalogue-source.ts:40-57`.

```ts
const listPublicRef = makeFunctionReference<
  "query",
  { search?: string; tag?: string; cursor?: string },   // ← missing sort, hasFreeTier, maxCost
  {
    items: Array<{…}>;
    nextCursor: string | null;                          // ← missing total
  }
>("catalogue:listPublic");
```

The actual `convex/catalogue.ts:84-100` `listPublic` accepts `{ search?, tag?, cursor?, sort?, hasFreeTier?, maxCost? }` and returns `{ items, nextCursor, total }`.

**Problem:** The hand-maintained `makeFunctionReference` type has drifted from the source of truth. TypeScript cannot flag this because the reference is typed locally, not inferred from `_generated/api`. Consequences: (1) the gateway can never pass `sort`/`hasFreeTier`/`maxCost` without a type error, even if a consumer wants them; (2) `parseCataloguePage` silently drops the `total` field — if any gateway consumer ever needs the total count, the type says it doesn't exist; (3) any future field added to `PublicListing` (e.g. `pricing`, already present in Convex but absent from this annotation) is invisible to the gateway and silently discarded by `parseListing`.

**Fix:** Import the typed reference from `_generated/api` (`api.catalogue.listPublic`) instead of reconstructing it with `makeFunctionReference`, or keep the annotation in sync with the Convex return type and document the intentional drops.

---

### [SEV: P3] Thundering herd on cold/expired cache — no in-flight deduplication

**Location:** `apps/gateway/src/catalogue-source.ts:90-103`.

```ts
const hit = this.#cache.get(key);
if (hit && hit.expiresAt > now) return hit.value;

const value = await this.#inner.listPublic(args);   // ← N concurrent misses → N Convex calls
```

**Problem:** When the cache is cold or an entry has just expired, every concurrent request for the same key misses and fires a separate `inner.listPublic()` call. There is no in-flight promise tracking to coalesce concurrent identical fetches.

**Impact:** Under burst load (e.g. a cache stampede when the 60s TTL expires under traffic), N concurrent requests produce N upstream Convex `listPublic` queries instead of 1. For the unauthenticated `/mcp` `search_apis` path, an attacker can intentionally trigger this by timing requests to TTL expiry.

**Fix:** Track an in-flight `Map<string, Promise<CataloguePage>>` and return the existing promise if one is pending.

---

### [SEV: P3] `cacheKey` does not normalize — case/whitespace variants pollute the 64-slot cache

**Location:** `apps/gateway/src/catalogue-source.ts:68-74` (`cacheKey`) vs `convex/catalogue.ts:101-103` (Convex normalization).

```ts
function cacheKey(args: CatalogueListArgs | undefined): string {
  const search = args?.search ?? "";
  const tag = args?.tag ?? "";
  const cursor = args?.cursor ?? "";
  return `${search}\0${tag}\0${cursor}`;
}
```

Convex normalizes: `args.search.trim().toLowerCase()` and `args.tag.trim().toLowerCase()` (`convex/catalogue.ts:101-102`). The cursor is `Number.parseInt(args.cursor, 10)` (`:107`).

**Problem:** `cacheKey` uses the raw, un-normalized strings. So `"foo"`, `"FOO"`, `" foo "`, `"foo\n"` all produce distinct cache keys but identical Convex results. Likewise `cursor="1"`, `"01"`, `"+1"`, `"1.0"` all parse to offset 1 in Convex but create separate cache entries.

**Impact:** Semantically identical queries occupy distinct slots in the 64-entry cache, evicting genuinely distinct results. An unauthenticated caller (or ordinary client variation) can dilute cache hit-rate and force extra Convex calls. Bounded by `MEMORY_MAX=64` but wasteful and easily avoidable.

**Fix:** Normalize in `cacheKey` the same way Convex does before keying:

```ts
function cacheKey(args: CatalogueListArgs | undefined): string {
  const search = (args?.search ?? "").trim().toLowerCase();
  const tag = (args?.tag ?? "").trim().toLowerCase();
  const cursor = args?.cursor ?? "";
  return `${search}\0${tag}\0${cursor}`;
}
```

---

### [SEV: P3] `FixtureCatalogueSource` tag matching diverges from Convex (test fidelity)

**Location:** `apps/gateway/src/catalogue-source.ts:206-215` (`FixtureCatalogueSource.listPublic`) vs `convex/catalogue.ts:120` (`project.tags.includes(tag)`).

```ts
// Fixture — case-insensitive
if (tag !== "") {
  filtered = filtered.filter((i) =>
    i.tags.some((t) => t.toLowerCase() === tag),   // ← lowercases stored tag
  );
}
```
```ts
// Convex — case-sensitive on stored value
if (tag !== "" && !project.tags.includes(tag)) continue;   // ← tag is lowercased input, stored tag is not
```

**Problem:** The fixture lowercases each stored tag before comparing; Convex does not. A project stored with tag `"AI"` matches search tag `"ai"` in the fixture but **not** in production (Convex checks `["AI"].includes("ai")` → `false`). Any test that exercises tag search with mixed-case stored tags passes against the fixture but would fail against the real query.

**Impact:** Tests using `FixtureCatalogueSource` provide false confidence for tag-case behavior. This also masks a latent production inconsistency: tag search only works when stored tags are already lowercase, which is an implicit invariant not enforced anywhere.

**Fix:** Align the fixture with Convex's actual matching (`i.tags.includes(tag)` with lowercased `tag`), or — better — fix both to normalize case consistently and enforce lowercase tags at the project-creation boundary.

---

### [SEV: P3] FIFO eviction doesn't refresh insertion order on re-set

**Location:** `apps/gateway/src/catalogue-source.ts:96-103`.

```ts
if (this.#cache.size >= MEMORY_MAX) {
  const first = this.#cache.keys().next().value;   // ← oldest insertion, not least-recently-used
  if (first !== undefined) this.#cache.delete(first);
}
this.#cache.set(key, { value, expiresAt: now + this.#ttlMs });  // ← Map.set on existing key keeps original order
```

**Problem:** JS `Map.set` on an existing key updates the value but preserves the original insertion order. So when an expired entry is refreshed, it stays in its original position in the iteration order. The eviction picks `keys().next().value` (the oldest *insertion*), which may be an entry that was just refreshed (if it was originally inserted first) — or may evict a still-valid entry while leaving expired entries deeper in the map. This is FIFO, not LRU, and the "refresh doesn't move to tail" behavior means a hot key that was inserted early can be evicted while cold keys survive.

**Impact:** Minor cache inefficiency under churn — hot keys can be evicted before cold keys. Bounded by `MEMORY_MAX=64` and 60s TTL, so the blast radius is small. The eviction also never proactively purges expired entries (they linger until size pressure forces eviction), wasting memory.

**Fix:** Either `delete` then `set` to move refreshed keys to the tail, or sweep expired entries before size-based eviction:

```ts
// move-to-tail on refresh
this.#cache.delete(key);
this.#cache.set(key, { value, expiresAt: now + this.#ttlMs });
```

---

## Summary

**Counts:** 0 P0, 0 P1, 3 P2, 5 P3 (8 total)

**Top 3:**
1. **Error responses cached as valid empty pages (P2)** — transient Convex errors become 60s-per-query catalogue blackouts; the error sentinel is indistinguishable from a genuine empty page.
2. **No length validation on `search`/`tag`/`cursor`, reachable unauthenticated via `/mcp` `search_apis` (P2)** — unbounded cache-key memory amplification + unbounded `includes()` scan forwarded to Convex, no auth gate, no `maxLength`.
3. **Cache returns mutable references (P2)** — shared cached `CataloguePage` is returned by reference; any future downstream mutation poisons all concurrent readers for the TTL window.

**Cross-cutting note:** `spec-source.ts` shares the same mutable-reference cache pattern (`CachedSpecSource.getPublishedSpec` returns `hit.value` by reference) and the same error-caching pattern (`ConvexSpecSource.getPublishedSpec` catches and returns `null`, which `CachedSpecSource` then caches for 30s). The fixes above apply symmetrically there. A cache that caches `null` for a newly-published spec means the gateway returns "not found" for up to 30s after a publisher ships a new version — directly undermining the "realtime is default" project rule for the publish→gateway path.
