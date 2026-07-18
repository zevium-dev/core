# Tiger Review — `apps/gateway/src/index.ts`

Gateway Worker entry point: routes `/gateway`, `/mock`, `/discovery`, `/mcp`,
`/internal/grant`, `/internal/sync`, `/health`. Constructs per-request deps
(`buildDeps`) and dispatches to handler modules.

## Verdict

**Incorrect** — one material hot-path budget violation (per-request dep
construction defeats the spec TTL cache, adding a Convex query to every
metered gateway call) plus several smaller robustness/timing nits. No
missing auth, no missing credit gate, no mock→metered leak, no whole-body
buffering on the proxy path.

## File Stats

- File: `apps/gateway/src/index.ts`
- Lines reviewed: 332 (full file) + all sibling `apps/gateway/src/*.ts` for routing context (`pipeline.ts`, `spec-source.ts`, `key-verifier.ts`, `mock.ts`, `cors.ts`, `discovery.ts`, `mcp.ts`, `wallet.ts`, `usage.ts`).
- Findings: 6 (P0: 0, P1: 1, P2: 2, P3: 3)

## Findings

### [P1] `buildDeps` per-request construction defeats the spec/catalogue TTL caches — every gateway call hits Convex

**Location:** `apps/gateway/src/index.ts:62-95` (called from `fetch` at lines 161, 167, 187, 196, 205).

```ts
function buildDeps(env: Env): WorkerDeps {
  if (testDeps) {
    return testDeps;
  }
  const keyVerifier = env.CLERK_SECRET_KEY
    ? new ClerkKeyVerifier({ secretKey: env.CLERK_SECRET_KEY })
    : new FixtureKeyVerifier();
  const innerSpec = env.CONVEX_URL
    ? new ConvexSpecSource({ convexUrl: env.CONVEX_URL })
    : new FixtureSpecSource();
  const innerCatalogue = env.CONVEX_URL
    ? new ConvexCatalogueSource({ convexUrl: env.CONVEX_URL })
    : new FixtureCatalogueSource();
  ...
  return {
    keyVerifier,
    specSource: new CachedSpecSource({ inner: innerSpec }),
    catalogueSource: new CachedCatalogueSource({ inner: innerCatalogue, ttlMs: 60_000 }),
    usageSink,
  };
}
```

**Problem:** `fetch` calls `buildDeps(env)` on every request. `CachedSpecSource`
(`spec-source.ts`) and `CachedCatalogueSource` hold their TTL cache in a plain
instance-scoped `Map` (`#cache = new Map<string, CacheEntry>()`), **not** the
Cloudflare Cache API. A fresh instance per request means the `Map` is empty
every time → `getPublishedSpec` always misses → always calls
`ConvexHttpClient.query("specs:getPublishedForGateway")`. The 30s TTL never
amortizes anything. Same for the 60s catalogue cache. Each request also
constructs a new `ConvexHttpClient` (which manages its own connection), causing
connection churn on top of the per-request query.

The `ClerkKeyVerifier` (`key-verifier.ts`) is partially saved by the Cache API
(`caches` global is shared across requests in an isolate), so Clerk verify
results do survive across requests — but the 512-entry in-memory LRU
(`#memory`) is per-instance, so the fast memory-hit layer is also wasted and
every request pays `caches.open(...).match()` overhead.

**Impact:** Every metered `/gateway/:org/:proj/*` call makes a synchronous
Convex query for the published spec before reserve/proxy — adding control-plane
latency to the hot path and multiplying Convex load by the request rate. The
spec cache (the explicit purpose of `CachedSpecSource`) is a no-op in
production. This is the "network calls to Convex per request" hot-path budget
violation the review brief asks for.

**Fix:** Memoize `WorkerDeps` at module scope keyed by env identity (env is
stable for the isolate lifetime), e.g.:

```ts
let cachedDeps: { env: Env; deps: WorkerDeps } | null = null;
function buildDeps(env: Env): WorkerDeps {
  if (testDeps) return testDeps;
  if (cachedDeps && cachedDeps.env === env) return cachedDeps.deps;
  // ...existing construction...
  cachedDeps = { env, deps: result };
  return result;
}
```

(Equivalently, hoist the verifier + cached sources to module singletons built
once on first use.)

---

### [P2] Unhandled DO RPC throws in `/internal/grant` and `/internal/sync`

**Location:** `apps/gateway/src/index.ts:225-282` (`handleInternalGrant`, `stub.grant` at 281) and `index.ts:285-331` (`handleInternalSync`, `syncGrants` at 330).

```ts
const result = await stub.grant(refId, amount);
return Response.json(result);
```
```ts
return Response.json(await env.WALLET.get(id).syncGrants(clerkOrgId));
```

**Problem:** Neither handler wraps the DO RPC call in a try/catch, and the
outer `fetch` has no top-level try/catch either. `WalletDO.syncGrants` fetches
from Convex (`/wallet-grants`) and can throw on transient network/storage
errors; `stub.grant` can throw on DO storage failure. When it throws, the
exception propagates out of `fetch` uncaught.

**Impact:** A transient Convex/DO failure on `/internal/sync` (called by the
control plane to checkpoint grants) surfaces as a worker-level 1101 "Unhandled
exception" rather than a structured 5xx the caller can retry against cleanly.
The internal caller (Convex function or admin script) gets an opaque error
instead of `{ status: "sync_failed", error, ... }` that the `SyncGrantsResult`
type was designed to return. `handleInternalGrant` has the same shape.

**Fix:**
```ts
try {
  const result = await stub.grant(refId, amount);
  return Response.json(result);
} catch (err) {
  const message = err instanceof Error ? err.message : "grant failed";
  return Response.json({ error: "internal_error", message }, { status: 500 });
}
```
(and analogously for `syncGrants`, returning the `sync_failed` shape.)

---

### [P2] `FixtureKeyVerifier` silent fallback when `CLERK_SECRET_KEY` unset in production

**Location:** `apps/gateway/src/index.ts:68-70`.

```ts
const keyVerifier = env.CLERK_SECRET_KEY
  ? new ClerkKeyVerifier({ secretKey: env.CLERK_SECRET_KEY })
  : new FixtureKeyVerifier();
```

**Problem:** `buildDeps` keys off `env.CONVEX_URL` to decide production vs.
fixture for spec/catalogue/usage, but keys off `env.CLERK_SECRET_KEY` for the
verifier. If a production deploy has `CONVEX_URL` set but `CLERK_SECRET_KEY`
missing (misconfiguration — e.g. secret rotated and not re-bound), the gateway
silently swaps to `FixtureKeyVerifier`, whose key map is empty and rejects every
key with 402 `invalid_api_key`. There is no startup check or log; consumers see
generic payment-required errors and publishers see no traffic.

**Impact:** A single missing/empty secret produces a fully-running-looking but
non-functional gateway that 402s every call. No error surfaces to operators
until they notice traffic is zero.

**Fix:** When `env.CONVEX_URL` is set (production mode), require
`CLERK_SECRET_KEY` and fail loudly — either throw from `buildDeps` on first
request, or (better) validate at the `fetch` boundary and return a 500
`misconfigured` response naming the missing var, mirroring the existing
`GATEWAY_INTERNAL_SECRET` pattern in `handleInternalGrant`.

---

### [P3] `timingSafeEqual` early-returns on length mismatch, leaking secret length

**Location:** `apps/gateway/src/index.ts:136-143`.

```ts
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}
```

**Problem:** The length-difference early return means the function's runtime is
proportional to `a.length` only when lengths match, and near-zero otherwise.
An attacker probing `x-gateway-secret` / `Authorization` against
`/internal/grant` and `/internal/sync` can distinguish "wrong length" from
"right length, wrong content" via response timing.

**Impact:** Low. The compared secret (`GATEWAY_INTERNAL_SECRET`) is a
high-entropy shared secret, so length leakage alone is not exploitable to
recover it, and the only callers are server-to-server internal endpoints.
Flagged because the function's name promises constant-time equality and the
common-case implementation does not deliver it.

**Fix:** Pad both inputs to a fixed maximum length before comparing, or use a
HMAC-based comparison (`const mac = await crypto.subtle.importKey(...)` +
`sign` + `timingSafeEqual` on equal-length digests). Minimal acceptable fix is
to document the length-leak in a comment if the current behavior is intended.

---

### [P3] `void ConvexUsageSink;` is dead code

**Location:** `apps/gateway/src/index.ts:86`.

```ts
// Keep ConvexUsageSink constructable for tests / future dual-write.
void ConvexUsageSink;
```

**Problem:** `ConvexUsageSink` is imported from `./usage` and never
instantiated in the worker. The `void` expression exists solely to suppress
the unused-import lint. The "future dual-write" referenced in the comment is
not wired up anywhere; per the architecture the DO alarm is the authoritative
flush path and `ConsoleUsageSink` is the deliberate hot-path sink.

**Impact:** None functionally. It is noise that suggests a code path exists
when it does not, and the import keeps `ConvexUsageSink`'s constructor (and its
transitive imports) in the worker bundle for no runtime benefit.

**Fix:** Drop the import and the `void` expression. Re-add when dual-write is
actually implemented.

---

### [P3] OPTIONS preflight returns CORS 204 for internal endpoints too

**Location:** `apps/gateway/src/index.ts:166-168`.

```ts
if (request.method === "OPTIONS") {
  return corsPreflight();
}
```

**Problem:** The OPTIONS short-circuit runs before any route dispatch, so
`OPTIONS /internal/grant`, `OPTIONS /internal/sync`, `OPTIONS /health` all
return `204` with `access-control-allow-origin: *` and the full
`access-control-allow-methods` list, advertising CORS on internal/control-plane
endpoints that have no business being called from browsers.

**Impact:** Negligible — these endpoints use a shared-secret header, not
cookies, so the wildcard origin does not widen the attack surface. Purely a
hygiene/expectation issue: the `cors.ts` module comment scopes the public CORS
surface to `/gateway`, `/mock`, `/discovery`, `/mcp`, but the implementation
applies it to every path.

**Fix:** Either accept the current behavior as harmless and update the `cors.ts`
comment, or gate the preflight to known public routes (`/gateway`, `/mock`,
`/discovery`, `/mcp`, `/health`) and return 404 for OPTIONS on `/internal/*`.

---

## Summary

- 6 findings: **0 P0 / 1 P1 / 2 P2 / 3 P3**
- Top 3:
  1. **[P1]** `buildDeps` per request defeats `CachedSpecSource`/`CachedCatalogueSource` instance-`Map` TTL caches → a Convex `specs:getPublishedForGateway` query on every metered gateway call. Memoize deps at module scope (or hoist the cached sources to singletons).
  2. **[P2]** `handleInternalGrant` / `handleInternalSync` let DO RPC throws escape uncaught → opaque 1101s instead of structured 5xx / `sync_failed` results the control plane can retry.
  3. **[P2]** Missing `CLERK_SECRET_KEY` in prod silently swaps to `FixtureKeyVerifier` (empty key map) → 402 on every call with no operator-visible error.

Positive note (not a finding): no mock-carve-out leak into the metered path
(`/mock` is checked after `/gateway` and never touches the wallet), no
whole-body buffering on the proxy (`new Response(upstreamRes.body, …)` streams),
key auth + credit gate present on all protected routes, x402 shape consistent
on auth/insufficient-credit blocks.
