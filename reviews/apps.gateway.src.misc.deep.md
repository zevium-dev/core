# Gateway Misc — Deep Tiger Review

Files: `apps/gateway/src/cors.ts`, `errors.ts`, `headers.ts`, `spec-source.ts`, `catalogue-source.ts`, `x402.ts`
Context read: `apps/gateway/src/index.ts`, `pipeline.ts`, `mock.ts`, `discovery.ts`, `mcp.ts`

No praise. Every finding is a problem. Prior per-file reviews are verified below; where the prior premise was wrong, it is corrected.

---

## Verdict

**Do not ship as-is.** Two cross-cutting defects dominate:

1. **The TTL caches in `spec-source.ts` and `catalogue-source.ts` are dead code in production.** `index.ts#buildDeps` is invoked on every request and constructs a fresh `CachedSpecSource` / `CachedCatalogueSource` each call. The `#cache` Map is instance-scoped and is garbage-collected when the request ends. The 30s/60s TTL **never produces a cross-request hit.** Every gateway call, every `/discovery`, every MCP `search_apis` hits the Convex control plane with zero dedup. This **corrects the prior reviews**, which analyzed cache-staleness/negative-caching behavior as if the cache persisted across requests — it does not. The staleness findings are moot; the real impact is *no protection at all*: Convex QPS = gateway QPS, and a single Convex blip produces one false-404 *per request* (not per 30s window).

2. **`headers.ts` forwards consumer `Cookie` to upstream and reflects upstream `Set-Cookie` to the consumer.** For an API-key gateway this is never correct — it is a session-ride-along and a credential-injection vector. Both hop-by-hop lists are incomplete.

Beyond those, `errors.ts` advertises "Never leaks internals" while `pipeline.ts:260` actively pipes `err.message` into the client body, and `x402.ts` / `errors.ts` allow `extra` to clobber the base envelope and ship no `cache-control: no-store`.

---

## File Stats

| File | Lines | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| cors.ts | 41 | 0 | 0 | 0 | 4 |
| errors.ts | 27 | 0 | 1 | 2 | 4 |
| headers.ts | 60 | 0 | 2 | 2 | 4 |
| spec-source.ts | 197 | 0 | 2 | 4 | 4 |
| catalogue-source.ts | 212 | 0 | 1 | 5 | 3 |
| x402.ts | 44 | 0 | 0 | 2 | 4 |
| **Total** | | **0** | **6** | **15** | **23** |

---

## Findings

### cors.ts

#### [P3] OPTIONS preflight advertises full CORS on `/internal/*` and every 404 path
```ts
// index.ts
if (request.method === "OPTIONS") {
  return corsPreflight();   // runs before any routing
}
```
`corsPreflight()` returns `ACAO: *` + all methods + `authorization`/`x-api-key` allowed for **every** path, including `/internal/grant`, `/internal/sync`, and unknown paths. The actual `/internal` responses are not wrapped in `withCors` (correct), so a browser client passes preflight then gets blocked on the real request — the preflight is wasted and the surface is over-advertised. Preflight never authenticates (correct), but advertising `DELETE`/`PATCH` etc. on `/internal/grant` (POST-only, shared-secret) is noise that tells a prober "this is a Zevium gateway with an internal admin surface."
**Impact:** Information disclosure / surface advertisement; no direct access granted.
**Fix:** Route preflight per-surface: only `/gateway`, `/mock`, `/discovery`, `/mcp`, `/health` get the public preflight; `/internal/*` and unknown paths get 404/405 with no CORS headers.

#### [P3] `access-control-allow-methods` over-advertises per surface
```ts
"access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
```
`/discovery` is GET/HEAD only; `/mcp` is GET/HEAD/POST; `/internal/grant` is POST. The preflight advertises `PUT/PATCH/DELETE` everywhere. Browsers will permit a preflighted `DELETE /discovery` that then 405s — harmless but misleading to clients probing capability.
**Fix:** Per-surface method list, or at minimum drop methods not served anywhere (`PUT`, `PATCH`, `DELETE` are never accepted by any non-`/gateway` surface).

#### [P3] `access-control-max-age: 86400` — 24h preflight cache
A 24-hour preflight cache means any policy change (tighter methods, dropped headers) is invisible to returning browsers for a full day. For a public API this is tolerable but aggressive; if the CORS surface ever needs to be tightened reactively (e.g. a header is found to enable a vulnerability), 24h is a long window.
**Fix:** 600s is the conventional default and suffices for hot-path preflight dedup.

#### [P3] `withCors` reconstructs the entire `Response` on every outgoing path
```ts
return new Response(res.body, {
  status: res.status, statusText: res.statusText, headers,
});
```
This is required to mutate headers, but it is applied unconditionally even to `/health` and the 404 catch-all. No defect, but note `withCors` does **not** set `vary: origin`. With `ACAO: *` this is correct (no origin variance), but the moment origin is ever made dynamic, every CDN edge will serve stale cross-origin responses without `Vary: Origin`. Document the invariant or add `vary: origin` defensively.
**Fix:** Add a comment that `ACAO: *` is load-bearing for the absence of `Vary: Origin`, or add `Vary: Origin` to be future-proof.

---

### errors.ts

#### [P1] Docstring "Never leaks internals" is an unenforced lie — `pipeline.ts:260` pipes raw `err.message` into the client body
```ts
// errors.ts
/**
 * Shared JSON error envelope for /gateway and /mock. Never leaks internals —
 * `message` is always a short, human-safe string.
 */
export function jsonError(status, code, message, requestId, extra?) { ... }
```
```ts
// pipeline.ts:258-262
} catch (err) {
  ...
  const message = err instanceof Error ? err.message : "upstream error";
  ...
  return jsonError(502, "upstream_error", message, requestId);
}
```
The contract on `jsonError` is "message is always a short, human-safe string." The function does nothing to enforce this, and the one caller that handles an upstream failure passes `err.message` straight through. In Cloudflare Workers a `fetch` failure is usually `TypeError: fetch failed`, but the `cause` chain and message can include the resolved upstream hostname, port, or connection-refused details — internal topology the gateway must not expose. `mcp.ts:467` has the identical pattern (`err instanceof Error ? err.message : String(err)` → `toolError`).
**Impact:** Internal-infrastructure leakage to any caller (no auth required — the error path is reached after key verification but the body goes to the consumer; upstream-error path is reachable by any authenticated key).
**Fix:** `errors.ts` must own the safety: either (a) ignore the caller's `message` for 5xx and emit a fixed `"Upstream error"` string, or (b) validate/allow-list `message` against a known set. Stop trusting callers. Update `pipeline.ts:260` and `mcp.ts:467` to pass a fixed string and log the raw `err` server-side.

#### [P2] No `cache-control: no-store` on error responses
```ts
return new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "x-zevium-request-id": requestId },
});
```
No cache directive. A 404 `project_not_found`, a 402, or a 502 can be heuristically cached by Cloudflare's edge or a downstream CDN/browser for tens of seconds. For 404 this directly delays visibility of newly-published projects (the publisher deploys, but consumers still see 404 from a cached error). For 502 it extends an outage window. For 402 it delays the effect of a credit top-up.
**Impact:** Stale errors lengthen outages and billing-recovery time.
**Fix:** Add `"cache-control": "no-store"` to every error response in `errors.ts` (and mirror in `x402.ts`).

#### [P2] `extra` merges after base fields — caller-supplied keys clobber the envelope
```ts
const body: Record<string, unknown> = { error: code, message, requestId };
if (extra) {
  for (const [k, v] of Object.entries(extra)) {
    body[k] = v;   // caller can set body.error / body.message / body.requestId
  }
}
```
`extra` is `Record<string, unknown>` with no reserved-key guard. A caller passing `extra: { error: "ok", requestId: "<attacker>" }` overwrites the base fields. Today no caller does this (pipeline and mock pass no `extra`), but the shape is a footgun and the same pattern is duplicated in `x402.ts`.
**Impact:** Future caller can silently break the error contract; clients keyed on `error`/`requestId` get forged values.
**Fix:** Merge `extra` first, then apply base fields last; or reject reserved keys (`error`, `message`, `requestId`, `actions`) in the `extra` loop.

#### [P3] `extra` parameter is dead — no caller passes it
`grep` of `jsonError(` across `pipeline.ts`, `mock.ts`, `discovery.ts`, `mcp.ts` shows every call site omits `extra`. The parameter, its merge loop, and the branch are unreachable in production. Either wire it up (e.g. to add `reason` on the 403 `key_disabled`/`key_cap_exceeded` paths so agents can self-serve) or delete it.

#### [P3] `requestId` placed into a header with no validation
```ts
"x-zevium-request-id": requestId,
```
`requestId` is `crypto.randomUUID()` in all current callers, so safe today. But `jsonError` accepts any string and writes it into a header. The Workers `Headers` constructor throws on CRLF, so injection is prevented at the runtime layer — but defense-in-depth would sanitize (length cap, character allow-list) so a future caller passing a tainted id cannot break the response.
**Fix:** Cap `requestId` to ≤128 chars and `[A-Za-z0-9_-]`.

#### [P3] No `x-zevium-cost` header on errors
Success responses set `x-zevium-cost`; error responses do not. Clients parsing the cost header on every response get `undefined` on the error path, breaking uniform parsing. Set `x-zevium-cost: 0` on every `jsonError` (and every `paymentRequiredResponse`).

#### [P3] `status` not validated
`jsonError(200, ...)` or `jsonError(42, ...)` would produce a malformed response. No caller does this, but the function is a public export. Validate `status` is an integer in `[400, 599]`.

---

### headers.ts

#### [P1] Consumer `Cookie` forwarded to upstream — session ride-along / fixation
```ts
const HOP_BY_HOP: Record<string, true> = {
  connection: true, "keep-alive": true, ...,
  authorization: true, "x-api-key": true,
  // NO "cookie"
};
```
`filterRequestHeaders` copies every non-hop-by-hop header, including `cookie`. A browser consumer's `gateway.zevium.dev` cookies (or any cookie the UA attaches) ride the upstream request. The gateway authenticates by API key and must never forward consumer session state to the upstream API — doing so lets a consumer's session for the gateway domain be presented to (potentially untrusted) upstream APIs, and on self-hosted deployments where upstream shares the gateway origin it is a direct credential leak.
**Impact:** Session fixation / credential ride-along; upstream sees consumer cookies it must never see.
**Fix:** Add `cookie` (and `cookie2`) to `HOP_BY_HOP`, or to a separate `STRIP_REQUEST` list. The gateway sets no cookies and must forward none.

#### [P1] Upstream `Set-Cookie` reflected to consumer — credential injection / CSRF surface
```ts
export function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower in HOP_BY_HOP) return;   // "set-cookie" NOT in HOP_BY_HOP
    ...
    out.append(key, value);
  });
  return out;
}
```
`set-cookie` is not hop-by-hop by the RFC list, but for a proxy it must be stripped: an upstream that sets `Set-Cookie` injects cookies into the consumer's browser for the gateway domain, opening CSRF surface and letting a misbehaving upstream mint gateway-scoped cookies. `Headers#forEach` over `set-cookie` yields the combined value; appending it re-emits it. `append` (not `set`) is also wrong for `set-cookie` — it concatenates with `, `, which corrupts cookie boundaries.
**Impact:** Upstream can plant cookies on the consumer for the gateway origin; CSRF and session-fixation surface.
**Fix:** Strip `set-cookie` and `set-cookie2` in `filterResponseHeaders`. If forwarding is ever needed (it isn't), use the raw `getSetCookie()` list and re-emit individually — never `append`.

#### [P2] `Connection` header-list is ignored (RFC 7230 §6.1)
```ts
if (lower in HOP_BY_HOP) return;   // strips "connection" itself, but not the headers it names
```
RFC 7230 §6.1: a `Connection` header names per-hop headers that MUST also be removed before forwarding. `Connection: x-foo, x-bar` means `x-foo` and `x-bar` must be stripped. The code drops only the `connection` header and forwards `x-foo`/`x-bar` to the upstream. This violates the RFC and can leak hop-specific state (e.g. proxy-specific auth or routing tokens a middleware sets per-hop).
**Fix:** Parse the `Connection` header values, add them to a per-request strip set, then filter.

#### [P2] Consumer can spoof `x-forwarded-*`, `forwarded`, `x-real-ip`
`filterRequestHeaders` forwards `x-forwarded-for`, `x-forwarded-host`, `x-forwarded-proto`, `x-real-ip`, and `forwarded` (RFC 7239) unchanged. The upstream sees a client-controlled identity. If the upstream trusts these for rate-limiting, geo, auth-context, or logging, a consumer can forge IPs, defeat per-IP limits, or poison upstream audit logs. The gateway neither strips consumer-supplied forwarding headers nor sets its own.
**Impact:** Client-identity spoofing at the upstream; audit-log poisoning; rate-limit bypass.
**Fix:** Strip all `x-forwarded-*`, `x-real-ip`, `forwarded` from the consumer request, then set `x-forwarded-for` to the verified client IP (from `CF-Connecting-IP`) and `x-forwarded-proto`/`x-forwarded-host` from the gateway's view.

#### [P3] Upstream `server`, `x-powered-by`, `via` reflected to consumer
`filterResponseHeaders` passes these through, leaking the upstream's server fingerprint and proxy chain to the consumer. Minor info disclosure but aids targeted attacks against the upstream stack.
**Fix:** Strip `server`, `x-powered-by`, `via` in `filterResponseHeaders`.

#### [P3] No header count or byte-size cap
`filterRequestHeaders` copies every header the consumer sends. A consumer can attach thousands of headers or megabyte-sized values; `source.forEach` dutifully appends all of them. Workers enforce per-header limits but not aggregate; this is a memory/CPU amplification vector against the isolate.
**Fix:** Cap header count (e.g. 100) and per-value length; drop the rest.

#### [P3] Consumer-supplied `x-zevium-*` request headers forwarded upstream
The pipeline sets `x-zevium-cost` / `x-zevium-request-id` / `x-zevium-free-tier` only on the **response**. On the request side, a consumer can set `x-zevium-cost: 0` or `x-zevium-request-id: <forged>` and it is forwarded to the upstream. If the upstream interprets any `x-zevium-*` header (now or later), the consumer can spoof it.
**Fix:** Strip `x-zevium-*` from consumer request headers in `filterRequestHeaders`.

#### [P3] `expect` (100-continue) forwarded unchanged
`expect: 100-continue` passes through; the upstream may emit a 100 Continue that the gateway doesn't handle, desynchronizing the client. Minor.
**Fix:** Strip `expect` from consumer request headers.

---

### spec-source.ts

#### [P1] TTL cache is dead in production — `index.ts#buildDeps` reconstructs `CachedSpecSource` per request
```ts
// index.ts:62
function buildDeps(env: Env): WorkerDeps {
  if (testDeps) return testDeps;
  ...
  return {
    ...
    specSource: new CachedSpecSource({ inner: innerSpec }),   // <-- fresh Map every request
    ...
  };
}
```
`buildDeps` is called in every route branch (`/discovery`, `/mcp`, `/gateway`, `/mock`) and constructs a brand-new `CachedSpecSource` each call. The `#cache = new Map()` is instance-scoped; the instance is discarded when the request completes. **The 30s TTL never produces a cross-request hit.** Every gateway call queries Convex `specs:getPublishedForGateway`; every `/discovery` entry queries Convex once per catalogue item.
**This corrects the prior review**, which analyzed "30s stale pricing", "negative-caching delays newly-published by 30s", and "transient errors cached 30s = false-404 outage" as if the cache persisted. **It does not.** Those findings are moot. The real impact is worse: Convex QPS = gateway QPS, with no dedup, no backoff, no protection. A 1k RPS hot project hammers Convex with 1k identical queries/s.
**Impact:** Convex control-plane load scales 1:1 with gateway load; every transient Convex error becomes a per-request false-404; the entire caching layer is dead weight.
**Fix:** Hoist the `CachedSpecSource` / `CachedCatalogueSource` / `ClerkKeyVerifier` to module scope (or a per-`env` memo keyed on `CONVEX_URL`/`CLERK_SECRET_KEY`) so the cache survives across requests within an isolate. `buildDeps` must return the same instance for the same env.

#### [P1] Transient Convex errors swallowed to `null` → consumer sees `404 project_not_found`
```ts
} catch (err) {
  console.error("ConvexSpecSource.getPublishedSpec failed", err);
  return null;
}
```
A transient Convex error (timeout, 5xx, network blip) is caught and returned as `null`, which `pipeline.ts` interprets as "project does not exist" → `jsonError(404, "project_not_found", ...)`. There is no distinction between "legitimately unpublished" and "control plane is down." A publisher with a live, paying project returns 404 to all its consumers during any Convex hiccup. Combined with the dead cache above, every request during the blip independently 404s.
**Impact:** False 404 to paying consumers during transient control-plane failures; revenue loss + trust damage.
**Fix:** Distinguish "not found" (`null` from Convex) from "lookup failed" (throw / sentinel). On lookup failure return `503` with `retry-after` and `cache-control: no-store`, never `404`.

#### [P2] `clerkOrgId` fallback to `organizationId` keys the wallet by the wrong id
```ts
let clerkOrgId: string;
if ("clerkOrgId" in candidate && typeof candidate.clerkOrgId === "string") {
  clerkOrgId = candidate.clerkOrgId;
} else {
  clerkOrgId = candidate.organizationId;   // Convex internal table id, NOT a Clerk org id
}
```
If a payload omits `clerkOrgId` (legacy fixtures, a Convex schema regression, a partial projection), the wallet DO is keyed by `organizationId` — the Convex `organizations` table's internal id, not the Clerk org id. Grants are projected by Clerk org id (`/internal/grant { clerkOrgId }`), so this fallback wallet reads zero balance → every call returns `402 insufficient_credits` for a project that is actually funded. The comment says "legacy fixtures" but the code path is live for any payload shape Convex emits.
**Impact:** Silent total billing failure for any project whose payload drops `clerkOrgId`.
**Fix:** Make `clerkOrgId` required; if absent, fail the lookup (return `null` + log) rather than silently aliasing a non-equivalent id.

#### [P2] Unbounded `orgSlug`/`projectSlug` (from URL path) used as cache key
```ts
const key = `${orgSlug}/${projectSlug}`;
```
`orgSlug` and `projectSlug` come straight from `parseGatewayPath(url.pathname)` with no length or character validation. A request to `/gateway/AAAA…(64KB)…/BBBB…(64KB)…/` produces a ~128KB cache key stored in the `#cache` Map. With `MEMORY_MAX = 256` and no per-key cap, that's ~32MB per isolate from a single malicious pattern repeated across 256 distinct slugs. (The prior review noted this for `catalogue-source.ts` but not here.)
**Impact:** Memory amplification / isolate OOM via crafted path slugs.
**Fix:** Cap `orgSlug`/`projectSlug` to a sane length (e.g. 64 chars) and a slug character class at the `parseGatewayPath` boundary; reject oversized paths before they reach the cache.

#### [P2] No in-flight dedup — thundering herd on cold cache
`CachedSpecSource#getPublishedSpec` fires `this.#inner.getPublishedSpec(...)` for every caller that observes a miss. With the cache dead (per P1 above), *every* concurrent request for the same spec fires a Convex query. Even after the cache is hoisted to module scope, a cold cache under burst load fires N identical Convex queries.
**Fix:** Track an in-flight `Promise` per key; coalesce concurrent callers onto a single upstream call.

#### [P2] FIFO eviction, not LRU
```ts
if (this.#cache.size >= MEMORY_MAX) {
  const first = this.#cache.keys().next().value;
  if (first !== undefined) this.#cache.delete(first);
}
```
Map iteration order is insertion order, so this is FIFO. Under cardinality pressure (many distinct org/project pairs), a hot entry that was inserted early is evicted by a flood of cold one-off entries, defeating the cache for the hot key. Use an LRU (re-insert on access, or a dedicated LRU structure).

#### [P3] `visibility` defaults to `"private"` — silent marketplace break on schema regression
```ts
let visibility: "public" | "private" = "private";
```
Fail-closed is the safer default and the comment says so. But if a Convex schema change or projection regression drops `visibility` from the payload, **every** project silently becomes owner-only → the entire public marketplace stops accepting foreign keys, with no error. There is no metric or log when the default engages.
**Fix:** Log a warning when `visibility` is absent so a schema regression is observable, even while staying fail-closed.

#### [P3] Unparseable `spec` string cached as-is
`parsePublishedSpecPayload` only checks `typeof candidate.spec === "string"`; it does not parse the OpenAPI. The pipeline later calls `parseSpec` and returns `404 invalid_spec`. If the cache were live (see P1), an unparseable spec would be served for the full 30s TTL, 404-ing every consumer. With the cache dead, each request re-pays the parse cost. Either way, validating at cache-fill time (and refusing to cache an unparseable spec) is cheaper and avoids advertising a broken project.

#### [P3] `deprecatedAt` / `sunsetAt` unit ambiguity
```ts
// pipeline.ts
outHeaders.set("Deprecation", `@${Math.floor(published.deprecatedAt / 1000)}`);
outHeaders.set("Sunset", new Date(published.sunsetAt).toUTCString());
```
The pipeline assumes `deprecatedAt`/`sunsetAt` are epoch **milliseconds** (divides by 1000 for the `Deprecation` header, passes to `Date()` for `Sunset`). `spec-source.ts` only checks `Number.isFinite`. If Convex ever returns epoch **seconds** (a common OpenAPI/HTTP convention), `Deprecation` becomes `@<seconds/1000>` (year ~1970) and `Sunset` becomes a date in 1970. No assertion catches this.
**Fix:** Document the unit contract in the `PublishedSpec` type and assert the value is in a plausible ms range (e.g. `> 1_000_000_000_000`) at parse time.

#### [P3] `parsePublishedSpecPayload` `"value" in json` unwrap couples to Convex wire shape
```ts
if ("value" in json) { candidate = json.value; }
```
This handles the `ConvexHttpClient.query` envelope, but it's an implicit coupling to Convex's internal wire format. If Convex changes the envelope, or if a fixture passes a plain object that happens to have a `value` field, parsing silently drills into the wrong layer. Make the unwrap explicit (a dedicated `unwrapConvexValue` helper with a comment naming the Convex shape it expects).

---

### catalogue-source.ts

#### [P1] TTL cache is dead in production — same root cause as `spec-source.ts`
```ts
// index.ts:91
catalogueSource: new CachedCatalogueSource({ inner: innerCatalogue, ttlMs: 60_000 }),
```
Identical to the spec-source P1: `buildDeps` runs per request, the `#cache` Map is instance-scoped, the 60s TTL never hits across requests. Every `/discovery` and every MCP `search_apis` call hits Convex `catalogue:listPublic`. For `/discovery` this compounds: `buildDiscoveryIndex` calls `listPublic()` once, then `getPublishedSpec` for **every** catalogue item — so a 1000-project catalogue with the dead caches issues 1001 Convex queries per `/discovery` request. **Corrects the prior review's "cached 60s" premise.**
**Fix:** Hoist `CachedCatalogueSource` to module/per-env scope (same fix as spec-source P1).

#### [P2] Convex errors swallowed and returned as a valid empty page — indistinguishable from "no results"
```ts
} catch (err) {
  console.error("ConvexCatalogueSource.listPublic failed", err);
  return { items: [], nextCursor: null };
}
```
A transient Convex failure returns the same shape as a legitimate empty search. `parseCataloguePage` also coerces `null`/junk to `null`, and `ConvexCatalogueSource.listPublic` then returns `{ items: [], nextCursor: null }` via the `?? { items: [], nextCursor: null }` fallback. So "Convex is down", "no matches", and "bad payload" all look identical to the caller. During a Convex outage, `/discovery` returns `{ apis: [] }` and MCP `search_apis` returns `{ matches: [] }` — agents conclude the catalogue is empty and stop trying.
**Impact:** Silent catalogue outage masquerading as "empty"; agents and dashboards show no APIs during any control-plane blip.
**Fix:** Throw on Convex failure (or return a tagged `{ degraded: true, items: [] }`); let the caller emit `503` or a degraded flag. Never return an error-shaped value as a success.

#### [P2] Unbounded user-controlled `search`/`tag`/`cursor` into cache key + Convex query
```ts
function cacheKey(args) {
  const search = args?.search ?? "";
  const tag = args?.tag ?? "";
  const cursor = args?.cursor ?? "";
  return `${search}\0${tag}\0${cursor}`;
}
```
`search`/`tag`/`cursor` flow from MCP tool arguments (`search_apis` `query`, `get_api_docs` has none, but `search_apis` passes `args.query` as `search`) and are unbounded strings. With the cache live (after the P1 fix), an attacker issuing `search_apis({ query: "<1MB>" })` stores a 1MB key in the Map; 64 entries × 1MB = 64MB per isolate. The `cursor` is also passed straight to `ConvexHttpClient.query` as `cursor: args?.cursor` — a 1MB opaque string to Convex, which may error (then get swallowed per the above) or cost query parse time. Even with the cache dead today, the `cursor` is forwarded to Convex unvalidated on every request.
**Impact:** Memory amplification + Convex query DoS via crafted search/cursor.
**Fix:** Cap `search`/`tag` length (e.g. 256 chars) and `cursor` length (e.g. 1024) at the `listPublic` entry; reject or truncate before keying/querying.

#### [P2] Mutable references to shared cached state
```ts
async listPublic(args) {
  ...
  const hit = this.#cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;   // returns the cached object reference
  ...
}
```
`listPublic` returns `hit.value` — the cached `CataloguePage` object — directly. Callers (`discovery.buildDiscoveryIndex`, `mcp.handleSearchApis`) iterate `page.items` read-only today, so no corruption yet. But there is no defensive copy, so the moment any caller sorts, filters in place, or mutates an item, the cached value is corrupted for all subsequent callers within the TTL. The same pattern exists in `spec-source.ts` (`return hit.value`). `FixtureCatalogueSource.listPublic` returns a fresh array each call (via `.slice()`), so the fixture is safe but the cached Convex source is not.
**Fix:** Either return a deep-frozen copy (`Object.freeze` on `items` and each item), or document immutability and freeze at cache-fill time.

#### [P2] FIFO eviction, not LRU
Same as spec-source: `this.#cache.keys().next().value` evicts the oldest insertion, not the least-recently-used. Under a high-cardinality flood of distinct search terms, a hot search (e.g. the empty-search default used by `/discovery`) can be evicted and re-fetched on every call.

#### [P2] No in-flight dedup — thundering herd
Same as spec-source. `/discovery` and a burst of MCP `search_apis` for the same query all fire concurrent Convex queries on a cold cache. Coalesce onto a single in-flight `Promise` per key.

#### [P3] `cacheKey` uses `\0` separator — collision via NUL in input
A `search` containing a literal `\0` (possible in some encodings, or via a tool arg that bypasses URL decoding) can collide with a different `(search, tag, cursor)` tuple. Use a structured key (JSON.stringify of a normalized tuple) or a separator that's rejected by input validation.

#### [P3] Search/tag normalization mismatch between Fixture and Convex sources
```ts
// FixtureCatalogueSource.listPublic
const search = args?.search === undefined ? "" : args.search.trim().toLowerCase();
```
`FixtureCatalogueSource` trims+lowercases `search`/`tag` before filtering; `ConvexCatalogueSource` passes the raw `args.search` to Convex and `cacheKey` uses the raw value. Once the cache is live, `"Foo"` and `"foo"` produce different cache keys but (depending on Convex's `listPublic` collation) the same result → cache duplication. Normalize at the `CatalogueListArgs` boundary, not per source.

#### [P3] `FixtureCatalogueSource.listPublic` ignores `cursor` — pagination broken in fixtures
The fixture always returns `nextCursor: null` and ignores `args.cursor`. Tests that exercise pagination against the fixture cannot detect a pagination regression. Either implement cursor-based slicing in the fixture or document it as pagination-unaware and exclude it from pagination tests.

---

### x402.ts

#### [P2] No `cache-control: no-store` on 402 — top-up effect delayed by CDN/browser cache
```ts
return new Response(JSON.stringify(body), {
  status: 402,
  headers: {
    "content-type": "application/json",
    "www-authenticate": 'Bearer realm="zevium"',
    "x-zevium-request-id": requestId,
  },
});
```
A `402 insufficient_credits` with no cache directive can be heuristically cached by Cloudflare's edge or a browser. A consumer who tops up and retries within the cache window keeps getting the stale `402`, with `available` showing the pre-top-up balance — a confusing billing experience and support burden. Same class of bug as `errors.ts` P2.
**Fix:** Add `"cache-control": "no-store"`.

#### [P2] `extra` merges after base fields — caller can clobber `error`, `detail`, `actions`, `requestId`
```ts
const body: Record<string, unknown> = {
  error: "payment_required", detail, actions: ACTIONS, requestId,
};
if (extra) {
  for (const [k, v] of Object.entries(extra)) {
    body[k] = v;   // caller can set body.error / body.actions / body.requestId
  }
}
```
Identical pattern to `errors.ts`. The pipeline passes `extra: { reason, available, cost }` (safe), but nothing prevents a future caller from passing `extra: { actions: {…}, requestId: "<forged>" }` and overwriting the base envelope. The `actions` object especially is load-bearing for agent self-service — clobbering it (or `requestId`) breaks the contract.
**Fix:** Merge `extra` first, then apply base fields; or reject reserved keys in the `extra` loop.

#### [P3] `actions` hardcoded to `https://zevium.dev/...`
```ts
const ACTIONS = {
  createKey: "https://zevium.dev/app/settings/keys",
  topUp: "https://zevium.dev/app/billing",
  docs: "https://zevium.dev/docs/consuming",
} as const;
```
Hardcoded production domain. On staging, preview, self-hosted, or white-label deployments, the action URLs point to the wrong place — agents following them land on production. Derive from the request origin or an env var (`PUBLIC_APP_ORIGIN`).

#### [P3] `www-authenticate: Bearer` on a 402 is non-standard
RFC 9110 scopes `WWW-Authenticate` to `401 Unauthorized`. On `402 Payment Required` the header is non-standard and clients may ignore or misinterpret it. The x402 spec arguably justifies it, but document the choice or move to a `payment-required` scheme that names the x402 protocol explicitly.

#### [P3] No `x-zevium-cost` header on 402
The 402 body includes `cost` (via `extra`), but the response header set does not include `x-zevium-cost`. Success responses set it; errors (per `errors.ts` P3) don't either. Pick one contract: either every gateway response carries `x-zevium-cost`, or none do. Inconsistent headers break uniform client parsing.

#### [P3] `detail` and `extra` values not length-validated
`detail` is a caller-supplied string placed directly into the JSON body; `extra` values are arbitrary. A caller passing a multi-megabyte `detail` produces a multi-megabyte 402 body. Cap `detail` length and validate `extra` values are JSON-serializable primitives.

---

## Summary

**Counts:** P0 = 0 · P1 = 6 · P2 = 15 · P3 = 23 · **Total = 44 findings.**

**Top 3 (must fix before ship):**

1. **Dead TTL caches (P1, spec-source + catalogue-source).** `index.ts#buildDeps` reconstructs `CachedSpecSource`/`CachedCatalogueSource` per request, so the 30s/60s caches never hit across requests. Convex QPS scales 1:1 with gateway QPS. This also **corrects the prior reviews**, which analyzed cache-staleness/negative-caching behavior that does not occur in production. Hoist the cached sources to module/per-env scope.

2. **`headers.ts` forwards `Cookie` and reflects `Set-Cookie` (P1 ×2).** An API-key gateway must never ride consumer session state to the upstream nor inject upstream cookies back to the consumer. Add both to the strip lists.

3. **`errors.ts` "Never leaks internals" is an unenforced contract actively violated by `pipeline.ts:260` (P1).** Raw `err.message` from upstream fetch failures is piped into the client body. `errors.ts` must own message safety (fixed string for 5xx, server-side log of the raw error), and the same fix applies to `mcp.ts:467`.

**Corrections to prior reviews:**
- The prior spec-source review's "cached 30s = false-404 outage", "30s stale pricing", and "negative-caching delays newly-published" findings are **moot** — the cache does not persist across requests. The real impact is *no caching at all* (P1 above). The transient-error-to-`null` masking is still real and still P1.
- The prior catalogue-source review's "caches Convex error responses as valid empty pages 60s" is **moot as a caching issue** but the error-swallowing itself remains (reclassified P2: indistinguishable from legitimate empty). The "unbounded search/tag/cursor" and "mutable references" findings are confirmed and expanded.
- The prior errors.ts+headers.ts review's `Cookie`/`Set-Cookie`, `Connection` header-list, `err.message` leak, and `requestId` unsanitized findings are all **confirmed** and expanded with concrete fix paths.
