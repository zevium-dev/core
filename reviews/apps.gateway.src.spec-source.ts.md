# Tiger Review: `apps/gateway/src/spec-source.ts`

Cross-referenced: `apps/gateway/src/catalogue-source.ts`, `convex/specs.ts`, `apps/gateway/src/pipeline.ts`, `apps/gateway/src/discovery.ts`, `apps/gateway/src/mcp.ts`.

## Verdict

**Incorrect.** The TTL cache has a material availability defect: transient Convex errors are swallowed and cached as `null` (project-not-found) for the full 30 s TTL, turning a 1-second Convex blip into a 30-second false-404 outage for every affected org/project pair. The same negative-caching pattern also delays newly-published projects and newly-deprecated versions by up to 30 s. Several minor dead-code and design issues round out the file.

## File Stats

- File: `apps/gateway/src/spec-source.ts`
- Lines reviewed: 1–234 (full)
- Cross-read: `catalogue-source.ts` (same patterns), `convex/specs.ts:getPublishedForGateway`, `pipeline.ts` (consumer), `discovery.ts` + `mcp.ts` (consumers)

## Findings

---

### [P1] Transient Convex errors are cached as `null` for the full 30 s TTL — false 404 outage

**Location:** `ConvexSpecSource.getPublishedSpec` (lines 126–140) + `CachedSpecSource.getPublishedSpec` (lines 80–96)

```ts
// ConvexSpecSource — swallows ALL errors into null
async getPublishedSpec(orgSlug, projectSlug): Promise<PublishedSpec | null> {
  try {
    const value = await this.#client.query(getPublishedForGatewayRef, { orgSlug, projectSlug });
    return parsePublishedSpecPayload(value);
  } catch (err) {
    console.error("ConvexSpecSource.getPublishedSpec failed", err);
    return null;  // ← indistinguishable from "project not found"
  }
}

// CachedSpecSource — caches whatever inner returns, including error-null
const value = await this.#inner.getPublishedSpec(orgSlug, projectSlug);
// …
this.#cache.set(key, { value, expiresAt: now + this.#ttlMs });  // ← null cached for 30 s
```

**Problem:** `ConvexSpecSource` conflates two semantically distinct outcomes — "project genuinely does not exist" (legitimate `null`) and "Convex blew up / timed out / returned 5xx" (caught exception → `null`) — into the same return value. `CachedSpecSource` cannot distinguish them, so it caches both for the full `DEFAULT_TTL_MS` (30 s). A single transient Convex hiccup on a hot project poisons that cache entry: for the next ~30 seconds every gateway call for that org/project returns `null` → `pipeline.ts` returns `404 "Unknown project"` — even though Convex recovered seconds later and the project is published and healthy.

**Impact:** Availability regression under transient control-plane failure. A 1-second Convex blip becomes a 30-second full outage for every cached project. High-traffic projects are the worst hit because their cache entries are the most valuable and the most likely to be mid-TTL when Convex recovers. The error is also silently logged to `console.error` only — no metric, no alarm surface, and the consumer sees a misleading `404 project_not_found` rather than a `502/503`.

**Fix:** Distinguish errors from not-found at the source. Re-throw (or return a sentinel) on caught exceptions so `CachedSpecSource` can either skip caching or apply a short negative-TTL. Do not cache error results for the full positive TTL.

```suggestion
// ConvexSpecSource
async getPublishedSpec(orgSlug, projectSlug): Promise<PublishedSpec | null> {
  const value = await this.#client.query(getPublishedForGatewayRef, { orgSlug, projectSlug });
  return parsePublishedSpecPayload(value);
}
// CachedSpecSource — only cache successful lookups; let errors propagate.
const value = await this.#inner.getPublishedSpec(orgSlug, projectSlug);
this.#cache.set(key, { value, expiresAt: now + this.#ttlMs });
return value;
```
(If short negative-caching of genuine not-found is desired, model it explicitly with a separate `negativeTtlMs` and a tagged cache entry — never reuse the positive TTL for errors.)

---

### [P2] 30 s stale pricing when a publisher publishes a new version with different `x-zevium-cost`

**Location:** `CachedSpecSource` TTL (lines 30, 76–77) + `convex/specs.ts:getPublishedForGateway` (returns latest version)

`getPublishedForGateway` always returns the **latest** published immutable version (`.order("desc").first()`). `CachedSpecSource` caches that snapshot for 30 s. When a publisher publishes v2 with a different `x-zevium-cost` (e.g., v1 cost=3, v2 cost=10), the gateway continues to serve v1's spec — and v1's pricing — for up to 30 s after v2 is live.

**Impact:** Consumers are charged the old price for up to 30 s after a pricing change. If the new price is higher, the publisher is undercharged (revenue loss). If the new price is lower, consumers are overcharged — a direct violation of the project rule "OpenAPI spec is source of truth" and "Never surprise-overage." The `x-zevium-cost` returned in the response header will also contradict the freshly-published spec, confusing agents that re-read the spec via MCP `get_api_docs` (which may get a fresh uncached fetch) and then call the gateway (which serves the stale cached price).

**Fix:** Either (a) shorten the TTL substantially for pricing-critical paths, (b) version-stamp the cache key with the published version and invalidate on publish via a Convex realtime subscription / webhook, or (c) accept the staleness but document the pricing SLA explicitly to publishers. At minimum, the TTL should be configurable per-deployment and default lower than 30 s for a metered-billing system.

---

### [P2] 30 s stale deprecation signalling — `Deprecation`/`Sunset` headers not served after deprecation

**Location:** `CachedSpecSource` TTL + `pipeline.ts:377–393` (RFC 8594 header emission from `published.deprecatedAt`/`sunsetAt`)

When a publisher calls `deprecateVersion`, `getPublishedForGateway` immediately returns the new `deprecatedAt`/`sunsetAt`/`deprecationMessage`. But the gateway cache holds the pre-deprecation snapshot for up to 30 s. During that window, `pipeline.ts` does not emit `Deprecation`, `Sunset`, or `Link` headers, so consumers (and agent clients respecting RFC 8594) get no deprecation signal for up to 30 s.

**Impact:** Consumers miss deprecation warnings during the staleness window. For time-sensitive sunset migrations this defeats the purpose of the signal. Same root cause as the pricing staleness — no invalidation channel from Convex to the gateway on metadata changes.

**Fix:** Same as P2 pricing — add an invalidation path (Convex subscription or publish-time cache-bust) so deprecation metadata propagates within seconds rather than 30 s.

---

### [P2] Negative caching delays newly-published projects by up to 30 s

**Location:** `CachedSpecSource.getPublishedSpec` (lines 87–95)

If any request hits the gateway for a not-yet-published project slug pair (e.g., a consumer probing early, or a retry loop), `null` is cached for 30 s. When the publisher subsequently publishes the project, the gateway continues to return `404` for up to 30 s because the stale `null` is still in cache.

**Impact:** A newly-published project is not callable for up to 30 s after publish if any pre-publish probe populated the cache. This is a poor first-call experience for publishers who publish then immediately share a link. The "real" not-found case (genuine 404) is the common case that negative caching optimizes for, but the 30 s window is too long for a system where publish-to-first-call latency matters.

**Fix:** Use a much shorter negative-TTL (e.g., 2–5 s) for `null` results, or invalidate the negative entry on publish via a Convex webhook. Separating error-null (P1) from genuine-not-found-null (this) lets you tune each independently.

---

### [P3] Dead `value`-unwrap branch in `parsePublishedSpecPayload`

**Location:** `parsePublishedSpecPayload` (lines 152–156)

```ts
let candidate: unknown = json;
if ("value" in json) {
  candidate = json.value;
}
```

`ConvexHttpClient.query()` already unwraps the Convex HTTP envelope and returns the raw function return value (the `{ spec, version, projectId, … }` object), not a `{ value: … }` wrapper. `parsePublishedSpecPayload` is only called from `ConvexSpecSource.getPublishedSpec`, so this branch is dead in production. It is also a latent landmine: if the Convex return shape ever legitimately includes a `value` field (or a future fixture/test payload does), the parser would silently unwrap the wrong level and drop the real spec.

**Fix:** Remove the `value`-unwrap branch, or — if it exists to handle a real raw-HTTP test path — document which caller needs it and guard it with a shape check (e.g., only unwrap when `candidate` lacks `spec`).

---

### [P3] Eviction is FIFO, not LRU — hot entries evicted when inserted first

**Location:** `CachedSpecSource.getPublishedSpec` (lines 90–93)

```ts
if (this.#cache.size >= MEMORY_MAX) {
  const first = this.#cache.keys().next().value;
  if (first !== undefined) this.#cache.delete(first);
}
this.#cache.set(key, { value, expiresAt: now + this.#ttlMs });
```

`Map` preserves insertion order, so `keys().next()` evicts the **first-inserted** still-present entry regardless of how recently it was accessed. A hot project that was inserted early (and is hit every request) will be evicted in favor of a cold one-off lookup once `MEMORY_MAX` (256) is reached, causing a re-fetch on the next hot request. There is no access-order promotion on hit (`return hit.value` does not refresh position).

**Impact:** Under cache pressure (256+ distinct org/project pairs in a 30 s window on one Worker instance), hot entries churn unnecessarily, increasing Convex load and latency.

**Fix:** On hit, `delete` + `set` to move the entry to the end of insertion order (poor-man's LRU), or use a proper LRU structure. Alternatively, since entries also expire by TTL, simply delete expired entries opportunistically before evicting live ones.

---

### [P3] No single-flight — concurrent cold-miss requests stampede Convex

**Location:** `CachedSpecSource.getPublishedSpec` (lines 87–95)

Between the cache-miss check and the `set`, the `await this.#inner.getPublishedSpec(…)` yields. N concurrent requests for the same cold key all miss, all call Convex concurrently, and all `set` (last-write-wins). For a burst of traffic to a newly-published or newly-deployed project (cold Worker isolate), this multiplies Convex load by N and multiplies latency cost.

**Impact:** Amplified Convex load and cost under burst traffic to cold cache entries. Not a correctness bug.

**Fix:** Track an in-flight `Promise` per key and have concurrent callers await the same promise.

---

### [P3] `version` field from Convex response silently dropped — type annotation lies about the contract

**Location:** `getPublishedForGatewayRef` type (lines 33–43) + `parsePublishedSpecPayload` (lines 152–185)

`convex/specs.ts:getPublishedForGateway` returns `{ spec, version, projectId, organizationId, clerkOrgId, visibility, deprecatedAt, sunsetAt, deprecationMessage }`. The `makeFunctionReference` type annotation in `spec-source.ts` omits `version`, and `parsePublishedSpecPayload` never reads it. The `PublishedSpec` type has no `version` field. The version is silently discarded at the gateway layer.

**Impact:** Not a runtime bug, but the type annotation misrepresents the Convex contract (the real return has `version`), and the dropped `version` would be useful for cache-busting, debugging (`x-zevium-spec-version` response header), and correlating gateway behavior with a specific published immutable snapshot. The type lie means future additions to the Convex return will silently fall through the same gap.

**Fix:** Add `version: string` to the `makeFunctionReference` return type and to `PublishedSpec`, and surface it (e.g., as a response header) so consumers can pin which version they were charged against.

---

### [P3] `clerkOrgId` fallback to `organizationId` silently fails closed on missing field

**Location:** `parsePublishedSpecPayload` (lines 172–177)

```ts
// Prefer clerkOrgId; fall back to organizationId only when absent (legacy fixtures).
let clerkOrgId: string;
if ("clerkOrgId" in candidate && typeof candidate.clerkOrgId === "string") {
  clerkOrgId = candidate.clerkOrgId;
} else {
  clerkOrgId = candidate.organizationId;
}
```

If the Convex query ever omits `clerkOrgId` (e.g., a schema regression or a partial payload), the fallback assigns `organizationId` — a Convex internal id (e.g., `"k7a2b3…"`) — to `clerkOrgId`. In `pipeline.ts`, the visibility check is `verified.orgId !== published.clerkOrgId` where `verified.orgId` is a Clerk org id (`"org_…"`). The two would never match, so every private-visibility project would silently return `404 "Unknown project"` for all consumers — including the owner. The fallback masks a data-contract regression as an availability degradation instead of failing loudly.

**Impact:** Fail-closed availability bug masked as a "legacy fixture" fallback. Not a security issue (fails closed), but it hides a real broken state behind silent 404s.

**Fix:** Drop the fallback in production paths. If `clerkOrgId` is required, return `null` (parse failure) when it is absent, so the contract violation surfaces as a loud parse error rather than a silent private-project outage. Reserve the fallback for `FixtureSpecSource` only.

---

## Cross-file notes (same patterns in `catalogue-source.ts`)

`catalogue-source.ts` replicates the two most significant issues above and should be fixed in lockstep:

1. **P1 (error caching):** `ConvexCatalogueSource.listPublic` catches all errors → returns `{ items: [], nextCursor: null }` → `CachedCatalogueSource` caches that empty page for 60 s. A transient Convex blip → 60 s of empty catalogue for discovery + MCP `search_apis`.
2. **P3 (FIFO eviction / no single-flight / dead `value`-unwrap):** `CachedCatalogueSource` has the identical FIFO eviction (lines 71–74), no single-flight, and `parseCataloguePage` has the same dead `if ("value" in json)` unwrap branch.

---

## Convex query concern (not in `spec-source.ts` but affecting the contract)

`convex/specs.ts:getPublishedForGateway` is a **public, no-auth** query that returns the full spec body + `clerkOrgId` + `organizationId` for any published project, including `visibility: "private"` projects. The gateway needs the spec to enforce visibility server-side, but because the Convex query itself is unauthenticated, anyone who discovers the Convex deployment URL and knows an org+project slug can fetch the full OpenAPI spec (upstream URL, endpoints, pricing) of a private-visibility project directly — bypassing the gateway's key-based visibility gate. This is a cross-boundary concern worth flagging to the Convex/specs reviewer; the gateway side (`spec-source.ts`) is a faithful consumer of the contract as written.

## Summary

- **Findings:** 8 in `spec-source.ts` + 2 cross-file notes (catalogue-source same patterns) + 1 convex query concern
- **P0:** 0
- **P1:** 1 (error-null cached 30 s → false 404 outage)
- **P2:** 3 (stale pricing, stale deprecation, negative-cache delays new projects)
- **P3:** 4 (dead value-unwrap, FIFO eviction, no single-flight, dropped version, clerkOrgId fallback) + 2 cross-file

**Top 3 to fix before merge:**
1. **P1 — Stop caching error-null for 30 s.** Distinguish Convex errors from genuine not-found; never cache transient failures at the positive TTL. This is the only finding that turns a brief infra hiccup into a sustained customer-visible outage.
2. **P2 — Add an invalidation channel for pricing/deprecation changes.** 30 s of stale `x-zevium-cost` and missing `Deprecation`/`Sunset` headers violates "spec is source of truth" for a metered-billing system. At minimum, shorten the default TTL and make it configurable.
3. **P3 — Drop the dead `value`-unwrap and the `clerkOrgId`→`organizationId` fallback** to remove latent landmines in the parse path.
