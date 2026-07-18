# Tiger Review — `apps/gateway/src/discovery.ts`

Scope: `discovery.ts` (primary), with `index.ts` + `mcp.ts` + `catalogue-source.ts` + `spec-source.ts` + Convex `catalogue.ts`/`specs.ts` read for integration context.

## Verdict

**Incorrect.** The discovery index silently truncates to the first page of the catalogue (24 items) and never follows `nextCursor`, so any deployment with more than 24 public APIs serves an incomplete index to every consumer/agent. The builder also fetches published specs without checking `visibility`, leaving a cache-staleness window where a freshly-flipped-private API keeps leaking endpoint paths + pricing through the unauthenticated `/discovery` endpoint. The same visibility gap is concretely exploitable in `mcp.ts get_api_docs`, which lets an anonymous caller pull the full endpoint/pricing list of *any* published project — including private ones — by org/project slug.

## File Stats

- File: `apps/gateway/src/discovery.ts` (~118 lines)
- Touched functions: `endpointsFromSpec`, `buildDiscoveryIndex`, `handleDiscoveryRequest`
- Integration read: `index.ts` (routing), `mcp.ts` (parallel discovery surface), `catalogue-source.ts`, `spec-source.ts`, `convex/catalogue.ts`, `convex/specs.ts`

## Findings

### [P1] `/discovery` silently truncates the catalogue — `buildDiscoveryIndex` ignores pagination

**Location:** `apps/gateway/src/discovery.ts:76`
```ts
const page = await deps.catalogueSource.listPublic();
```

**Problem.** `listPublic()` is called with no args and the result's `nextCursor` is never consumed. The backing Convex query `catalogue:listPublic` paginates at `PAGE_SIZE = 24` (`convex/catalogue.ts:5`, slice at `:222`), returning `nextCursor` as an offset string when more rows remain. `CataloguePage.nextCursor` is typed on the gateway side (`catalogue-source.ts:20`) but `buildDiscoveryIndex` discards it. The `for (const item of page.items)` loop therefore processes only the first 24 public APIs and returns.

**Impact.** Every consumer/agent hitting `GET /discovery` sees at most 24 APIs. Catalogue growth past 24 published projects — the normal case for a marketplace — makes the discovery index silently incomplete: publishers' APIs are unlisted, agents can't discover or price them, and there is no error/degraded signal. This is a load-bearing correctness defect on the primary public discovery surface.

**Fix.** Follow the cursor until exhausted (and parallelize per below):
```ts
const apis: DiscoveryApi[] = [];
let cursor: string | undefined;
do {
  const page = await deps.catalogueSource.listPublic(
    cursor === undefined ? undefined : { cursor },
  );
  cursor = page.nextCursor ?? undefined;
  const expanded = await Promise.all(
    page.items.map((item) => buildApi(deps, item)),
  );
  apis.push(...expanded);
} while (cursor !== undefined);
return { apis };
```

---

### [P1] `mcp.ts get_api_docs` leaks private published specs to anonymous callers (parallel discovery surface)

**Location:** `apps/gateway/src/mcp.ts:217-243` (`handleGetApiDocs`)
```ts
const published = await deps.specSource.getPublishedSpec(org, project);
if (!published) {
  return toolError(`Unknown public API: ${org}/${project}`);
}
// …no visibility check…
endpoints = endpointsFromSpec(parsed);
```

**Problem.** `handleGetApiDocs` accepts arbitrary `org`/`project` from tool arguments with no authentication — the `/mcp` route (`index.ts:114-119`) calls `handleMcpRequest` with no key check, and only `call_api` requires a key. `SpecSource.getPublishedSpec` is backed by `specs:getPublishedForGateway`, which (`convex/specs.ts:278-309`) returns the spec for *any* `status === "published"` project **regardless of visibility** — `visibility` is returned as a field but never enforced. `handleGetApiDocs` never inspects `published.visibility`.

**Impact.** Any anonymous caller can enumerate private published APIs by guessing/enumerating org+project slugs and receive the full endpoint list (paths, methods, summaries) plus per-endpoint pricing (`x-zevium-cost`, `freeTier`) for otherwise-hidden marketplace APIs. This is the concrete "unauthenticated discovery leaking private specs" defect. `discovery.ts` itself is protected by `catalogue:listPublic`'s `visibility === "public"` index filter, but `get_api_docs` bypasses the catalogue and goes straight to the spec source, defeating that gate.

**Fix.** Enforce visibility at the discovery/MCP layer where the spec is consumed:
```ts
const published = await deps.specSource.getPublishedSpec(org, project);
if (!published || published.visibility !== "public") {
  return toolError(`Unknown public API: ${org}/${project}`);
}
```

---

### [P2] `buildDiscoveryIndex` does not filter fetched specs by `visibility` (cache-staleness leak window)

**Location:** `apps/gateway/src/discovery.ts:78-92`
```ts
for (const item of page.items) {
  const published = await deps.specSource.getPublishedSpec(
    item.orgSlug,
    item.slug,
  );
  let endpoints: DiscoveryEndpoint[] = [];
  if (published) {
    try {
      const parsed = parseSpec(published.spec);
      endpoints = endpointsFromSpec(parsed);
    } catch {
      endpoints = [];
    }
  }
  …apis.push({ … endpoints … });
}
```

**Problem.** The catalogue listing is filtered to `visibility === "public"` at query time, but the spec is fetched from a separate `CachedSpecSource` (30s TTL) layered over `CachedCatalogueSource` (60s TTL). When a project's visibility flips public→private via `setProjectVisibility` (`convex/admin.ts:216`), the catalogue cache and spec cache lag the flip by up to 60s. During that window `listPublic()` can still return the listing and `getPublishedSpec()` still returns the (now-stale `visibility: "public"`) spec. `buildDiscoveryIndex` never re-checks `published.visibility`, so the freshly-private API's endpoint paths + pricing keep flowing through unauthenticated `/discovery` until both caches expire.

**Impact.** Defense-in-depth gap: a narrow but real window where a publisher's revocation of public visibility does not immediately take effect on the public discovery index. Cheap to close.

**Fix.**
```ts
if (published && published.visibility !== "public") continue;
```

---

### [P2] N+1 sequential spec fetches per `/discovery` request

**Location:** `apps/gateway/src/discovery.ts:78-81`
```ts
for (const item of page.items) {
  const published = await deps.specSource.getPublishedSpec(
    item.orgSlug,
    item.slug,
  );
```

**Problem.** Each listing triggers an `await` inside the loop — up to 24 (or, after the pagination fix, N) sequential Convex HTTP round-trips per `/discovery` request, all on the request critical path with no `Promise.all`. workerd CPU/subrequest limits make this scale poorly; latency grows linearly with catalogue size.

**Impact.** Slow discovery responses and, once pagination is fixed, a request that O(N) sequentializes work that is fully parallelizable — risk of hitting the worker CPU wall on a public, unauthenticated, cacheable endpoint that anyone can hammer.

**Fix.** Map to `Promise.all`:
```ts
const apis = await Promise.all(
  page.items.map((item) => buildApi(deps, item)),
);
```

---

### [P2] `handleDiscoveryRequest` builds the full index for `HEAD` then discards it

**Location:** `apps/gateway/src/discovery.ts:105-113`
```ts
const index = await buildDiscoveryIndex(deps);
if (request.method === "HEAD") {
  return new Response(null, {
    status: 200,
    headers: { … },
  });
}
```

**Problem.** `buildDiscoveryIndex(deps)` runs the entire catalogue + N spec fetches *before* the HEAD branch discards the body. HEAD is supposed to be cheap; instead it performs the full work of GET and throws the result away.

**Impact.** Any HEAD probe (monitoring, preflight-style checks) pays the full discovery cost in subrequests and CPU for no payload. Wasteful on a public endpoint.

**Fix.**
```ts
if (request.method === "HEAD") {
  return new Response(null, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=60",
    },
  });
}
const index = await buildDiscoveryIndex(deps);
```

---

### [P3] `endpointsFromSpec` advertises `options`/`head`/`trace` as billable endpoints

**Location:** `apps/gateway/src/discovery.ts:22-33`
```ts
const HTTP_METHODS: readonly HttpMethod[] = [
  "get", "post", "put", "patch", "delete",
  "options", "head", "trace",
];
```

**Problem.** Discovery emits a `DiscoveryEndpoint` (with `credits`) for every method present on a path item, including `options`, `head`, and `trace`. These are not meaningful billable operations for consumers and the metered gateway pipeline is not designed to proxy them as priced calls; advertising them with a `credits` figure misleads agents planning call sequences and inflates the discovery payload.

**Impact.** Misleading discovery output; agents may attempt unpriced/uncallable methods. Not a security issue.

**Fix.** Restrict to the methods the gateway actually meters, or omit `credits` for non-billable methods.

---

### [P3] Malformed spec silently yields `endpoints: []` with no degraded signal

**Location:** `apps/gateway/src/discovery.ts:82-86`
```ts
try {
  const parsed = parseSpec(published.spec);
  endpoints = endpointsFromSpec(parsed);
} catch {
  endpoints = [];
}
```

**Problem.** A parse failure for a published spec is swallowed with no log and no flag; the API still appears in discovery with `endpoints: []` and no pricing. Consumers cannot distinguish "API has no endpoints" from "spec is broken on the gateway side," and operators get no signal that a published spec is unreadable.

**Impact.** Silent degradation of discovery quality; no observability hook for malformed published specs.

**Fix.** `console.warn` the failure (consistent with `ConvexCatalogueSource`/`ConvexSpecSource` error logging) and/or surface a `degraded: true` flag on the `DiscoveryApi`.

---

### [P3] `gatewayBaseUrl` built from unvalidated `orgSlug`/`slug`

**Location:** `apps/gateway/src/discovery.ts:96`
```ts
gatewayBaseUrl: `${origin}/gateway/${item.orgSlug}/${item.slug}`,
```

**Problem.** `orgSlug` and `slug` are interpolated directly into the advertised gateway URL. If either ever contains `/` or `..`, the resulting URL would be malformed or path-traverse past `/gateway/`. Convex validates slugs at project creation, so this is defense-in-depth only — but the gateway URL is the contract consumers and agents call against, so a malformed value here would propagate directly.

**Impact.** Low under current constraints; rises if slug validation ever loosens.

**Fix.** Encode or validate path segments before interpolation.

---

## Summary

- **8 findings:** 0×P0, 2×P1, 3×P2, 3×P3.
- **Top 3:**
  1. `/discovery` paginates at 24 items and never follows `nextCursor` — silently incomplete catalogue index (P1).
  2. `mcp.ts get_api_docs` lets anonymous callers pull full endpoint/pricing data for *any* published project including private ones — `specs:getPublishedForGateway` returns private specs and `get_api_docs` never checks `visibility` (P1, parallel discovery surface).
  3. `buildDiscoveryIndex` doesn't filter fetched specs by `visibility`, leaving a cache-staleness window where freshly-private APIs keep leaking through unauthenticated `/discovery` (P2).
