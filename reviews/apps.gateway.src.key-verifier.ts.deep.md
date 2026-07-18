# Tiger Review — `apps/gateway/src/key-verifier.ts` (DEEP)

Scope: `apps/gateway/src/key-verifier.ts` (297 ln) + `apps/gateway/test/key-verifier.test.ts`
+ `convex/keySettings.ts` + consumers (`apps/gateway/src/index.ts`, `pipeline.ts`,
`wallet.ts`, `mock.ts`) + `apps/web/src/lib/api-keys.ts` (Clerk key-shape ground truth)
+ `TECH.md` §2 (Clerk verify spike decision).

## Verdict

**NEEDS WORK.** The cache-first design is sound in principle but the production wiring
silently disables the fast path, failure handling conflates "invalid key" with
"Clerk is down," and the defensive expiry check targets the wrong field name. Two
availability-affecting P1s and four correctness/design P2s confirmed and expanded
from the prior pass; seven nits. No P0 (no revocation bypass beyond the documented
60s TTL safety net — Cache API honors `max-age`, the wallet-DO `keySettings` layer
enforces disable, and Clerk revokes via 401).

## File Stats

| Metric | Value |
|---|---|
| Lines reviewed | 297 (source) + 116 (test) + 182 (keySettings) |
| Consumers traced | `index.ts` `buildDeps`, `pipeline.ts` `handleGatewayRequest`, `mock.ts` |
| Clerk ground truth | `TECH.md:138`, `apps/web/src/lib/api-keys.ts:79-146` |
| Findings | 13 (P1×2, P2×4, P3×7) |

## Findings

---

### [SEV: P1] Per-request `ClerkKeyVerifier` instantiation defeats the per-isolate memory cache — fast path dead in prod

**Where** — `apps/gateway/src/index.ts:68-70` (instantiation) + `index.ts:155,164,181,196`
(call sites) + `key-verifier.ts:75-104` (`verify`) + `key-verifier.ts:1-2` (docstring).

```ts
// index.ts — buildDeps is invoked INSIDE the per-request fetch handler, 4×:
const keyVerifier = env.CLERK_SECRET_KEY
  ? new ClerkKeyVerifier({ secretKey: env.CLERK_SECRET_KEY })
  : new FixtureKeyVerifier();
...
// fetch():
const deps = buildDeps(env);          // /discovery
const deps = buildDeps(env);          // /mcp
const deps = buildDeps(env);          // /gateway/*
const deps = buildDeps(env);          // /mock/*
```

```ts
// key-verifier.ts — the memory layer this instance owns:
readonly #memory = new Map<string, MemoryEntry>();   // fresh every request
...
const mem = this.#memory.get(cacheKey);              // always empty on first call
if (mem && mem.expiresAt > now) return mem.value;     // never true in prod
```

**Problem.** `buildDeps(env)` runs on every routed request, constructing a brand-new
`ClerkKeyVerifier` with a fresh `#memory` Map. The memory layer is the *only* sync,
zero-async-alloc fast path; it is **always empty on first access** for every request,
so the `mem.expiresAt > now` branch is unreachable in production. Every hot-path call
falls through to `await this.#caches!.open()` + `await cache.match()` (two async hops
through the shared Cache API) — exactly the allocation the file's own docstring
("per-isolate memory", "Hot path never waits on Clerk when cache hits") claims to
avoid. The module-level `testDeps` memo only applies under `GATEWAY_TEST_MODE`.

`CLERK_SECRET_KEY` is constant across requests in a deploy, so there is no
env-var reason to reconstruct per request.

**Impact.** (1) The documented fast path is dead in prod — every authenticated
gateway request pays two Cache-API async round-trips on the auth hot path.
(2) The per-instance `#memory` Map is allocated, written once, and immediately GC'd
— pure waste. (3) All hot-path traffic is shifted onto the shared Cache API, which
has its own throughput limits and amplifies the stampede (see P2 below).

**Fix.** Hoist the verifier to module scope (or a per-isolate lazy singleton keyed on
`env.CLERK_SECRET_KEY`). `KeyVerifier` holds no per-request state; only `#now` /
`#fetch` / `#caches` are injected for tests — those are also isolate-stable. E.g. a
`weakMap`/module-level `let prodVerifier: ClerkKeyVerifier | null` built once on first
`fetch`. Test paths already use `__setTestPipelineDeps`, so prod memoization is safe.

---

### [SEV: P1] 60s negative caching of transport / 429 / 5xx failures — minute-long auth outages from sub-second blips

**Where** — `key-verifier.ts:163-195` (`#verifyRemote`) + `key-verifier.ts:95-103`
(cache write).

```ts
async #verifyRemote(secret: string): Promise<VerifiedKey | null> {
  let res: Response;
  try {
    res = await this.#fetch(this.#verifyUrl, { ... body: JSON.stringify({ secret }) });
  } catch {
    return null;                 // ← transport failure → null
  }
  if (!res.ok) return null;       // ← 429 / 5xx / 401 / 403 all → null
  ...
}

// verify():
const verified = await this.#verifyRemote(secret);
this.#writeMemory(cacheKey, verified, now);            // null cached 60s in memory
if (this.#useCacheApi && this.#caches) {
  void this.#writeCacheApi(cacheKey, verified);          // null cached 60s in Cache API
}
```

**Problem.** `#verifyRemote` collapses **every** failure mode — network/DNS throw, 429
rate-limit, 500/502/503, 401 (truly invalid), 403, JSON parse error — into a single
`null` return, and `verify()` caches that `null` for the full `CACHE_TTL_SECONDS` (60s)
in **both** the memory layer and the Cache API. There is no distinction between
"this key is invalid" (cacheable) and "Clerk is unreachable" (must NOT be cached, or
cached for a very short window).

**Impact.** A sub-second Clerk blip (a 502 from `api.clerk.com`, a transient 429 burst,
a DNS hiccup) poisons the cache for every key seen during the window: those keys return
`null` (→ 402 `invalid_api_key` at the pipeline) for a full 60 seconds. For a gateway
verifying many distinct keys/second this is a **complete auth outage** for up to 60s
from a momentary upstream blip, with no circuit breaker, no retry, and no shorter
negative TTL. `TECH.md:138` records Clerk's limit at 1000 req/10s per instance — a
stampede (see P2) can self-inflict the 429 that this code then negative-caches into a
minute-long outage.

**Fix.** Differentiate failure modes: (a) on transport throw or `5xx`/`429`/`503`/`504`,
do **not** cache (or cache with a short 3–5s TTL and a `degraded` marker so the next
request retries); (b) on `401`/`403` or a `revoked:true`/`expired` body, cache `null`
for the full TTL (these are stable negative answers); (c) optionally fall back to a
stale-while-revalidate positive entry if a recent one exists. At minimum: skip the
Cache-API write and use a 1–2s memory-only negative TTL for transport/5xx.

---

### [SEV: P2] Cache stampede on miss — no singleflight / in-flight dedup

**Where** — `key-verifier.ts:84-103` (`verify`).

```ts
const mem = this.#memory.get(cacheKey);
if (mem && mem.expiresAt > now) return mem.value;        // miss → fall through
if (this.#useCacheApi && this.#caches) {
  const cached = await this.#readCacheApi(cacheKey);     // async miss window
  if (cached !== undefined) { ... }
}
const verified = await this.#verifyRemote(secret);       // N concurrent callers → N Clerk calls
```

**Problem.** There is no in-flight promise de-duplication. When the memory entry has
expired and the Cache API misses (cold key, or all entries aged out together — see the
no-jitter nit), every concurrent request for the same secret independently calls
`#verifyRemote`. `wallet.ts` uses a `#syncInFlight` singleflight pattern for exactly
this reason; `ClerkKeyVerifier` does not.

**Impact.** On a cold or just-expired hot key, a burst of N concurrent requests fires
N parallel `POST /v1/api_keys/verify` calls to Clerk. `TECH.md:138`: Clerk caps at
1000 req/10s per instance — a stampede on a popular key can blow that quota, and the
resulting 429 is then negative-cached for 60s (P1 above). The two bugs compound:
stampede → 429 → minute-long outage.

**Fix.** Track an in-flight promise per `cacheKey` (`#inFlight: Map<string,
Promise<VerifiedKey | null>>`); on miss, store the `#verifyRemote` promise and have
concurrent callers `await` the same one. Clear it in a `finally`.

---

### [SEV: P2] No fetch timeout / AbortSignal on the Clerk call — hung upstream blocks the worker

**Where** — `key-verifier.ts:165-173`.

```ts
res = await this.#fetch(this.#verifyUrl, {
  method: "POST",
  headers: { authorization: `Bearer ${this.#secretKey}`, ... },
  body: JSON.stringify({ secret }),
});                       // no signal, no AbortController
```

**Problem.** No `AbortSignal` / timeout. A slow or hung `api.clerk.com` response
blocks the worker request up to the runtime CPU/wall limit (default subrequest budget).
There is no retry, no circuit breaker, no fallback. Combined with P1 (the result of a
hung-then-timed-out call is `null` and gets cached 60s), a single slow Clerk response
can both hang the in-flight request and poison the cache.

**Impact.** Auth hot path can be held hostage by a single slow upstream subrequest; no
bounded latency guarantee for verification.

**Fix.** `AbortSignal.timeout(2_000)` (workerd supports `AbortSignal.timeout`) on the
fetch; treat the abort as a transport failure (non-cached, per P1 fix). Optionally one
retry with a fresh signal on transport failure only.

---

### [SEV: P2] `expired` field check is dead; `expire_at` never read; expiration not honored post-cache

**Where** — `key-verifier.ts:213-214` (check) + `key-verifier.ts:204-207` (spike comment)
+ `key-verifier.ts:31-33` (`VerifiedKey` carries no expiration) + `parseCachedVerified`
(`key-verifier.ts:197-203`).

```ts
/**
 * Clerk verify response (subset). Fields observed in spike:
 * subject (org_/user_), claims.org_id (user-subject keys), id / api_key_id, scopes, revoked, expiration.
 * ...
 */
export function parseClerkVerifyResponse(json: unknown): VerifiedKey | null {
  if (!json || typeof json !== "object") return null;
  // Reject revoked / expired when present
  if ("revoked" in json && json.revoked === true) return null;
  if ("expired" in json && json.expired === true) return null;   // ← checks field "expired"
  ...
```

**Problem — three-way field-name mismatch.** The Clerk Backend API
`POST /v1/api_keys/verify` returns the expiry as **`expire_at`** (a Unix-ms timestamp
or `null`), per Clerk's reference docs — not `expired` (boolean) and not `expiration`.
The spike comment says `expiration`; the code checks `expired === true`; the real field
is `expire_at` (timestamp). The `expired === true` guard therefore never matches on the
verify response, so the defensive expiry rejection is dead code, and `expire_at` is
never compared against `now`. (Note: the boolean `expired` *does* appear on Clerk's
`GET /v1/api_keys` list response — `apps/web/src/lib/api-keys.ts:126` uses it there —
which is likely how the wrong field name leaked into the verify parser.)

**Post-cache impact.** `VerifiedKey` stores no expiration, so once a key is cached
(memory + Cache API, 60s TTL), a key whose `expire_at` elapses mid-window continues to
authenticate until the next `#verifyRemote`. The window is bounded at ~60–120s (Cache
API honors `max-age=60` per Cloudflare's Cache-API freshness semantics), and Clerk
itself returns 401 for expired keys on the next remote call, so the real-world blast
radius is small — but the local defensive layer is non-functional and the cached entry
does not honor expiry.

**Fix.** Read `expire_at` (`number | null`); if `!== null && now >= expire_at` return
`null`. Store `expireAt` on the cached entry and re-check against `now` on every cache
hit (memory + Cache API) so a key expiring mid-TTL is rejected without a remote round
trip. Add a test asserting an `expire_at` in the past yields `null`.

---

### [SEV: P2] Test coverage gaps — failure/caching paths untested

**Where** — `apps/gateway/test/key-verifier.test.ts` (116 ln, 12 tests).

**Problem.** Existing tests cover `extractApiKey` (5), `parseClerkVerifyResponse`
(5), and exactly 2 `ClerkKeyVerifier` behaviors (memory hit + 401 → null). The
following contracts have **no** test:

- Cache API read/write path (`#readCacheApi` / `#writeCacheApi`, including the
  `useCacheApi:true` branch with a fake `CacheStorage`).
- Negative caching of 5xx / 429 / transport throw (P1) — no test asserts these are
  cached (or, after the fix, not cached).
- Stampede / singleflight (P2) — no concurrency test.
- Fetch timeout (P2) — no test with a hanging fetch.
- `expired` / `expire_at` handling (P2) — no test for an expired key body.
- `#writeMemory` FIFO eviction at `MEMORY_MAX` (P3).
- Cache version tag (`v`) — no test that a missing/old `v` is treated as a miss.
- `parseCachedVerified` / `parseVerifiedKey` — unit-tested nowhere.
- `isApiKeySecret`, `sha256Hex`, `FixtureKeyVerifier.set` — untested.
- Revoked-key body (`revoked:true`) is tested for `parseClerkVerifyResponse` but not
  for the round-trip cache invalidation behavior.

**Impact.** The most dangerous behaviors (P1 negative caching, stampede) are exactly
the ones with no tests; regressions there are invisible.

**Fix.** Add tests for each bullet — especially: (a) 5xx/429/throw are not cached for
60s (after the P1 fix), (b) concurrent `verify` of a cold key calls Clerk once
(singleflight), (c) `expire_at` in the past → `null`, (d) cache schema mismatch →
miss.

---

### [SEV: P3] FIFO eviction, not LRU — hot keys evicted while cold keys persist

**Where** — `key-verifier.ts:106-116`.

```ts
#writeMemory(cacheKey: string, value: VerifiedKey | null, now: number): void {
  if (this.#memory.size >= MEMORY_MAX) {
    // Drop oldest insertion (Map preserves order).
    const first = this.#memory.keys().next().value;
    if (first !== undefined) this.#memory.delete(first);
  }
  this.#memory.set(cacheKey, { value, expiresAt: now + CACHE_TTL_SECONDS * 1000 });
}
```

**Problem.** Eviction is pure FIFO (oldest insertion). A continuously-hot key that was
inserted first is evicted the moment the map fills, even though it is read on every
request, while a cold key inserted later survives. Reads do not refresh insertion
order (no delete-then-set on hit), so the map is not LRU.

**Impact.** Low — `MEMORY_MAX=512` is well above typical distinct-key cardinality per
isolate, and the memory layer is currently dead in prod anyway (P1). But once the P1
fix lands, FIFO under load will evict the wrong keys.

**Fix.** On hit, `delete` then `set` to move the entry to the end (LRU); or track
`lastUsed` and evict the min. Simpler: cap by evicting the entry with the smallest
`expiresAt` (closest to expiry) rather than insertion order.

---

### [SEV: P3] Unread cache version tag — schema changes silently parse stale entries

**Where** — `key-verifier.ts:137` (write) + `key-verifier.ts:197-203` (read).

```ts
// write:
const body = JSON.stringify({ v: 1, value });
// read:
function parseCachedVerified(json: unknown): VerifiedKey | null | undefined {
  if (!json || typeof json !== "object") return undefined;
  if (!("value" in json)) return undefined;     // ← "v" never checked
  ...
}
```

**Problem.** The body carries a `v: 1` schema tag, but `parseCachedVerified` never
reads it. If the `VerifiedKey` shape or cache schema ever changes, old Cache-API
entries (which persist up to 60s after the last put) will be silently parsed under the
new schema, producing wrong `orgId`/`keyId`/`scopes`.

**Impact.** Low (TTL bounds staleness to 60s, and the current schema is stable), but
the tag exists for a reason and is currently decorative.

**Fix.** `if (json.v !== 1) return undefined;` (treat as miss).

---

### [SEV: P3] Unused `ClerkVerifyEnv` type — dead export

**Where** — `key-verifier.ts:18-20`.

```ts
export type ClerkVerifyEnv = {
  CLERK_SECRET_KEY: string;
};
```

**Problem.** `ClerkVerifyEnv` is exported but never imported anywhere (`apps/gateway`
grep shows only `ClerkKeyVerifierOptions` is used; the Worker `Env` interface in
`index.ts` declares its own `CLERK_SECRET_KEY`). Dead code.

**Fix.** Delete it, or wire it into `index.ts`'s `Env` (it was presumably intended as
the env-bound shape).

---

### [SEV: P3] `scopes` parsed and stored but never consumed downstream

**Where** — `key-verifier.ts:236-241, 250-255` (parse) + `key-verifier.ts:6-9`
(`VerifiedKey.scopes`) + `pipeline.ts`/`wallet.ts`/`mock.ts` (no `.scopes` access
anywhere — grep confirms).

**Problem.** `scopes` is parsed from both the Clerk response and the cached payload
into `VerifiedKey.scopes`, but no consumer in `apps/gateway/src` ever reads
`verified.scopes`. It is dead payload carried through the cache and the hot path.

**Impact.** Minor — wasted parse/serialize work and a misleading type that implies
scope-based authz exists. (`TECH.md:138` says Clerk returns scopes, so the field is
real; it is just unused.)

**Fix.** Either drop `scopes` from `VerifiedKey` until a consumer exists, or wire
scope enforcement into `pipeline.ts` (e.g. `verified.scopes.includes(matched.scope)`).

---

### [SEV: P3] `FixtureKeyVerifier` keys on the raw secret, inconsistent with `ClerkKeyVerifier`'s sha256 keying

**Where** — `key-verifier.ts:282-297`.

```ts
export class FixtureKeyVerifier implements KeyVerifier {
  readonly #keys: Map<string, VerifiedKey>;
  constructor(keys: Record<string, VerifiedKey> = {}) {
    this.#keys = new Map(Object.entries(keys));   // raw secret as key
  }
  async verify(secret: string): Promise<VerifiedKey | null> {
    return this.#keys.get(secret) ?? null;        // raw-secret lookup
  }
}
```

**Problem.** `ClerkKeyVerifier` keys memory/Cache-API by `sha256Hex(secret)`; the test
fixture keys by the raw secret. The two implementations of the same `KeyVerifier`
interface use different keying strategies. Not a security issue (test-only), but a
contract inconsistency that makes the fixture a poor stand-in for prod behavior.

**Fix.** Hash the secret in `FixtureKeyVerifier` too (or document that the fixture is
lookup-only and does not model caching).

---

### [SEV: P3] No TTL jitter — keys cached together expire together (thundering herd at TTL boundary)

**Where** — `key-verifier.ts:30` (`CACHE_TTL_SECONDS = 60`) + `key-verifier.ts:111`
(`expiresAt: now + CACHE_TTL_SECONDS * 1000`).

**Problem.** All keys verified in the same instant get the same `expiresAt`, so they
all expire together. On a burst that caches K keys at T=0, at T+60s all K miss memory
simultaneously and (if the Cache API entries have also aged out) all K hit Clerk in the
same window — a synchronized stampede.

**Impact.** Low (Cache-API stagger and Clerk's 1000/10s budget absorb most of it), but
it compounds the stampede (P2) and negative-cache (P1) findings.

**Fix.** Add ±10% jitter: `expiresAt: now + (CACHE_TTL_SECONDS * 1000) * (0.9 +
Math.random() * 0.2)`.

---

### [SEV: P3] `extractApiKey` silently prefers `x-api-key`; `isApiKeySecret` accepts empty remainder

**Where** — `key-verifier.ts:269-296` (`extractApiKey`) + `key-verifier.ts:260-263`
(`isApiKeySecret`).

```ts
export function isApiKeySecret(secret: string): boolean {
  return secret.startsWith("ak_") || secret.startsWith("zev_");   // "ak_" alone passes
}
export function extractApiKey(request: Request): string | null {
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    const trimmed = xApiKey.trim();
    if (isApiKeySecret(trimmed)) return trimmed;     // x-api-key wins over Authorization
  }
  ...
}
```

**Problem.** (a) When both `x-api-key` and `Authorization: Bearer ...` are present,
`x-api-key` wins silently — no precedence is documented and a mismatched pair could
surprise integrators. (b) `isApiKeySecret("ak_")` / `isApiKeySecret("zev_")` (bare
prefix, empty remainder) returns `true`, so a bare prefix is sent to Clerk as a
"secret"; Clerk rejects it, but it still hashes, caches (as null for 60s), and burns a
verify call. (c) No upper bound on secret length before `sha256Hex` + `JSON.stringify`
body — an attacker could send a multi-MB `x-api-key` to force hashing + a large Clerk
POST.

**Impact.** Low — Clerk rejects invalid keys, and the 60s null cache limits repeat
cost — but the bare-prefix and unbounded-length cases are cheap to harden.

**Fix.** Require `secret.length > 3` (some remainder after the prefix) in
`isApiKeySecret`; cap `extractApiKey` at a sane max length (e.g. 256); document the
`x-api-key` precedence or reject when both headers are present.

---

## Summary

**Counts:** P0 × 0 · P1 × 2 · P2 × 4 · P3 × 7 · **total 13**

**Top 3 to fix first:**
1. **P1 — negative caching of 5xx/429/transport (60s outage from a blip).** Highest
   blast radius: a momentary Clerk hiccup becomes a minute-long auth outage for every
   hot key, compounded by the stampede self-inflicting the 429. Differentiate failure
   modes; never cache transport/5xx for the full TTL.
2. **P1 — per-request instantiation kills the memory fast path.** Trivial fix (hoist to
   module scope), restores the documented sync cache, and removes the per-request Map
   allocation + the forced Cache-API round-trip on every authed request.
3. **P2 — stampede + no fetch timeout.** Add singleflight (mirror `wallet.ts`'s
   `#syncInFlight`) and `AbortSignal.timeout`; both directly feed the P1 outage loop.

**Cross-cutting note.** `TECH.md:138` already records the design intent: no Clerk
key-revocation webhooks → revocation relies on the 60s TTL safety net plus the
wallet-DO `keySettings` (`disabled` / `graceUntil`) layer. That makes the P1
negative-cache bug especially acute: the *only* thing bounding a revoked key's reach is
the 60s cache window, so caching a Clerk outage as `null` for 60s is symmetric damage
to availability. The `claims.org_id` field is genuine (`apps/web/src/lib/api-keys.ts`
creates keys with `claims: { org_id: orgId }`), so the `orgId`-based wallet routing
(`pipeline.ts:129`) is correct — not flagged.
