# Tiger Review — `apps/gateway/src/index.ts` (DEEP)

Scope: `apps/gateway/src/index.ts` read in full (332 lines) + every routing-context
sibling (`pipeline.ts`, `mock.ts`, `discovery.ts`, `mcp.ts`, `cors.ts`, `headers.ts`,
`errors.ts`, `x402.ts`, `key-verifier.ts`, `spec-source.ts`, `catalogue-source.ts`,
`usage.ts`, `wallet.ts`) + the backing Convex queries (`convex/specs.ts`,
`convex/catalogue.ts`) to confirm private-spec leak claims.

## Verdict

`index.ts` is a thin, readable router — but its single structural decision
(per-request `buildDeps`) silently defeats every TTL cache the gateway depends
on, turning the metered hot path into one Convex round-trip per call. Two
additional information-disclosure holes (`/mock` and `/mcp get_api_docs` serving
private project specs to anonymous callers) undercut the access model the
metered pipeline carefully enforces. Ship-blocking issues are present.

## File Stats

- File: `apps/gateway/src/index.ts`
- Lines reviewed: 1–332 (full)
- Routing siblings reviewed: 13
- Backing Convex queries verified: `specs:getPublishedForGateway`, `catalogue:listPublic`
- Prior findings verified: 3/3 (1 P1, 2 P2, 3 P3) — see below
- New findings: 8

## Findings

---

### [SEV: P1] #1 — Per-request `buildDeps` defeats the spec/catalogue TTL caches (VERIFIED + EXPANDED)

**Location:** `index.ts:62-101` (`buildDeps`), called at `index.ts:185, 193, 201, 215`.

```ts
function buildDeps(env: Env): WorkerDeps {
  if (testDeps) return testDeps;            // tests only
  ...
  return {
    keyVerifier,
    specSource: new CachedSpecSource({ inner: innerSpec }),          // fresh Map
    catalogueSource: new CachedCatalogueSource({ inner: innerCatalogue, ttlMs: 60_000 }),
    usageSink,
  };
}
```

```ts
// index.ts:200-211
const route = parseGatewayPath(url.pathname);
if (route) {
  const deps = buildDeps(env);              // <-- per metered request
  return withCors(await handleGatewayRequest(request, env, pipelineOnly(deps), ctx, route));
}
```

**Problem:** `buildDeps(env)` runs on **every** request. Each call constructs a
brand-new `CachedSpecSource` and `CachedCatalogueSource`. Both caches are
instance-level in-memory `Map`s (`spec-source.ts:46-71`, `catalogue-source.ts:60-86`)
— they have **no module scope and no Cache-API backing**. A fresh instance means
`#cache.size === 0` on every call, so `getPublishedSpec()` **always** cache-misses
and falls through to `ConvexSpecSource`, which issues a real `ConvexHttpClient.query`
against `specs:getPublishedForGateway`.

The only module-scoped singleton is `testDeps`, gated on the test harness — there
is **no production memoization** (grep confirms: `buildDeps` is called inline at
four call sites with no `let cachedDeps` / `WeakMap` / env-keyed memo).

**Impact (hot path):** every metered gateway call — the product's revenue path —
pays:
1. One Convex HTTPS query for the published spec (30s TTL cache never hits).
2. A fresh `ConvexHttpClient` is constructed per request (`spec-source.ts:77`),
   so there is no connection/session reuse either — extra subrequest overhead.
3. The `ClerkKeyVerifier` `#memory` LRU (`key-verifier.ts:36`, 512 entries) is
   also recreated per request. Clerk verify still survives via the Cache-API
   layer (`caches.open("zevium-api-key-verify-v1")`, `key-verifier.ts:31`), but
   the memory fast-path — the whole point of the per-isolate LRU — is dead code
   in production. Cache-API misses therefore become Clerk `POST /v1/api_keys/verify`
   calls, billed per request.

At any non-trivial QPS this is a Convex subrequest storm on the metered path,
adding latency and cost to the exact calls that must be cheapest. The 30s/60s
TTLs are decorative.

**Fix:** memoize `WorkerDeps` at module/isolate scope keyed by the env bindings
that identify a deployment, e.g.:

```ts
let prodDeps: WorkerDeps | null = null;
function buildDeps(env: Env): WorkerDeps {
  if (testDeps) return testDeps;
  if (!prodDeps) prodDeps = makeDeps(env);
  return prodDeps;
}
```

(or key by `env.CONVEX_URL` if multi-deploy). `CachedSpecSource` then keeps its
Map across requests in the isolate, and the documented 30s TTL actually engages.

---

### [SEV: P1] #2 — `/mock` leaks private project specs to anonymous callers (NEW)

**Location:** `mock.ts:65-103` (`handleMockRequest`), reached via `index.ts:213-219`.

```ts
// mock.ts:67-71 — no visibility check anywhere
const published = await deps.specSource.getPublishedSpec(route.orgSlug, route.projectSlug);
if (!published) return jsonError(404, "project_not_found", "Unknown project", requestId);
...
const mock = generateMockResponse(parsed, matched.pathTemplate, matched.method);
```

**Problem:** `/mock/:org/:project/*` is intentionally keyless (mock docstring:
"PUBLIC, no API key"). But `getPublishedSpec` calls `specs:getPublishedForGateway`,
whose handler (`convex/specs.ts:261-310`) returns the spec for **any** published
project regardless of `visibility`:

```ts
// convex/specs.ts:285-305 (verified)
if (project.status !== "published") return null;
...
return { spec: latest.spec, ..., visibility: project.visibility, ... };
```

The metered pipeline closes this hole *after* fetching by checking
`published.visibility !== "public"` and returning 404 (`pipeline.ts:113-120`).
`handleMockRequest` performs **no such check**, so an anonymous attacker can
enumerate `org/project` slug pairs and receive:

- `generateMockResponse(...)` output — full response schema (field names, types,
  nested objects, enums) synthesized for every operation in a **private** spec.
- A 404 vs. not-404 oracle confirming which private org/project slugs exist.

**Impact:** full schema disclosure of private/internal APIs to unauthenticated
callers — exactly the disclosure the pipeline's "never leak that a private
project exists" comment (`pipeline.ts:111`) claims to prevent. The /mock
carve-out punches a hole through the access model the metered path enforces.

**Fix:** in `handleMockRequest`, after fetching `published`, gate on visibility:

```ts
if (published.visibility !== "public") {
  return jsonError(404, "project_not_found", "Unknown project", requestId);
}
```

Return 404 (not 403) to match the pipeline's "never leak existence" stance.

---

### [SEV: P1] #3 — `/mcp` `get_api_docs` leaks private project endpoint lists + pricing (NEW)

**Location:** `mcp.ts:167-213` (`handleGetApiDocs`), reached via `index.ts:192-196`.

```ts
// mcp.ts:174-176 — no visibility check
const published = await deps.specSource.getPublishedSpec(org, project);
if (!published) return toolError(`Unknown public API: ${org}/${project}`);
...
const parsed = parseSpec(published.spec);
endpoints = endpointsFromSpec(parsed);   // method, path, credits, summary, freeTier
```

**Problem:** Same root cause as #2. `handleGetApiDocs` fetches via
`getPublishedSpec` (which returns private specs) and returns the full endpoint
list with per-operation pricing for **any** published project. The MCP endpoint
is unauthenticated for `tools/list`, `search_apis`, and `get_api_docs`
(`mcp.ts:437-460`), so an anonymous JSON-RPC caller can extract private API
structure and pricing.

`/discovery` is **not** affected: it iterates `catalogueSource.listPublic()`,
whose Convex query `catalogue:listPublic` filters
`visibility: "public"` (`convex/catalogue.ts:126-130`, verified). Only the
slug-direct lookups (`/mock`, `/mcp get_api_docs`) leak.

**Impact:** private endpoint enumeration + pricing disclosure to anonymous
callers. Slightly less severe than #2 (no response-body schema), but same
access-model bypass.

**Fix:** mirror the pipeline's visibility gate in `handleGetApiDocs`:

```ts
if (published.visibility !== "public") {
  return toolError(`Unknown public API: ${org}/${project}`);
}
```

---

### [SEV: P2] #4 — Unhandled DO RPC throws in `/internal/grant` and `/internal/sync` (VERIFIED)

**Location:** `index.ts:223-260` (`handleInternalGrant`), `index.ts:262-300`
(`handleInternalSync`).

```ts
// index.ts:246-248 — no try/catch
const id = env.WALLET.idFromName(clerkOrgId);
const stub = env.WALLET.get(id);
const result = await stub.grant(refId, amount);
return Response.json(result);

// index.ts:298-300 — no try/catch
const id = env.WALLET.idFromName(clerkOrgId);
return Response.json(await env.WALLET.get(id).syncGrants(clerkOrgId));
```

**Problem:** both handlers `await` a Durable Object RPC with no `try/catch`.
`WalletDO.grant` (`wallet.ts:403-425`) and `syncGrants` (`wallet.ts:887-931`)
both go through `#mutate` → `#persist` → `ctx.storage.transaction`
(`wallet.ts:337-349, 351-388`), any of which can throw on storage failure,
DO restart, transient DO unavailability, or `syncGrants`' own
`#fetchGrantsFromConvex` path. An uncaught throw propagates out of the Worker
`fetch` handler, surfacing as a Cloudflare 1101 "Unhandled exception" with no
JSON body — the control-plane caller (Convex httpAction) gets an opaque 5xx
with no error code, no request id, and no recovery semantics.

**Impact:** control-plane grant/sync operations have no graceful failure path;
transient DO hiccups surface as opaque Worker crashes instead of structured
`{error: "wallet_unavailable"}` 5xx envelopes the caller can retry against.

**Fix:** wrap the RPC in `try/catch`, return a structured 502/503:

```ts
try {
  const result = await stub.grant(refId, amount);
  return Response.json(result);
} catch (err) {
  console.error("internal grant RPC failed", err);
  return Response.json(
    { error: "wallet_unavailable" },
    { status: 502 },
  );
}
```

Same for `syncGrants`.

---

### [SEV: P2] #5 — Upstream fetch error `message` forwarded verbatim to consumers (info leak) (NEW)

**Location:** `pipeline.ts:160-184` (reached via the `index.ts:201` metered branch).

```ts
} catch (err) {
  ...
  const message = err instanceof Error ? err.message : "upstream error";
  ...
  return jsonError(502, "upstream_error", message, requestId);
}
```

**Problem:** `jsonError` places `message` directly in the response body
(`errors.ts:8-19`). `fetchImpl` rejection messages in workerd commonly embed
internal topology — e.g. `fetch failed: ECONNREFUSED 10.x.x.x:443`,
`DNS lookup failed for upstream.internal: getaddrinfo ENOTFOUND`, or upstream
hostnames from the spec's `servers[0].url`. The pipeline forwards that string
verbatim to the consumer. `errors.ts`'s own header comment promises "Never
leaks internals — `message` is always a short, human-safe string," but the
upstream-error path violates that contract by passing through an uncontrolled
`err.message`.

**Impact:** consumers (or attackers probing error paths) can read internal
upstream hostnames, IPs, and connection diagnostics from a metered 502.

**Fix:** return a fixed `message` ("Upstream request failed"); log `err.message`
server-side only. If the team wants a diagnostic breadcrumb, route it through
`x-zevium-request-id` correlation in logs, never the body.

---

### [SEV: P2] #6 — `GATEWAY_TEST_MODE` env var documented but never read (contract mismatch) (NEW)

**Location:** `index.ts:34-43` (Env interface + docstring), `index.ts:62-66` (`buildDeps`).

```ts
// index.ts:34-43
/**
 * Test-only: when set, Worker uses fixture key/spec sources populated via
 * internal test helpers (see test/pipeline.test.ts). Not for production.
 */
GATEWAY_TEST_MODE?: string;

// index.ts:62-66
function buildDeps(env: Env): WorkerDeps {
  if (testDeps) {   // <-- only the module singleton; GATEWAY_TEST_MODE never read
    return testDeps;
  }
  ...
}
```

**Problem:** the `Env.GATEWAY_TEST_MODE` docstring claims "when set, Worker uses
fixture key/spec sources." `buildDeps` never reads `env.GATEWAY_TEST_MODE` — it
only checks the module-scoped `testDeps` singleton installed by
`__setTestPipelineDeps` (grep confirms `GATEWAY_TEST_MODE` appears only in the
type declaration and one comment, never in a runtime branch). The documented
behavior is non-functional.

**Impact:** a developer who sets `GATEWAY_TEST_MODE=1` in a dev/preview worker
expecting fixture sources instead gets real `ClerkKeyVerifier`/`ConvexSpecSource`
(or, if `CLERK_SECRET_KEY` is also missing, the silent `FixtureKeyVerifier`
fallback of #7 — which would *accidentally* match the expectation but for the
wrong reason and with the wrong failure mode). The env var is misleading dead
config.

**Fix:** either read `env.GATEWAY_TEST_MODE` in `buildDeps` and wire it to
fixture sources as documented, or delete the field from `Env` and update the
docstring to say test injection is only via `__setTestPipelineDeps`.

---

### [SEV: P3] #7 — Silent `FixtureKeyVerifier` fallback when `CLERK_SECRET_KEY` missing (VERIFIED)

**Location:** `index.ts:68-70`.

```ts
const keyVerifier = env.CLERK_SECRET_KEY
  ? new ClerkKeyVerifier({ secretKey: env.CLERK_SECRET_KEY })
  : new FixtureKeyVerifier();
```

**Problem:** when `CLERK_SECRET_KEY` is unset, the Worker silently swaps in
`FixtureKeyVerifier` — a test stub with an empty key map (`key-verifier.ts:209-219`)
whose `verify()` returns `null` for every key. There is no `console.error`, no
throw, no health-flag. The gateway boots and serves 402 `invalid_api_key` for
100% of metered calls, which looks like "all my keys are broken" rather than
"the Worker is misconfigured." The `FixtureKeyVerifier` import and class are
test-only constructs; using them as a production fallback is a footgun.

Fail-closed (no key validates) is the safe direction, but silent fail-closed
with no signal makes misconfig debugging brutal. The pipeline's hard work on
`invalid_api_key` envelopes is wasted when the *entire gateway* is dark.

**Impact:** misconfiguration (missing secret in a deployment/preview) manifests
as a universally-broken gateway with no log line pointing at the cause.

**Fix:** when `CLERK_SECRET_KEY` is absent in non-test mode, either fail fast at
boot (throw from `buildDeps`) or at minimum `console.error` a loud
`"CLERK_SECRET_KEY missing — gateway rejecting all keys"` and expose it on
`/health` (`{ok:false, misconfigured:["CLERK_SECRET_KEY"]}`).

---

### [SEV: P3] #8 — `timingSafeEqual` length-leaks the shared secret length (NEW)

**Location:** `index.ts:128-136`, used at `index.ts:235-238` and `index.ts:274-277`.

```ts
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;   // <-- early return leaks len(secret)
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}
```

**Problem:** the length check returns immediately on mismatch, leaking the
secret's character length to a timing attacker. The comparison is also on
UTF-16 code units (`charCodeAt`), not bytes, so non-ASCII secrets compare
incorrectly. For a shared secret gating `/internal/grant` and `/internal/sync`
(control-plane credit grants!), the standard practice is hash-then-compare or a
fixed-length constant-time byte compare.

**Impact:** low in practice (the secret is a server-side env value and these
routes are not directly internet-exposed in most deploys), but it's the wrong
primitive for a secret compare and a static-analysis red flag.

**Fix:** compare the SHA-256 digests of both inputs (fixed 32-byte length):

```ts
const aHash = await sha256Hex(a);
const bHash = await sha256Hex(b);
// then constant-time compare the hex strings (equal length by construction)
```

(`sha256Hex` already exists in `key-verifier.ts:151-161` — reuse it.) Or use
`crypto.subtle.timingSafeEqual` where available.

---

### [SEV: P3] #9 — Dead code: `void ConvexUsageSink;` (NEW)

**Location:** `index.ts:96`.

```ts
const usageSink = env.CONVEX_URL
  ? new ConsoleUsageSink()
  : new NoopUsageSink();

// Keep ConvexUsageSink constructable for tests / future dual-write.
void ConvexUsageSink;
```

**Problem:** `ConvexUsageSink` is imported (`index.ts:13`) solely to be
`void`-referenced. It is never instantiated here. The pipeline's hot-path emit
goes to `ConsoleUsageSink` (just `console.log`, `usage.ts:52-60`) — the
authoritative Convex write is the DO alarm flush loop (`usage.ts:305-351`),
which constructs its own `ConvexUsageClient` independently. The import + `void`
statement is noise that implies dual-write exists when it doesn't.

**Impact:** misleads readers into thinking the gateway dual-writes usage to
Convex; import bloat.

**Fix:** delete the import of `ConvexUsageSink` and the `void` statement.

---

### [SEV: P3] #10 — `/internal/grant` & `/internal/sync` return HTTP 200 for rejected / rate-limited / sync-failed outcomes (NEW)

**Location:** `index.ts:248` (`return Response.json(result)`), `index.ts:300`
(`return Response.json(await ...syncGrants(...))`).

**Problem:** the DO RPCs return structured statuses that the handlers pass
through under a default 200:
- `grant()` can return `{status:"rejected", reason:"grantId required"}` etc.
  (`wallet.ts:404-409`).
- `syncGrants()` returns `{status:"rate_limited", retryAfterSeconds}` or
  `{status:"sync_failed", error, balance, sequence}` (`wallet.ts:893-919`).

All of these surface as `200 OK` to the control-plane caller. A rate-limited
sync returns 200 with no `Retry-After` header; a failed sync returns 200 with
an error body — indistinguishable from success at the HTTP layer. Convex
httpAction callers / control-plane retry logic that keys off HTTP status will
treat failures as success.

**Impact:** control-plane can't distinguish ok / rate-limited / failed without
parsing the JSON body; no `Retry-After` propagation on the rate-limit path.

**Fix:** map statuses → HTTP: `rejected`→400/409, `rate_limited`→429 +
`Retry-After: <seconds>`, `sync_failed`→502; `applied`/`duplicate`/`ok`→200.

---

### [SEV: P3] #11 — No body-size limit on `/internal/*` JSON parse (NEW)

**Location:** `index.ts:240-243`, `index.ts:288-291`.

```ts
let body: unknown;
try {
  body = await request.json();   // <-- buffers entire body, no cap
} catch {
  return Response.json({ error: "invalid_json" }, { status: 400 });
}
```

**Problem:** `request.json()` buffers the whole request body with no size cap.
A caller holding the `GATEWAY_INTERNAL_SECRET` (or an attacker who has leaked
it) could POST a multi-MB/gigabyte JSON body to exhaust Worker memory / hit
subrequest limits. These routes are behind a shared secret so the threat model
is narrower, but there is zero defense in depth.

**Impact:** memory exhaustion vector on internal routes; no `Content-Length`
guard.

**Fix:** check `request.headers.get("content-length")` and reject >32 KiB before
parsing; or stream-parse with a bounded reader.

---

### [SEV: P3] #12 — Unbounded `appliedGrantIds` growth in the wallet DO (NEW, surfaced via `/internal/grant`)

**Location:** `wallet.ts:411-422` (grant idempotency set), driven by
`index.ts:246-248` (`stub.grant(refId, amount)`).

```ts
// wallet.ts:412-422
if (this.#appliedGrantIds.has(grantId)) return { status: "duplicate", balance: ... };
this.#appliedGrantIds.add(grantId);
...
await this.#persist({ ..., appliedGrantIds: [...this.#appliedGrantIds] });
```

**Problem:** every distinct `refId` is retained forever in the DO's persisted
`appliedGrantIds` set (for idempotency). The `/internal/grant` caller supplies
`refId` with no length/format cap and no TTL/eviction on the dedup set. Over
months, a high-volume control plane grows this set unboundedly in DO storage,
slowing `#load` and every persist.

**Impact:** slow storage bloat on the wallet DO; eventual request latency
regression as the set is serialized on every grant/sync.

**Fix:** TTL or cap the set (e.g. keep last N by recency, or evict entries older
than the idempotency window — 24h–7d); validate `refId` length/format at the
`/internal/grant` boundary.

---

### [SEV: P3] #13 — MCP `call_api` drops query-string parameters (NEW)

**Location:** `mcp.ts:349-373` (`handleCallApi`).

**Problem:** `call_api` builds a synthetic `new Request(url, init)` with no
query string — the tool schema exposes `org`, `project`, `method`, `path`,
`body`, `headers`, `key`, but no `query`/`params`. The pipeline then does
`upstreamUrl.search = incoming.search` (`pipeline.ts:189-192`), which is empty
because the synthetic URL has no query. Agents calling GET APIs that take query
params (the majority of catalogue APIs) cannot pass them through MCP.

**Impact:** MCP `call_api` cannot exercise any query-parameterized endpoint — a
functional gap on the agent surface, not just a nit.

**Fix:** add a `query: Record<string,string>` arg to the `call_api` tool schema
and append it to the synthetic URL before calling `handleGatewayRequest`.

---

## Summary

- **P0:** 0
- **P1:** 3 (#1 per-request buildDeps defeats caches; #2 /mock leaks private specs; #3 /mcp get_api_docs leaks private specs)
- **P2:** 3 (#4 unhandled DO RPC throws; #5 upstream error message leak; #6 dead `GATEWAY_TEST_MODE`)
- **P3:** 7 (#7 silent FixtureKeyVerifier fallback; #8 timingSafeEqual length leak; #9 dead `void ConvexUsageSink`; #10 200-for-failure on internal routes; #11 no body-size cap; #12 unbounded grant idempotency set; #13 MCP call_api drops query string)
- **Total:** 13 findings

**Top 3 to fix first:**

1. **#2 + #3 — private spec disclosure via `/mock` and `/mcp get_api_docs`.** Two-line
   visibility gates close an access-model hole that the metered pipeline already
   enforces but these keyless/slug-direct paths skip. Cheapest high-impact fix in
   the file.
2. **#1 — memoize `buildDeps` at isolate scope.** The per-request construction
   negates the entire caching layer on the revenue path; one `let prodDeps`
   memo restores the documented 30s/60s TTLs and removes the per-request
   `ConvexHttpClient` allocation.
3. **#5 — stop forwarding upstream `err.message` to consumers.** Single-line
   fix (`message = "Upstream request failed"`) closes an internal-topology leak
   through the 502 envelope and restores the `errors.ts` "never leaks internals"
   contract.

**Cross-cutting note:** the file's core anti-pattern is *constructing stateful
caches per request*. #1 is the cache instance; #6's `GATEWAY_TEST_MODE` bypass
and #7's silent fixture fallback are both symptoms of `buildDeps` being the one
chokepoint that every route re-enters without memoization or fail-loud
validation. Fix #1 with a module-scoped memo and the rest of the
misconfiguration surface tightens alongside it.
