# Tiger Review — `apps/gateway/src/key-verifier.ts`

## Verdict

**Incorrect.** The file compiles and its unit tests pass, but the headline
performance invariant ("per-isolate memory cache, hot path never waits on
Clerk") is **not actually delivered in production**: `ClerkKeyVerifier` is
re-instantiated per request inside `buildDeps`, so the `#memory` Map is thrown
away on every fetch and only the Cache API survives. On top of that,
failures (network errors, 4xx/429/5xx) are negatively cached for 60 s at the
Cache API layer, which converts a brief Clerk hiccup or rate-limit into a
full minute of "every key invalid" across the isolate. Several smaller
correctness and hygiene issues below.

## File Stats

- File: `apps/gateway/src/key-verifier.ts` (297 lines)
- Cross-read: `apps/gateway/src/index.ts` (verifier wiring), `apps/gateway/test/key-verifier.test.ts`, `apps/gateway/test/pipeline.test.ts`, `convex/keySettings.ts`, `apps/gateway/src/wallet.ts` (per-key enforcement), `apps/gateway/src/pipeline.ts` (verify callsite).
- Cache layers: per-instance `#memory` Map (TTL 60 s, FIFO 512) + Cloudflare Cache API (`zevium-api-key-verify-v1`, `max-age=60`).

## Findings

### [P1] Per-request `ClerkKeyVerifier` instantiation defeats the in-isolate memory cache

**Location:** `apps/gateway/src/index.ts:68-70` (call site) + `apps/gateway/src/key-verifier.ts:48-72` (class) + `key-verifier.ts:75-100` (`verify`).

```ts
// index.ts — inside buildDeps(env), called per fetch:
const keyVerifier = env.CLERK_SECRET_KEY
  ? new ClerkKeyVerifier({ secretKey: env.CLERK_SECRET_KEY })
  : new FixtureKeyVerifier();
```

```ts
// key-verifier.ts — instance state:
readonly #memory = new Map<string, MemoryEntry>();   // per-instance
```

**Problem.** `buildDeps(env)` is invoked from the worker `fetch` handler on
every gateway/mock/mcp/discovery request (see `index.ts:147,157,166,173`). It
constructs a brand-new `ClerkKeyVerifier`, so `#memory` starts empty each
request and is garbage-collected before the next request reuses it. The
entire memory-cache layer — `MEMORY_MAX = 512`, the FIFO eviction in
`#writeMemory`, the `expiresAt` TTL, the "memory hit short-circuits Cache API"
branch in `verify` — is dead in production. Every hot-path verify pays a
Cache API `open()` + `match()` round trip instead of the documented in-memory
fast path. The module doc comment

```ts
/**
 * API key verification with per-isolate memory + Cache API (TTL 60s).
 * Hot path never waits on Clerk when cache hits.
 */
```

is false as shipped. Only the Cache API provides cross-request caching, and
the memory cache only ever memoizes a single request's verify (pointless —
one verify per request).

**Impact.** Latency regression vs. design intent on every authenticated
gateway call; misleading comments + tests that exercise the memory cache
(`key-verifier.test.ts:114-145`) give false confidence that the production
hot path is memory-served. Also eliminates the only layer that could have
provided in-flight de-duplication (see next finding).

**Fix.** Hoist the verifier to module scope (singleton per isolate),
mirroring the `testDeps` pattern:

```ts
// index.ts
let prodVerifier: KeyVerifier | null = null;
function getVerifier(env: Env): KeyVerifier {
  if (env.CLERK_SECRET_KEY) {
    prodVerifier ??= new ClerkKeyVerifier({ secretKey: env.CLERK_SECRET_KEY });
    return prodVerifier;
  }
  return new FixtureKeyVerifier();
}
```

(or memoize `buildDeps` keyed on `env` identity). Confirm the singleton is
safe to share across concurrent requests — `#memory` is a `Map` mutated
without locking, and `Map.set`/`get`/`delete` are not atomic across
`await` boundaries; concurrent `verify` calls for different keys can race
the FIFO eviction, but the worst case is a redundant eviction, not
corruption, so this is acceptable.

---

### [P1] Negative caching of Clerk failures for 60 s amplifies outages and rate-limits

**Location:** `apps/gateway/src/key-verifier.ts:75-100` (`verify` caches
`#verifyRemote` result unconditionally) + `key-verifier.ts:158-184`
(`#verifyRemote` returns `null` on network throw / non-ok) +
`key-verifier.ts:120-153` (`#writeCacheApi` stores `null` with
`max-age=60`).

```ts
// verifyRemote: any failure becomes null…
try {
  res = await this.#fetch(this.#verifyUrl, { ... });
} catch {
  return null;
}
if (!res.ok) return null;

// …and verify caches null for the full 60 s TTL at both layers:
const verified = await this.#verifyRemote(secret);
this.#writeMemory(cacheKey, verified, now);              // null cached
if (this.#useCacheApi && this.#caches) {
  void this.#writeCacheApi(cacheKey, verified);          // null cached, max-age=60
}
```

**Problem.** `verify` does not distinguish "key is genuinely invalid/revoked"
from "Clerk was unreachable, returned 429, 500, 502, or the fetch threw."
All of these collapse to `null`, which is stored with the same 60 s TTL as
a positive result — and because the Cache API entry is shared across the
whole isolate (and across requests, since the Cache API is the only layer
that survives — see prior finding), a single failed Clerk call poisons
verification for that key for a full minute. A burst of requests against
N distinct keys during a 5 s Clerk hiccup poisons N entries. Worse, Clerk
rate-limiting (429) on the verify endpoint — exactly what you'd expect under
a burst — produces `null` for every key being verified, which the gateway
turns into `402 invalid_api_key` for paying customers for 60 s.

**Impact.** A transient Clerk outage or rate-limit window is stretched into
a 60 s total auth outage at the edge. This is the opposite of the
project rule "never surprise-overage / never block legitimate traffic" —
legitimate, funded keys are rejected. The negative cache also interacts
badly with key rotation: the moment a new key is first verified during a
Clerk blip, it's cached as invalid for a minute.

**Fix.** Do not cache failures. Only cache `null` when Clerk **positively**
said the key is invalid (e.g. 401/403 with a parseable body), and treat
network errors / 5xx / 429 as cache-miss (re-try next request). If a short
negative TTL is desired for invalid-key brute-force protection, it must be
much shorter than the positive TTL (e.g. 5 s) and ideally only memory-local
(not Cache API) so an isolate restart clears it:

```ts
const verified = await this.#verifyRemote(secret);
// Only cache authoritative rejections, not transport failures.
this.#writeMemory(cacheKey, verified, now);
if (verified !== null && this.#useCacheApi && this.#caches) {
  void this.#writeCacheApi(cacheKey, verified);
}
// For null: optionally a short memory-only negative entry.
```

This requires `#verifyRemote` to distinguish the cases — return a tagged
result (`{ ok: false, retryable: true }` vs. `{ ok: false, retryable: false }`)
instead of collapsing to `null`.

---

### [P2] Cache stampede on miss — no in-flight de-duplication

**Location:** `apps/gateway/src/key-verifier.ts:75-100` (`verify`).

```ts
const verified = await this.#verifyRemote(secret);
this.#writeMemory(cacheKey, verified, now);
if (this.#useCacheApi && this.#caches) {
  void this.#writeCacheApi(cacheKey, verified);
}
```

**Problem.** When both memory and Cache API miss (cold key, or after TTL
expiry), every concurrent request for the same secret calls `#verifyRemote`
independently — there is no in-flight promise map to coalesce them. With the
per-request verifier instantiation (P1 above) there is no place to hold such
a map anyway. Under a burst against a freshly-rotated or just-expired key,
N requests produce N Clerk verify POSTs for the same secret, which is
exactly the condition that triggers Clerk 429 → P1 amplification.

**Impact.** Burst traffic amplifies into Clerk rate-limiting, which then
cascades into the 60 s negative-cache outage. Self-inflicted.

**Fix.** Once the verifier is a singleton (P1 fix), add an in-flight map:

```ts
readonly #inflight = new Map<string, Promise<VerifiedKey | null>>();
async verify(secret: string) {
  // ... cache checks ...
  const existing = this.#inflight.get(cacheKey);
  if (existing) return existing;
  const p = this.#verifyRemote(secret).finally(() => {
    this.#inflight.delete(cacheKey);
  });
  this.#inflight.set(cacheKey, p);
  const verified = await p;
  this.#writeMemory(cacheKey, verified, this.#now());
  if (this.#useCacheApi && this.#caches) void this.#writeCacheApi(cacheKey, verified);
  return verified;
}
```

---

### [P2] No fetch timeout on `#verifyRemote` — slow Clerk hangs the gateway request

**Location:** `apps/gateway/src/key-verifier.ts:161-170`.

```ts
res = await this.#fetch(this.#verifyUrl, {
  method: "POST",
  headers: { authorization: `Bearer ${this.#secretKey}`, ... },
  body: JSON.stringify({ secret }),
});
```

**Problem.** There is no `AbortController` / timeout on the verify POST. A
slow or hung Clerk endpoint keeps the gateway request open until the
Worker subrequest/CPU limit kicks in (tens of seconds). During that window
the affected request holds reservation/in-flight state and the user sees a
long stall before an eventual `null` (which then gets negatively cached —
P1). The gateway's whole value proposition is low-latency metered proxying;
an unbounded upstream auth call breaks that.

**Impact.** Tail latency blow-up and request stalls during Clerk
degradation; compounds the negative-cache amplification.

**Fix.**

```ts
const controller = new AbortController();
const t = setTimeout(() => controller.abort(), 3000);
try {
  res = await this.#fetch(this.#verifyUrl, {
    method: "POST",
    signal: controller.signal,
    headers: { authorization: `Bearer ${this.#secretKey}`, "content-type": "application/json" },
    body: JSON.stringify({ secret }),
  });
} finally {
  clearTimeout(t);
}
```

---

### [P2] No edge-cache invalidation path for revoked / rotated / disabled keys

**Location:** `apps/gateway/src/key-verifier.ts:75-100` (positive cache
write) + `convex/keySettings.ts` (`setDisabled`, `recordRotation`) +
`apps/gateway/src/wallet.ts:465-490` (DO enforces `disabled`/`graceUntil`).

**Problem.** The verifier caches a positive `VerifiedKey` for 60 s at both
memory and Cache API layers, and there is no `purge(secret)` / `invalidate`
method on `KeyVerifier` and no call site that invokes one. When a customer
revokes a key in Clerk (or rotates it, or sets `disabled`), the edge
continues to return the stale positive entry for up to 60 s. The wallet DO
**does** enforce `disabled` and `graceUntil` from `keySettings`
(`wallet.ts:465-490`), so a *disabled* key is still gated downstream — but
**Clerk-side revocation** is not mirrored into `keySettings`, so a revoked
key with remaining credits sails through the wallet check for the full TTL
window. The project rule "zero wallet balance blocks the call" does not
cover "revoked key with balance."

**Impact.** Up to 60 s of continued access after revocation for any key
that still has credits — exactly the "never surprise the operator" scenario
the cache was supposed to be bounded against. The TTL is documented, but
there is no escape hatch for sensitive events (rotation, suspected
compromise, explicit revoke).

**Fix.** Either (a) shorten the positive TTL substantially (e.g. 10 s) and
accept higher Clerk load, or (b) expose `invalidate(secret: string)` on
`KeyVerifier` that purges both `#memory` and the Cache API entry, and call
it from the web `rotateKey` server function and from a Clerk webhook
handler on `api_key.revoked`. At minimum, document the 60 s revocation lag
as an accepted tradeoff in the module doc comment (currently silent).

---

### [P2] FIFO eviction, not LRU — trivially flushable by an attacker

**Location:** `apps/gateway/src/key-verifier.ts:103-111`.

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

**Problem.** Eviction is by **insertion order** (FIFO), not by recency of
access. `Map.keys().next()` returns the first-inserted key regardless of
how recently it was read. An attacker (or just a burst of distinct
one-shot keys) sending 512+ distinct `ak_`/`zev_`-prefixed strings evicts
the legitimate hot key that was inserted first, forcing it back to a
Cache API miss (and, combined with P3 below, a Clerk call). A read on a key
does not move it to the back of the queue. Note: this only matters once
the P1 singleton fix lands — today the memory cache is per-request and
never fills.

**Impact.** Cache-hit rate degradation under adversarial or even just
high-cardinality traffic; turns a cheap in-memory hit into a Cache API
round trip (and, if Cache API is also cold, a Clerk call).

**Fix.** Re-insert on read to approximate LRU, or use a proper LRU
container:

```ts
const mem = this.#memory.get(cacheKey);
if (mem && mem.expiresAt > now) {
  // Move to back (most-recently-used).
  this.#memory.delete(cacheKey);
  this.#memory.set(cacheKey, mem);
  return mem.value;
}
```

---

### [P3] Cache payload version tag `v: 1` written but never validated on read

**Location:** `apps/gateway/src/key-verifier.ts:131-136` (write) +
`key-verifier.ts:186-194` (`parseCachedVerified`).

```ts
// write:
const body = JSON.stringify({ v: 1, value });

// read:
function parseCachedVerified(json: unknown): VerifiedKey | null | undefined {
  if (!json || typeof json !== "object") return undefined;
  if (!("value" in json)) return undefined;     // 'v' never checked
  const value = json.value;
  ...
}
```

**Problem.** A schema-version field is written but never read. If the
`VerifiedKey` shape ever gains a required field, stale Cache API entries
with the old shape (still within their 60 s TTL) will be accepted by
`parseVerifiedKey` as long as the old fields are present, silently serving
entries missing the new field. The version tag exists precisely to
prevent this and is dead.

**Impact.** Future schema regressions; no current breakage.

**Fix.** Check the version and bail on mismatch:

```ts
if (!("v" in json) || json.v !== 1) return undefined;
```

---

### [P3] `ClerkVerifyEnv` exported type is unused dead code

**Location:** `apps/gateway/src/key-verifier.ts:16-18`.

```ts
export type ClerkVerifyEnv = {
  CLERK_SECRET_KEY: string;
};
```

**Problem.** Grep across `apps/gateway/src` and `apps/gateway/test` shows
no importer of `ClerkVerifyEnv`. The env shape actually used by the
worker is `Env` in `index.ts`, which marks `CLERK_SECRET_KEY` as optional
(`CLERK_SECRET_KEY?: string`). This exported type is misleading (claims
required) and unused.

**Impact.** Confusion for future maintainers; `Env` is the source of
truth.

**Fix.** Delete `ClerkVerifyEnv`, or — if it was meant to constrain the
verifier's env view — actually use it at the `buildDeps` call site.

---

### [P3] `expired` handled but `expiration` not compared — stale valid within TTL window

**Location:** `apps/gateway/src/key-verifier.ts:211-213`.

```ts
// Reject revoked / expired when present
if ("revoked" in json && json.revoked === true) return null;
if ("expired" in json && json.expired === true) return null;
```

**Problem.** Clerk returns `expired` (boolean) **and** `expiration` (Unix
timestamp). The verifier correctly rejects when `expired === true` at
verify time, but the positive result is then cached for 60 s with no
record of the `expiration` deadline. If a key's `expiration` falls during
the cache window, the cached `VerifiedKey` continues to authorize calls
until the TTL elapses — Clerk's authoritative `expired` flag is no longer
being consulted.

**Impact.** Up to 60 s of post-expiration access for keys that expire
naturally (not revoked). Inherent to TTL caching, but unmitigated and
undocumented.

**Fix.** Either cap the cache TTL to `min(60 s, expiration - now)` when
`expiration` is present, or note the accepted lag in the module comment.

---

### [P3] Test coverage gaps mask the P1/P2 defects

**Location:** `apps/gateway/test/key-verifier.test.ts`.

**Problem.** The tests exercise only `useCacheApi: false` and a single
sequential verify; they never assert:
- that the **Cache API** path works end-to-end (a fake `CacheStorage` is
  trivial to inject via `caches:` and `now:`);
- that a **network failure** is negatively cached (P1 amplification);
- that **concurrent** verifies for the same secret coalesce (P2 stampede);
- that the `expired` field is rejected (only `revoked` is tested);
- that the memory cache is actually shared across `ClerkKeyVerifier`
  instances vs. per-instance (which would have caught the P1
  per-request-instantiation bug, since `pipeline.test.ts` uses
  `FixtureKeyVerifier`, not `ClerkKeyVerifier`).

**Impact.** The P1 regression (per-request instantiation) shipped with
green tests because no test asserts cross-request memory reuse through
the real `ClerkKeyVerifier`.

**Fix.** Add a test that constructs two `ClerkKeyVerifier` instances the
way `buildDeps` does and asserts the second one does **not** re-hit
`fetchImpl` for a key the first verified — which it currently does,
demonstrating the bug.

---

## Summary

| Sev | Count | Top issues |
|-----|-------|------------|
| P0  | 0     | — |
| P1  | 2     | Per-request instantiation defeats memory cache; 60 s negative-cache amplification of Clerk outages/429 |
| P2  | 4     | No in-flight de-dup (stampede); no fetch timeout; no revocation invalidation path; FIFO eviction |
| P3  | 4     | Unread cache `v` tag; unused `ClerkVerifyEnv`; `expiration` not honored post-cache; test gaps |

**Total findings: 10.**

The three highest-leverage fixes, in order:
1. Make `ClerkKeyVerifier` a singleton per isolate (unblocks the memory
   cache and in-flight de-dup).
2. Stop caching transport/rate-limit failures as authoritative rejections.
3. Add a fetch timeout and an `invalidate(secret)` hook wired to Clerk
   revocation + `recordRotation`.

No P0 — no data corruption or auth bypass. But the P1s are real
availability/correctness regressions vs. the documented design, and the
negative-cache amplification can take the whole gateway's auth path down
for a minute off a brief Clerk blip.
