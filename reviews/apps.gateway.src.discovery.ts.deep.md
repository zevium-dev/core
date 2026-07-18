# Tiger Deep Review — `apps/gateway/src/discovery.ts`

Scope: `discovery.ts` (primary, full read), deep integration read of `apps/gateway/src/index.ts`, `apps/gateway/src/mcp.ts`, `apps/gateway/src/catalogue-source.ts`, `apps/gateway/src/spec-source.ts`, `apps/gateway/src/pipeline.ts`, `apps/gateway/src/headers.ts`, `packages/shared/src/openapi.ts`, and Convex `catalogue.ts` / `specs.ts` to verify every prior finding against the real control-plane queries.

## Verdict

**Incorrect + leaks + availability risk.** All 8 prior findings verified against source. The catalogue pagination truncation (P1) and the `get_api_docs` private-spec leak (P1) are confirmed real and load-bearing. Three new defects expand the picture: (a) `buildDeps` constructs a fresh `CachedCatalogueSource` + `CachedSpecSource` on every request, so the documented 60s/30s TTL caches deliver **zero cross-request caching in production** — every `/discovery` and `/mcp` hit re-queries Convex for the catalogue plus one spec per listing; (b) `mcp.ts handleSearchApis` repeats the exact pagination truncation, so `search_apis` is a second silently-capped discovery surface; (c) `gatewayOrigin` is derived from the request `Host` header, letting an anonymous caller poison the `gatewayBaseUrl` returned to consumers/agents. The `/discovery` endpoint is unauthenticated, uncached-at-runtime, N+1-sequential, and unrate-limited — a clean DoS amplifier against the Convex control plane.

## File Stats

- File: `apps/gateway/src/discovery.ts` (~118 lines, full read)
- Functions reviewed: `endpointsFromSpec`, `buildDiscoveryIndex`, `handleDiscoveryRequest`
- Integration read: `index.ts` (routing + `buildDeps`/`discoveryDeps`), `mcp.ts` (parallel discovery surfaces), `catalogue-source.ts`, `spec-source.ts`, `pipeline.ts`, `headers.ts`, `packages/shared/src/openapi.ts`, `convex/catalogue.ts`, `convex/specs.ts`

## Findings

### [P1] `/discovery` silently truncates to the first 24-item page — `nextCursor` ignored  ✅ verified

**Location:** `apps/gateway/src/discovery.ts:76`
```ts
const page = await deps.catalogueSource.listPublic();
```
**Problem.** `listPublic()` is called with no args and `page.nextCursor` is never consumed. The backing query `catalogue:listPublic` paginates at `PAGE_SIZE = 24` (`convex/catalogue.ts:7`, `slice(start, start + PAGE_SIZE)` at `:220`) and returns `nextCursor` as an offset string when more rows remain (`catalogue.ts:222`). `CataloguePage.nextCursor` is typed on the gateway side (`catalogue-source.ts:20`) but `buildDiscoveryIndex` discards it. The `for (const item of page.items)` loop processes only the first 24 public APIs and returns.
**Impact.** Every consumer/agent hitting `GET /discovery` sees at most 24 APIs. Past 24 published projects — the normal marketplace state — the discovery index is silently incomplete: publishers' APIs are unlisted, agents cannot discover or price them, and there is no error/degraded signal. Load-bearing correctness defect on the primary public discovery surface.
**Fix.** Follow the cursor to exhaustion (and parallelize per F6):
```ts
let cursor: string | undefined;
do {
  const page = await deps.catalogueSource.listPublic(
    cursor === undefined ? undefined : { cursor },
  );
  cursor = page.nextCursor ?? undefined;
  apis.push(...await Promise.all(page.items.map((i) => buildApi(deps, i))));
} while (cursor !== undefined);
```

---

### [P1] `mcp.ts get_api_docs` leaks private published specs to anonymous callers  ✅ verified

**Location:** `apps/gateway/src/mcp.ts:217-243` (`handleGetApiDocs`)
```ts
const published = await deps.specSource.getPublishedSpec(org, project);
if (!published) { return toolError(`Unknown public API: ${org}/${project}`); }
// …no visibility check…
endpoints = endpointsFromSpec(parsed);
```
**Problem.** Verified against the control plane: `specs:getPublishedForGateway` (`convex/specs.ts:278-309`) returns the spec for **any** `status === "published"` project **regardless of `visibility`** — it returns `visibility` as a field but never filters on it. `handleGetApiDocs` accepts arbitrary `org`/`project` from tool args with no auth (the `/mcp` route at `index.ts:114-119` calls `handleMcpRequest` with no key check; only `call_api` requires a key) and never inspects `published.visibility`. The pipeline (`pipeline.ts`) *does* enforce visibility for `call_api` (`if (published.visibility !== "public" && verified.orgId !== published.clerkOrgId) return 404`), but `get_api_docs` bypasses the pipeline and reads the spec directly.
**Impact.** Any anonymous caller can enumerate private published APIs by guessing org+project slugs and receive the full endpoint list (paths, methods, summaries) plus per-endpoint pricing (`x-zevium-cost`, `freeTier`) for otherwise-hidden marketplace APIs. This is the concrete "unauthenticated discovery leaking private specs" defect; `discovery.ts` itself is protected by `catalogue:listPublic`'s `visibility === "public"` index filter (`catalogue.ts:127-128,138-139`), but `get_api_docs` defeats that gate by going straight to the spec source.
**Fix.** Enforce visibility where the spec is consumed:
```ts
if (!published || published.visibility !== "public") {
  return toolError(`Unknown public API: ${org}/${project}`);
}
```
Note `SpecSource.getPublishedSpec` *does* parse `visibility` and fails closed to `"private"` when absent (`spec-source.ts` `parsePublishedSpecPayload`), so the field is trustworthy — it just isn't checked here.

---

### [P1 — NEW] `mcp.ts handleSearchApis` repeats the pagination truncation — second silently-capped discovery surface

**Location:** `apps/gateway/src/mcp.ts:179-205` (`handleSearchApis`)
```ts
const page = await deps.catalogueSource.listPublic({
  search: query.trim() === "" ? undefined : query,
});
for (const item of page.items) { … }
```
**Problem.** Identical defect to F1 on the MCP search surface. `listPublic({search})` returns at most 24 matches and a `nextCursor` that `handleSearchApis` discards. An agent searching a broad term ("api", "chat", etc.) silently receives only the first 24 results with no `hasMore`/`nextCursor` signal in the tool output.
**Impact.** Agents using `search_apis` cannot see beyond 24 matches; for a catalogue with many similarly-tagged APIs the tool is quietly incomplete and the agent has no way to know it is truncated (the JSON returned has no pagination metadata at all).
**Fix.** Same cursor-follow loop as F1, or at minimum surface `nextCursor`/`total` in the returned JSON so the agent can request the next page.

---

### [P2 — NEW] `buildDeps` constructs fresh cache instances per request — TTL caches are useless in production

**Location:** `apps/gateway/src/index.ts:53-90` (`buildDeps`), called per-request at `index.ts:104,113,121,127`
```ts
function buildDeps(env: Env): WorkerDeps {
  if (testDeps) return testDeps;
  …
  return {
    keyVerifier,
    specSource: new CachedSpecSource({ inner: innerSpec }),
    catalogueSource: new CachedCatalogueSource({ inner: innerCatalogue, ttlMs: 60_000 }),
    usageSink,
  };
}
…
if (parts[0] === "discovery" && parts.length === 1) {
  const deps = buildDeps(env);   // ← fresh per request
  return withCors(await handleDiscoveryRequest(request, discoveryDeps(deps, request)));
}
```
**Problem.** `buildDeps` is invoked inside the fetch handler for every request and instantiates brand-new `CachedCatalogueSource` / `CachedSpecSource` objects. Their backing `Map`s live on the instance, so the cache dies with the request. The only module-scoped state is `testDeps` (test-only). The 60s/30s TTLs documented in `catalogue-source.ts` / `spec-source.ts` therefore provide **zero cross-request benefit in production** — every `/discovery` re-queries `catalogue:listPublic` plus one `specs:getPublishedForGateway` per listing. The `Cached*Source` classes are dead weight in the prod path; they only earn their keep in the in-isolate test harness.
**Impact.** Compounds the N+1 finding: the spec cache cannot amortize repeat lookups across requests, so the gateway hammers Convex on every public discovery hit. Combined with the DoS-amplifier finding this is an availability defect, not just a perf nit.
**Fix.** Hoist the `CachedCatalogueSource`/`CachedSpecSource` (and `ConvexHttpClient`) to module scope keyed by `env.CONVEX_URL`, or memoize `buildDeps(env)` per isolate so the caches actually persist across requests. The caches are already TTL-bounded and FIFO-evicting, so staleness is unaffected.

---

### [P2] `buildDiscoveryIndex` does not filter fetched specs by `visibility` (cache-staleness leak window)  ✅ verified

**Location:** `apps/gateway/src/discovery.ts:78-92`
```ts
for (const item of page.items) {
  const published = await deps.specSource.getPublishedSpec(item.orgSlug, item.slug);
  let endpoints: DiscoveryEndpoint[] = [];
  if (published) {
    try { endpoints = endpointsFromSpec(parseSpec(published.spec)); } catch { endpoints = []; }
  }
  …apis.push({ … endpoints … });
}
```
**Problem.** The catalogue listing is filtered to `visibility === "public"` at query time (`catalogue.ts:127`), but the spec is fetched from a separate `CachedSpecSource` (30s TTL) layered over `CachedCatalogueSource` (60s TTL), plus the response carries `cache-control: public, max-age=60` (`discovery.ts:113`). When a project flips public→private, all three layers lag: catalogue cache (≤60s) + spec cache (≤30s, and the spec's `visibility` field is stale `"public"` until refreshed) + CDN edge (≤60s). `buildDiscoveryIndex` never re-checks `published.visibility`, so the freshly-private API's endpoint paths + pricing keep flowing through unauthenticated `/discovery` for up to ~150s.
**Impact.** Defense-in-depth gap: a narrow but real window where a publisher's revocation of public visibility does not immediately take effect on the public discovery index. Cheap to close.
**Fix.** `if (published && published.visibility !== "public") continue;` inside the loop. (Also tightens the `get_api_docs`-class leak at the discovery surface.)

---

### [P2] N+1 sequential spec fetches per `/discovery` request  ✅ verified

**Location:** `apps/gateway/src/discovery.ts:78-81`
```ts
for (const item of page.items) {
  const published = await deps.specSource.getPublishedSpec(item.orgSlug, item.slug);
```
**Problem.** Each listing triggers an `await` inside the loop — up to 24 (or, after the pagination fix, N) sequential Convex HTTP round-trips on the request critical path with no `Promise.all`. Latency grows linearly with catalogue size. Worse given the per-request cache defect: none of these are cached across requests.
**Impact.** Slow discovery responses; once pagination is fixed, a request that O(N)-sequentializes fully-parallelizable work on a public, unauthenticated endpoint anyone can hammer.
**Fix.** `Promise.all(page.items.map((item) => buildApi(deps, item)))` per page.

---

### [P2] `handleDiscoveryRequest` builds the full index for `HEAD` then discards it  ✅ verified

**Location:** `apps/gateway/src/discovery.ts:105-113`
```ts
const index = await buildDiscoveryIndex(deps);
if (request.method === "HEAD") {
  return new Response(null, { status: 200, headers: { … } });
}
```
**Problem.** `buildDiscoveryIndex(deps)` runs the entire catalogue + N spec fetches *before* the HEAD branch discards the body. HEAD is supposed to be cheap; instead it performs the full work of GET and throws the result away.
**Impact.** Any HEAD probe (monitoring, preflight checks) pays the full discovery cost in subrequests and CPU for no payload — amplified by the per-request cache defect so even repeated HEAD probes re-hit Convex.
**Fix.** Branch on `request.method === "HEAD"` *before* calling `buildDiscoveryIndex` and return the empty 200 directly.

---

### [P2 — NEW] `gatewayBaseUrl` derived from the request `Host` header — anonymous origin poisoning

**Location:** `apps/gateway/src/index.ts:98-102` (`discoveryDeps`), `:104-108` (`mcpDeps`), consumed at `discovery.ts:94` and `mcp.ts:237`
```ts
function discoveryDeps(deps: WorkerDeps, request: Request): DiscoveryDeps {
  return { …, gatewayOrigin: new URL(request.url).origin };
}
…
gatewayBaseUrl: `${origin}/gateway/${item.orgSlug}/${item.slug}`,
```
**Problem.** `gatewayOrigin` is taken from `new URL(request.url).origin`, which reflects the request `Host` header. The gateway does not fetch `gatewayBaseUrl` itself (so this is not classic SSRF), but it **returns** it to consumers/agents as the canonical call target in both `/discovery` and `get_api_docs`. An anonymous caller reaching the worker via an alternate hostname (workers.dev subdomain, staging alias, tunnel, or any environment where CF does not pin a single Host) receives `gatewayBaseUrl: https://<attacker-host>/gateway/…`. An agent that ingests discovery/search output and then calls that URL is redirected to the attacker. This is the real substance behind the prior "unvalidated slugs" note — the slugs are Convex-validated, the origin is not.
**Impact.** Open-redirect / consumer-redirection to attacker-controlled hosts via the public discovery surface; the advertised contract URL is attacker-influenceable.
**Fix.** Derive `gatewayOrigin` from a configured env var (e.g. `GATEWAY_ORIGIN`) with `new URL(request.url).origin` only as a fallback, and validate it is an `https://` origin.

---

### [P2 — NEW] `/discovery` is a public, unauthenticated, runtime-uncached, N+1, unrate-limited DoS amplifier

**Location:** `apps/gateway/src/index.ts:104-108` (route), `discovery.ts:65-103` (handler)
**Problem.** Composed defect: `/discovery` is public (no key, `index.ts:104`), performs 1 catalogue + up to 24 spec Convex HTTP round-trips per request, none cached across requests (per-request `buildDeps`), sequential (N+1), with no rate limit and no auth gate. The only mitigation is `cache-control: public, max-age=60` on the GET body — but that only helps when a CDN edge sits in front and only for identical GETs; HEAD (full-build-then-discard) and cache-miss GETs still do full work, and the worker CPU/subrequest budget is per-request.
**Impact.** An anonymous attacker can multiply one cheap HTTP request into 25 Convex control-plane queries, exhausting the worker subrequest limit and Convex throughput on the marketplace's primary discovery endpoint.
**Fix.** Fixing the per-request cache (shared caches) + `Promise.all` removes most of the amplification; add a hard ceiling on catalogue size walked per request and consider an unauthenticated rate limit (CF WAF / token bucket) on `/discovery` and `/mcp`.

---

### [P3] `endpointsFromSpec` advertises `options`/`head`/`trace` as billable — TRACE is also proxyable (XST)  ✅ verified + expanded

**Location:** `apps/gateway/src/discovery.ts:22-33`; `packages/shared/src/openapi.ts:13-22` (`HttpMethod`/`HTTP_METHODS`); `pipeline.ts` `matchOperation` path
```ts
const HTTP_METHODS: readonly HttpMethod[] =
  ["get","post","put","patch","delete","options","head","trace"];
```
**Problem.** Discovery emits a `DiscoveryEndpoint` (with `credits`) for every method on a path item, including `options`/`head`/`trace`. Verified that `matchOperation` (`packages/shared/src/openapi.ts`) accepts the same set including `trace`, so the gateway pipeline **will proxy a TRACE request** if a published spec declares a TRACE operation — TRACE reflection is the classic XST vector and can bounce auth headers back to the client. Discovery also charges ≥1 credit for these (see phantom-pricing finding).
**Impact.** Misleading discovery output (agents plan calls against unpriced/uncallable methods) plus a latent XST reflection path through the metered proxy if any publisher declares TRACE.
**Fix.** Drop `options`/`head`/`trace` from the discovery `HTTP_METHODS` list, and at minimum reject `TRACE` in `matchOperation`/the pipeline regardless of spec.

---

### [P3] Malformed spec silently yields `endpoints: []` with no degraded signal  ✅ verified

**Location:** `apps/gateway/src/discovery.ts:82-86`
```ts
try { const parsed = parseSpec(published.spec); endpoints = endpointsFromSpec(parsed); }
catch { endpoints = []; }
```
**Problem.** Parse failure for a published spec is swallowed with no log and no flag; the API still appears in discovery with `endpoints: []` and no pricing. Consumers cannot distinguish "API has no endpoints" from "spec is broken on the gateway side," and operators get no signal that a published spec is unreadable.
**Impact.** Silent degradation of discovery quality; no observability hook for malformed published specs.
**Fix.** `console.warn` the failure (consistent with `ConvexCatalogueSource`/`ConvexSpecSource` error logging) and/or surface a `degraded: true` flag on the `DiscoveryApi`.

---

### [P3] `gatewayBaseUrl` built from unvalidated `orgSlug`/`slug`  ✅ verified (reframed — see origin-poisoning finding for the real vector)

**Location:** `apps/gateway/src/discovery.ts:96`
```ts
gatewayBaseUrl: `${origin}/gateway/${item.orgSlug}/${item.slug}`,
```
**Problem.** `orgSlug`/`slug` are interpolated raw. Convex validates slugs at project creation (so path traversal is unlikely today), but the gateway URL is the contract consumers/agents call against, so a malformed value would propagate directly. The higher-impact variant of this concern is the origin-poisoning finding (Host-header), which is genuinely exploitable; this slug interpolation is defense-in-depth only.
**Impact.** Low under current constraints; rises if slug validation ever loosens.
**Fix.** `encodeURIComponent(item.orgSlug)` / `encodeURIComponent(item.slug)` before interpolation.

---

### [P3 — NEW] Discovery drops spec deprecation + metadata that the pipeline already signals

**Location:** `apps/gateway/src/discovery.ts:88-97` (`DiscoveryApi` shape); compare `spec-source.ts` `PublishedSpec` (has `deprecatedAt`/`sunsetAt`/`deprecationMessage`) and `pipeline.ts` (sets `Deprecation`/`Sunset`/`Link` response headers)
**Problem.** `PublishedSpec` carries `deprecatedAt`, `sunsetAt`, `deprecationMessage`, and the spec's `info.title`/`info.version`, but `DiscoveryApi` surfaces none of them — `get_api_docs` in `mcp.ts:227-243` *does* expose `title`/`version` but not deprecation either. So a consumer reading `/discovery` sees endpoint pricing for a deprecated API with no hint, while a caller hitting the gateway directly gets `Deprecation`/`Sunset` headers. Inconsistent surface.
**Impact.** Agents planning via discovery have no deprecation signal and may build against APIs scheduled for removal; the gateway pipeline knows but the discovery index doesn't.
**Fix.** Add optional `deprecatedAt?`/`sunsetAt?`/`version?`/`title?` to `DiscoveryApi` and populate from `published`/`parsed.info`.

---

### [P3 — NEW] `extractPricing` defaults cost to 1 for unpriced operations → discovery advertises phantom pricing

**Location:** `packages/shared/src/openapi.ts:176-185` (`extractPricing`); consumed by `discovery.ts:73`
```ts
const cost = costRaw !== undefined && costRaw > 0 ? Math.floor(costRaw) : 1;
```
**Problem.** Any operation without a positive `x-zevium-cost` is priced at 1 credit. So `/discovery` advertises `credits: 1` for endpoints the publisher never explicitly priced — including `options`/`head`/`trace`. The pipeline charges the same default, so behavior is consistent, but the discovery index presents fabricated per-endpoint pricing as if it were declared.
**Impact.** Misleading cost planning for agents; no way to distinguish "publisher priced this at 1" from "gateway defaulted to 1."
**Fix.** Omit `credits` (or emit `credits: 0`/`priced: false`) when `x-zevium-cost` is absent, so discovery reflects what the publisher actually declared.

---

## Summary

- **Findings: 14** — 0×P0, **3×P1**, **6×P2**, **5×P3**. (Prior review: 2×P1 + 3×P2 + 3×P3 — all 8 verified; 6 new findings added.)
- **Top 3:**
  1. **[P1, verified]** `/discovery` paginates at 24 items and never follows `nextCursor` — silently incomplete catalogue index; `mcp.ts handleSearchApis` repeats the same truncation (new P1).
  2. **[P1, verified]** `mcp.ts get_api_docs` lets anonymous callers pull full endpoint/pricing data for *any* published project including private ones — `specs:getPublishedForGateway` returns private specs and `get_api_docs` never checks `visibility`.
  3. **[P2, new]** `buildDeps` runs per request, so `CachedCatalogueSource`/`CachedSpecSource` provide zero cross-request caching in production — every `/discovery` re-hammers Convex with N+1 sequential queries on an unauthenticated, unrate-limited endpoint (DoS amplifier).
