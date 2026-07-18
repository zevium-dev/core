# Tiger Review — `apps/gateway/src/pipeline.ts` (DEEP)

## Verdict

**INCORRECT — do not merge.** The pipeline is the metered-proxy core and the
single enforcement point between Zevium and unmetered upstream calls. The
skeleton is right (verify → spec → match → free-tier or reserve → proxy →
settle/refund → usage), the wallet DO holds the credit atomically, and the
streamed body is genuinely streamed. But the proxy layer leaks three classes
of defect that each undermine the metering guarantee or the security posture:

1. **Credit-leak on the happy/sad path.** `settle`/`refund` are `await`ed
   but their return values are **discarded**, and a worker crash between
   `reserve` and `settle`/`refund` leaves the reservation pinned in
   `#inFlight` forever (no reaper, no timeout, no alarm-driven cleanup).
   The same is true of the upstream fetch: it has **no timeout**, so a
   hanging upstream holds the hold + the subrequest for the full worker
   wall-clock. If `settle` throws, the upstream body is dropped and the
   client gets a bare 500 — **after** the upstream was already called —
   with no refund attempted. Net effect: every flaky DO/storage call can
   permanently pin a consumer's credits.

2. **Header hygiene is wrong in both directions.** `filterRequestHeaders`
   forwards `cookie`, `x-forwarded-for`, `x-forwarded-host`,
   `x-forwarded-proto`, `forwarded` to the upstream (consumer-supplied IP
   spoofing + session fixation against publisher upstreams).
   `filterResponseHeaders` forwards upstream `set-cookie` to the client
   (cookie injection on the gateway origin) and forwards upstream
   `location` on 3xx without rewriting — which leaks the upstream URL and
   lets a redirect follower **bypass metering entirely**.

3. **Information disclosure + SSRF surface.** The 502 envelope embeds the
   raw `fetch` error message verbatim (`connect ECONNREFUSED 10.x.x.x:443`,
   DNS names, etc.), and the gateway performs **zero validation** on
   `matched.upstreamBaseUrl` — a publisher (or anyone who can publish a
   spec) can point `servers[0].url` at `http://169.254.169.254/...` or any
   internal RFC1918 address and have the worker proxy to it.

Plus a handful of correctness bugs: `sunsetAt` epoch-unit inconsistency
between spec-source (documented seconds) and pipeline (treated as ms),
`verified.scopes` extracted then never enforced, free-tier consume has no
reservation idempotency (the pipeline is the caller of the bug noted in the
wallet review), free-tier refund uses refund-time day key (UTC-midnight
rollover), and the `now()` clock is sampled 6+ times per request. The prior
pass found 4 P2 + 4 P3; this deep-dive expands to 7 P1 + 9 P2 + 6 P3.

## File Stats

- File: `apps/gateway/src/pipeline.ts` (411 lines)
- Cross-read: `apps/gateway/src/wallet.ts`, `key-verifier.ts`, `usage.ts`,
  `spec-source.ts`, `headers.ts`, `errors.ts`, `x402.ts`, `cors.ts`,
  `index.ts`, `packages/shared/src/openapi.ts`.
- Findings: 22 — P0: 0, P1: 7, P2: 9, P3: 6

---

## Findings

### [P1] `settle` / `refund` return values are discarded — ledger desync + silent credit leak

**Location:** lines 339, 351, 357, 322, 309 (all four terminal paths).

**Problem.** Every terminal branch awaits the wallet RPC and throws the
result away:

```ts
} else if (status >= 200 && status < 300) {
  await wallet.settle(reservationId, usageMeta);          // result dropped
  emitUsage(ctx, deps, { ... outcome: "settled", ... });
} else {
  await wallet.refund(reservationId);                      // result dropped
  emitUsage(ctx, deps, { ... outcome: "refunded", ... });
}
```

`settle` returns `already_settled` | `already_refunded` | `already_free` |
`unknown`; `refund` returns the same shape minus `already_settled` plus
`already_refunded`. None are `void`. The pipeline emits `outcome: "settled"`
(or `"refunded"`) **regardless of what the ledger actually did**. Concretely:

- If a concurrent retry / DO alarm / replay already settled this
  `reservationId`, `settle` returns `already_settled` — the pipeline still
  tells the client `x-zevium-cost: <cost>` and emits `settled` usage. The
  upstream was called twice (once per request) but charged once — fine for
  the wallet, but the usage row is double-emitted, inflating analytics.
- If `settle` returns `unknown` (reservation not in `#inFlight` — e.g. it
  was reaped or never reserved), the pipeline still emits `settled` and
  returns 200 with `x-zevium-cost`. The consumer is told they were charged
  for a call whose reservation does not exist.
- Symmetric for `refund`: an `already_settled` outcome on the error path
  means the call was charged despite the upstream failing.

**Impact.** Usage analytics and `x-zevium-cost` response headers can
contradict the authoritative ledger state. In the `unknown` case the
consumer is billed (per the response header) for a call that never touched
the wallet. Both are silent — no log, no error.

**Fix.** Branch on the returned status:

```ts
const r = await wallet.settle(reservationId, usageMeta);
if (r.status !== "settled" && r.status !== "already_settled") {
  // settle couldn't apply — the hold is now in an unknown state.
  // Emit a distinct outcome and surface a 502 so the client retries.
}
```

At minimum, log non-`settled`/non-`refunded` outcomes and stop emitting
`settled` usage when the ledger disagrees.

---

### [P1] No reaper / timeout for `#inFlight` reservations — worker crash pins credits forever

**Location:** `reserve` creates `InFlightEntry { cost, createdAt, keyId? }`
(wallet.ts lines 491–496); pipeline never calls `refund` on its own crash.

**Problem.** The pipeline holds a reservation between `reserve` (line 168)
and `settle`/`refund` (lines 308–360). If the worker is evicted, hits the
wall-clock/subrequest limit, or throws anywhere in between (spec parse,
match, upstream fetch, header filter, settle RPC), the reservation stays
in `#inFlight` on the DO. `InFlightEntry.createdAt` exists but **nothing
reads it** — there is no alarm that GCs stale in-flight entries, no TTL,
no max-age. `#scheduleFlushAlarm` only fires for pending settlements, not
in-flight holds.

So a worker crash between `reserve` and `settle` permanently reduces the
consumer's `available` by `cost`. The credit is not lost from the ledger
(`balance` is unchanged) but it is **permanently unusable** — every
subsequent `reserve` sees `available = balance - sumInFlight` reduced by
the dead hold. Repeated crashes accumulate.

This is the canonical TOCTOU the ticket asks about: the check-and-deduct is
atomic *within* the DO, but the gateway's reserve→settle window is not
covered by any cleanup contract.

**Impact.** Per failed request, `cost` credits become permanently
unspendable for the consumer's org. Under upstream flakiness or worker
pressure this drains wallets without a single successful call. There is no
observability — the hold just sits in `#inFlight` forever.

**Fix.** (a) Bound `InFlightEntry` with a TTL and have the DO alarm reap
entries whose `createdAt + TTL < now` (treating them as refunded). (b) In
the pipeline, wrap the reserve→settle window in a `try/finally` that
refunds on any throw that happens after a successful reserve and before
settle. (c) Add a request-level timeout on the upstream fetch (see next
finding) so a hanging upstream cannot extend the window indefinitely.

---

### [P1] Upstream `fetchImpl` has no timeout — hanging upstream pins hold + worker

**Location:** line 195 (`upstreamRes = await fetchImpl(upstreamUrl.toString(), init);`).

**Problem.** The upstream fetch uses the worker default with no
`AbortController` / `signal`. A slow or hung upstream (TCP accept but no
response, slow-loris-style drip) holds the in-flight reservation, the
worker subrequest, and the client connection until the worker's own
wall-clock limit fires — at which point the worker is killed and the
reservation is orphaned (see previous P1). Even before that, the consumer
is paying wall-clock latency for a call that will never succeed.

Workers' default subrequest timeout is generous; combined with the
reserve→settle leak this is a clean credit-drain vector: a malicious or
broken publisher upstream that hangs forever permanently pins one
`cost`-credit hold per hung request per consumer, with no automatic refund.

**Impact.** Credit drain + worker resource exhaustion. A single
misbehaving upstream project can pin every consumer's wallet by accepting
connections and never responding.

**Fix.** Wrap the fetch in an `AbortController` with a bounded timeout
(e.g. 30s, configurable per route) and on abort treat it identically to
the `catch` branch (refund + 502):

```ts
const ctrl = new AbortController();
const t = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
try {
  upstreamRes = await fetchImpl(upstreamUrl.toString(), { ...init, signal: ctrl.signal });
} finally {
  clearTimeout(t);
}
```

---

### [P1] `cookie` forwarded to upstream + `set-cookie` forwarded to client — session fixation + cookie injection

**Location:** `filterRequestHeaders` (headers.ts lines 27–46) and
`filterResponseHeaders` (headers.ts lines 51–63).

**Problem.** `HOP_BY_HOP` strips `authorization` and `x-api-key` (good)
but does **not** strip `cookie` (request direction) or `set-cookie`
(response direction). Neither is in the RFC 7230 §6.1 hop-by-hop list, so
they pass through verbatim.

Two concrete attacks:

1. **Request direction — session fixation against the upstream.** A
   consumer sends `Cookie: session=<attacker-controlled-value>`. The
   gateway forwards it to the publisher's upstream. If the upstream is a
   cookie-authenticated service (common for internal APIs proxied through
   Zevium), the consumer can pin a session of their choosing or replay a
   captured session. The gateway is supposed to be the auth boundary —
   forwarding consumer cookies through it defeats that.

2. **Response direction — cookie injection on the gateway origin.** The
   publisher's upstream returns `Set-Cookie: session=...; Domain=...`. The
   gateway forwards it to the client. For same-origin browser callers
   (the catalogue try-it UI on the gateway origin) and any non-browser
   client, this cookie is stored against the gateway origin. Subsequent
   gateway requests then carry it — and per (1) it is forwarded back to
   the upstream. End-to-end the publisher can plant a tracking / session
   cookie on every consumer that hits them through Zevium.

   CORS mitigates cross-origin browser storage (`access-control-allow-origin: *`
   with no `allow-credentials` means browsers drop cross-origin Set-Cookie),
   but same-origin browser callers and all non-browser clients are exposed.

**Impact.** Session fixation against publisher upstreams; persistent
tracking-cookie injection on the gateway origin. Both are silent and
require no privilege.

**Fix.** Add `cookie` and `set-cookie` to the strip set in both filters
(unless an explicit opt-in cookie-passthrough mode is added later with
per-project allow-listing).

```ts
const STRIP_REQUEST = { ...HOP_BY_HOP, cookie: true };
const STRIP_RESPONSE = { ...HOP_BY_HOP, "set-cookie": true };
```

---

### [P1] `x-forwarded-*` / `forwarded` forwarded to upstream — client-IP spoofing

**Location:** `filterRequestHeaders` (headers.ts lines 27–46).

**Problem.** The filter strips Cloudflare noise (`cf-connecting-ip`,
`cf-ray`, …) but does **not** strip `x-forwarded-for`,
`x-forwarded-host`, `x-forwarded-proto`, or `forwarded`. A consumer can
send `X-Forwarded-For: 1.2.3.4` and have it forwarded to the upstream
verbatim. Worse, the gateway **does not add its own** `X-Forwarded-For`,
so the upstream sees either nothing (if the consumer omits it) or the
consumer's forged value (if they supply one). There is no trustworthy
client-IP signal at the upstream.

This is the classic proxy-header-forwarding bug the ticket calls out. It
matters because publisher upstreams commonly trust `X-Forwarded-For` for
rate limiting, geo, audit logging, and abuse detection — all of which
become consumer-controllable.

**Impact.** Upstream rate-limiting, abuse signals, and audit logs are
consumer-spoofable. A consumer can defeat per-IP upstream throttling by
rotating `X-Forwarded-For`, or pin blame on a third party in audit logs.

**Fix.** Strip all `x-forwarded-*` and `forwarded` from the incoming
request, then append the gateway's view of the client address
(`cf-connecting-ip` if present, else the socket remote) to a fresh
`X-Forwarded-For`. Same for `x-forwarded-proto` / `x-forwarded-host` — set
them from the gateway request, not the consumer.

---

### [P1] No validation of `matched.upstreamBaseUrl` — SSRF to internal/metadata endpoints

**Location:** lines 191–196 (`new URL(joinUpstreamUrl(matched.upstreamBaseUrl, ...))` → `fetchImpl`).

**Problem.** `upstreamBaseUrl` comes directly from the published spec's
`servers[0].url` (via `matchOperation` → `parseSpec`). The gateway performs
**no validation** on it — no scheme allow-list, no private-IP block, no
metadata-endpoint block. A publisher (or anyone able to publish a spec via
the control plane) can set:

```
servers:
  - url: http://169.254.169.254/latest/meta-data/iam/security-credentials/
```

or `http://10.0.0.5:8080/admin`, `http://localhost:9090/metrics`, etc. The
worker will dutifully proxy the consumer's request to that URL and stream
the response back. Because the worker runs inside Cloudflare's network,
`169.254.169.254` is not the cloud-metadata endpoint (that's AWS/GCP), but
RFC1918 / loopback / link-local addresses **reachable from the worker**
are still a real SSRF surface — and if Zevium ever moves the worker to a
runtime with a metadata endpoint, this becomes critical.

The pipeline also forwards the consumer's query string and body, so the
SSRF is interactive: the consumer can drive the request method, path
(remainder), query, and body against any internal target the publisher
chose.

**Impact.** Publisher-driven SSRF through Zevium's worker. Internal
service enumeration, credential exfiltration from any metadata-style
endpoint, and internal-port scanning using the consumer's request shape.
The marketplace trust model assumes publishers are vetted, but nothing
in the gateway enforces it — the validation belongs at the enforcement
boundary (here), not at publish time only.

**Fix.** Validate `upstreamBaseUrl` against an allow-list (scheme `https`
in production, hostname not in private/loopback/link-local ranges) before
`fetchImpl`. Reject `169.254.0.0/16`, `127.0.0.0/8`, `10.0.0.0/8`,
`172.16.0.0/12`, `192.168.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`.

---

### [P1] Upstream fetch error message leaked verbatim in 502 envelope

**Location:** lines 197–222.

**Problem.** On upstream fetch failure the pipeline returns:

```ts
const message = err instanceof Error ? err.message : "upstream error";
...
return jsonError(502, "upstream_error", message, requestId);
```

`err.message` from a worker `fetch` failure contains raw transport detail:
`"connect ECONNREFUSED 10.0.0.5:443"`, `"fetch failed: DNS name not
resolved: upstream.internal.example.com"`, TLS cert errors, etc. The
`errors.ts` contract says `message` is "always a short, human-safe string"
that never leaks internals — this branch violates that contract directly,
exposing internal upstream hostnames, IPs, ports, and TLS state to the
consumer.

This is also a stable side-channel: an attacker can probe `servers[0].url`
reachability from the worker by observing the leaked message (combined
with the SSRF gap above, this is a full internal-network scanner with
readable error output).

**Impact.** Internal topology / hostname / port disclosure per upstream
failure. Violates the stated `errors.ts` invariant.

**Fix.** Return a fixed human-safe string (`"Upstream unreachable"`) and
log the real error server-side:

```ts
console.error("upstream fetch failed", { requestId, err });
return jsonError(502, "upstream_error", "Upstream unreachable", requestId);
```

---

### [P2] `settle` / `refund` block the streamed response — TTFB delayed by a DO RPC + storage txn

**Location:** lines 308–360 (success path: `await wallet.settle(...)` before `return new Response(upstreamRes.body, ...)`).

**Problem.** The upstream body is genuinely streamed (`upstreamRes.body`
is passed straight through — no buffering, good), but the pipeline
`await`s `wallet.settle(reservationId, usageMeta)` **before** handing the
body to the `Response` constructor. So time-to-first-byte for every
successful proxied call includes the full DO RPC + storage transaction
that `settle` performs (`#persist` writes `balance`, `inFlight`,
`pendingSettlements`, `terminal`, and the per-key `settledCounter`).

This is the right correctness choice — settling in `ctx.waitUntil` would
open a double-spend window (the consumer's next request sees the full
`available` before the deduction commits). But the latency cost is real
and unavoidable per-call: a storage transaction on the consumer's wallet
DO sits on the critical path of every proxied byte.

Worse: if `settle` throws (storage transient, DO eviction mid-call), the
function rejects, the upstream body is abandoned, and the client gets a
bare 500 from the worker — **after** the upstream was already called. No
refund is attempted in that throw path (the `catch` only wraps `fetchImpl`,
not `settle`).

**Impact.** Per-call TTFB tax equal to one DO storage transaction; on
settle failure, the upstream call is wasted, the client sees a 500, the
reservation stays in `#inFlight` (see P1), and no refund runs.

**Fix.** Wrap the entire post-reserve window (upstream fetch + settle +
refund + emit) in a single `try/finally` that refunds on any throw before
settle commits. For the latency tax, consider an async settle that
piggybacks on the existing alarm flush — but only if the double-spend
window is closed another way (e.g. the DO exposes `available` net of
in-flight and the pipeline reads `available` synchronously, which it does
not today).

---

### [P2] `redirect: "manual"` + `location` forwarded — leaks upstream URL and bypasses metering

**Location:** line 190 (`redirect: "manual"`) + `filterResponseHeaders`
(does not strip `location`).

**Problem.** With `redirect: "manual"`, any 3xx from the upstream is
returned to the client as-is, including its `Location` header. The
response filter does not strip or rewrite `location`, so the consumer sees
the upstream's real URL in the `Location` header (topology leak) and, if
they follow it, the next request goes **directly to the upstream** —
bypassing the gateway, the credit gate, and the usage pipeline entirely.

The 3xx path is also uncharged: the success branch is
`status >= 200 && status < 300`, so a 301/302 falls into the `else` and
calls `wallet.refund(...)`. The consumer gets a free redirect that points
them at an unmetered URL.

**Impact.** Upstream URL disclosure; metering bypass for any upstream that
redirects (very common: `http` → `https`, `…/` → `…/`, old paths → new
paths). One well-placed 301 permanently exempts a consumer from billing
on that route.

**Fix.** Either follow redirects (drop `manual`) and re-charge per hop, or
rewrite `Location` to point back through the gateway (`/gateway/:org/:project`
prefix) and strip the upstream host. At minimum, do not refund 3xx — treat
3xx as a successful proxied response for billing purposes.

---

### [P2] `sunsetAt` / `deprecatedAt` epoch-unit inconsistency — wrong Sunset header

**Location:** lines 376–389.

**Problem.** `spec-source.ts` documents both `deprecatedAt` and `sunsetAt`
as **epoch seconds** (`/** Epoch seconds ... */`). The pipeline treats
them inconsistently:

```ts
// deprecatedAt: ms → seconds (assumes MS)
outHeaders.set("Deprecation", `@${Math.floor(published.deprecatedAt / 1000)}`);
// sunsetAt: passed straight to new Date() (assumes MS)
outHeaders.set("Sunset", new Date(published.sunsetAt).toUTCString());
```

If the values really are epoch seconds (per spec-source), then:
- `Deprecation` divides by 1000 → emits `@1735689` (off by 1000×, year ~1970).
- `Sunset` calls `new Date(1735689600)` → `1970-01-21` (off by 1000×).

If they are epoch ms (matching the pipeline's behavior), the spec-source
doc comment is wrong. One of the two is a bug; the RFC 8594 `Deprecation`
header spec wants seconds, so the divide-by-1000 path at least matches
the wire format — but then `Sunset` (an HTTP date) gets the wrong instant.

**Impact.** Either every deprecation/sunset header is wrong by ~55 years,
or the spec-source type comment is misleading and any future caller that
trusts "epoch seconds" will mis-derive. Either way the consumer-facing
deprecation signal is unreliable.

**Fix.** Pick one unit at the source (epoch ms is the Zevium convention —
see wallet `settledAt: Date.now()`), fix `spec-source.ts`'s doc comments
to say ms, and make the pipeline consistent: `Deprecation` =
`@${Math.floor(ms / 1000)}`, `Sunset` = `new Date(ms).toUTCString()` (the
latter is already correct if the value is ms).

---

### [P2] `verified.scopes` extracted but never enforced — any valid key calls any operation

**Location:** `VerifiedKey.scopes` (key-verifier.ts lines 5–8) populated by
`parseClerkVerifyResponse`; pipeline never reads it.

**Problem.** The verifier dutifully parses `scopes` from Clerk's verify
response and threads them through `VerifiedKey`. The pipeline receives
`verified.scopes` and … never looks at it. There is no per-operation
scope check anywhere in the proxy path. Any valid API key — regardless of
its Clerk-issued scopes — can call any matched operation on any project
it can see (public, or private-owned).

If Zevium ever issues scoped keys (read-only, write-only, per-project,
admin vs. consumer), nothing in the gateway will honor them. The
`VerifiedKey.scopes` field is dead data on the hot path.

**Impact.** Future scoped keys are silently unenforced. A key minted for
read-only consumption can `POST` / `DELETE` against any operation the
spec exposes, as long as it is valid.

**Fix.** Either (a) delete `scopes` from `VerifiedKey` until a consumer
exists for it (no dead fields on the hot path), or (b) define an
`x-zevium-required-scopes` OpenAPI extension on operations and enforce
`verified.scopes ⊇ required` before `reserve`. Given the verifier already
collects scopes, (b) is the right call.

---

### [P2] Free-tier consume has no reservation idempotency — the pipeline is the missing caller

**Location:** `consumeFreeTier` call at lines 138–155; `WalletDO.consumeFreeTier`
(wallet.ts lines 605–641).

**Problem.** The pipeline calls `consumeFreeTier(verified.keyId, freeTier,
{ clerkOrgId, nowMs })` with no `reservationId`. Every other state-mutating
wallet RPC is idempotent by id (`reserve`, `settle`, `refund`, `grant`,
`enqueueFreeUsage`). `consumeFreeTier` is the exception: it does
`used + 1` unconditionally.

If the worker retries the request (network blip on the response path,
client retry that re-enters the pipeline, or any future alarm-driven
re-drive), the pipeline calls `consumeFreeTier` again with the same logical
request and burns a second free unit. The `reservationId = requestId` is
available right there (line 132) but is never passed to the free path.

The wallet review flagged this as a DO-side P2; this deep-dive confirms the
pipeline is the caller that fails to supply the dedupe key. It is a
pipeline-level fix, not a wallet-level one.

**Impact.** Free-tier quota silently under-delivers under any retry. Free
tier is the acquisition funnel; under-delivering it is a real business
cost and a poor first impression.

**Fix.** Thread `reservationId` through `consumeFreeTier` and dedupe on
`(keyId, reservationId, day)` — mirror the `#appliedGrantIds` / `#terminal`
pattern.

---

### [P2] Free-tier refund uses refund-time day key — UTC-midnight rollover bug (pipeline caller)

**Location:** lines 203, 320 (`wallet.refundFreeTier(verified.keyId, (deps.now ?? Date.now)())`).

**Problem.** The pipeline refunds free-tier units using the **refund**
timestamp: `(deps.now ?? Date.now)()`. If a free unit was consumed at
`23:59:59 UTC` and refunded at `00:00:01 UTC`, `refundFreeTier` decrements
the **new** day's counter — a day on which no unit was consumed for that
reservation. If the new day already has `used > 0` from other calls, the
refund steals a free call from the new day; if `used === 0` the
`used > 0` guard no-ops and the prior day's counter stays inflated.

The wallet review flagged the DO-side bug; this deep-dife confirms the
pipeline passes the wrong timestamp. `consumeFreeTier` is called with
`nowMs: (deps.now ?? Date.now)()` at consume time (line 140) — that value
should be captured once and passed to `refundFreeTier` on the failure
path, not recomputed.

**Impact.** Free-tier accounting drift across UTC midnight. A burst of
refunds straddling midnight grants spurious free calls on the new day or
fails to restore the prior day's quota.

**Fix.** Capture `const started = (deps.now ?? Date.now)();` is already
there (line 117) — pass `started` (or, better, the consume timestamp
returned by `consumeFreeTier`) to `refundFreeTier`:

```ts
await wallet.refundFreeTier(verified.keyId, started);
```

Even better, return the consume timestamp from `consumeFreeTier` and use
that exact instant.

---

### [P2] `upstreamUrl.search = incoming.search` drops the upstream base URL's own query string

**Location:** lines 188–190.

**Problem.** `joinUpstreamUrl` preserves `servers[0].url`'s pathname (it
even has a comment about path prefixes), but the pipeline then does:

```ts
upstreamUrl.search = incoming.search;
```

which **replaces** the URL's search entirely. If the publisher's
`servers[0].url` carries a query string
(`https://api.example.com/v1?client_id=zevium&format=json`), it is
silently dropped. The consumer's query string overwrites it.

OpenAPI `servers` commonly carry `server-variables` or query templating;
this clobber breaks any spec that relies on a base query param.

**Impact.** Silent breakage for any upstream that requires a base query
param (client_id, version, format). Hard to debug because the failure
manifests as upstream 4xx, not a gateway error.

**Fix.** Merge rather than replace:

```ts
const base = new URL(matched.upstreamBaseUrl);
for (const [k, v] of new URLSearchParams(incoming.search)) {
  base.searchParams.set(k, v);
}
upstreamUrl.search = base.search;
```

(Or compute the merged search on `upstreamUrl` directly via
`URLSearchParams`.)

---

### [P2] `refund` / `enqueueFreeUsage` failure paths not handled — silent credit/usage loss

**Location:** lines 309 (`await wallet.enqueueFreeUsage(...)`) and
line 322 (`await wallet.refund(...)`) in the non-free error branch.

**Problem.** On the free success path, `enqueueFreeUsage` can return
`{ status: "rejected", reason: "already refunded" }` if the reservation
was concurrently refunded — the pipeline ignores the return and emits
`outcome: "free"` usage. The free usage row is then never enqueued for
Convex flush; analytics lose a free call.

On the paid error path, `wallet.refund` can return `already_settled`
(concurrent settle) or `unknown` (reservation not in flight) — the
pipeline ignores it and emits `outcome: "refunded"` and returns 502.
If `refund` throws, the function rejects and no 502 is returned (the
client gets whatever the worker produces on uncaught rejection, typically
a 500 with no x-zevium-request-id).

Symmetric to the P1 on `settle` return values: every terminal wallet RPC
result is discarded, and the emitted `outcome` is whatever the pipeline
*intended*, not what the ledger *did*.

**Impact.** Silent analytics/usage loss on concurrent terminal transitions;
uncontrolled response shape when a wallet RPC throws.

**Fix.** Handle non-OK return statuses from `enqueueFreeUsage` and
`refund` the same way as `settle` (see P1 fix), and wrap the post-reserve
window in `try/finally` so a throw from any wallet RPC still produces a
deterministic `jsonError(...)` response with the request id.

---

### [P2] Spec cache serves stale visibility — private/deleted project accessible for up to 30s

**Location:** `CachedSpecSource` (spec-source.ts lines 47–85), 30s TTL.

**Problem.** `CachedSpecSource` caches the `PublishedSpec` (including
`visibility`) for 30s per isolate. If a project is flipped from `public`
to `private`, or unpublished entirely, the gateway still serves the
cached `PublishedSpec` for up to 30s in every isolate that has it cached.
During that window, a foreign key (or, for an unpublished project, any
authenticated key) passes the visibility check at lines 92–98 and proceeds
to proxy.

For deletion this also means a "deleted" project continues to proxy
upstream (whatever the upstream is) for 30s after the control plane
records the deletion — the gateway never re-validates against Convex per
request.

**Impact.** Up-to-30s window where revoked visibility / deleted projects
remain fully callable. Not catastrophic, but the metering/visibility
model is "realtime default" per the project rules; this is a bounded
staleness that should at least be documented at the enforcement point.

**Fix.** Either shorten the TTL for the gateway hot path (visibility is
cheap to recheck), or have the control plane publish a cache-invalidation
signal (a bumping `specVersion` the gateway checks against a short-TTL
manifest). At minimum, document the 30s visibility-staleness window in
the pipeline so operators know the bound.

---

### [P2] `servers[0].url` is the only upstream — no fallback, malformed silently 404s

**Location:** line 100 (`if (!matched.upstreamBaseUrl) return 404 no_upstream`)
+ `matchOperation` picks `spec.servers[0]?.url ?? ""`.

**Problem.** `matchOperation` reads only `servers[0].url`; everything
else in the OpenAPI `servers` array is ignored. If `servers[0]` is a
placeholder/dev URL and the real upstream is `servers[1]`, the gateway
silently uses the wrong one. If `servers[0].url` is empty/missing, the
pipeline 404s with `"no_upstream"` — operationally indistinguishable
from a missing route for the consumer, hiding a publisher misconfiguration.

This is a design nit masquerading as correctness: OpenAPI clients are
expected to pick a server, but a metering gateway should not silently pick
the first one if the spec author intends round-robin or environment-based
selection.

**Impact.** Wrong-upstream proxying on any spec that lists multiple
servers; opaque 404 on a publisher misconfiguration that should be a 500
(or a control-plane validation error at publish time).

**Fix.** Validate at publish time that `servers` has exactly one entry
(or designate the canonical one via an `x-zevium-upstream` extension), and
surface a 500 `"upstream_misconfigured"` rather than 404 when the gateway
can't find a base URL at runtime.

---

### [P3] `now()` sampled 6+ times per request — clock drift across latency calculations

**Location:** lines 117, 140, 160, 179, 199, 209, 213, 233, 316.

**Problem.** Each `(deps.now ?? Date.now)()` call is a fresh sample.
`latencyMs` is computed once (line 209) and reused — good — but the
free-tier consume (line 140) and refund (lines 203, 320) use different
samples, which is the direct cause of the UTC-midnight bug (P2 above) and
can produce negative `latencyMs` for very fast requests if `now` is ever
mocked non-monotonically.

**Impact.** Minor clock inconsistency; the midnight-rollover consequence
is tracked separately.

**Fix.** Capture `const now = deps.now ?? Date.now;` once and call
`now()` everywhere — or capture `const started = now();` and derive
`latencyMs = now() - started` only at emit time.

---

### [P3] No `Via` header added — proxy is not RFC-marked

**Location:** response header block, lines 368–394.

**Problem.** HTTP proxies should add a `Via` header per RFC 7230 §5.7.1.
The gateway adds `x-zevium-*` headers but no `Via`. Upstreams that check
`Via` for loop detection (or audit) see no proxy hop.

**Impact.** Cosmetic / RFC compliance; no security impact, but `cdn-loop`
is already in the hop-by-hop strip set, implying loop detection is a
concern — incomplete without adding `Via` on the way out.

**Fix.** `outHeaders.append("Via", "1.1 zevium-gateway");`

---

### [P3] Timing side-channel: private-existing vs non-existent project distinguishable

**Location:** lines 79–98.

**Problem.** A truly non-existent project returns 404 at `specSource`
(line 79). A private project called by a foreign key returns 404 at the
visibility check (line 96) — **after** the spec was loaded, parsed,
matched, and the wallet DO was constructed (`env.WALLET.idFromName` is
lazy but the lookup is real work). The two 404s have measurably different
latency profiles.

An attacker probing project names can distinguish "does not exist" from
"exists but private" by timing, partially defeating the "never leak that a
private project exists" goal stated in the comment at line 90.

**Impact.** Mild information disclosure; the existence of a private
project is observable by a determined attacker with many samples.

**Fix.** Either route both 404 cases through the same minimal work
(always do a fixed-cost dummy spec lookup), or accept the leak and remove
the "never leak" claim from the comment.

---

### [P3] Free-tier counter is shared across operations with different `freeTier` limits

**Location:** `consumeFreeTier(keyId, freeTier, …)` at line 141; per-(key,day) counter in wallet.

**Problem.** The free-tier counter is keyed `(keyId, utcDay)` only — not
per-operation. If a spec has op A with `x-zevium-free-tier: 5` and op B
with `x-zevium-free-tier: 10`, the counter is shared. After 5 A-calls,
`used=5`; op A is `exhausted` (`used >= 5`), op B is not (`used >= 10`
false) and consumes to `used=6`. After 10 total calls both are exhausted.
So the effective per-key daily free quota is `max(freeTier)` across all
ops, not the per-op limit. Whether that is intended is unclear from the
code; it is at least surprising.

**Impact.** A key can exhaust op A's free quota by calling op B (or
vice versa). Probably acceptable, but undocumented.

**Fix.** Either key the counter per `(keyId, operationId, day)` if per-op
quotas are intended, or document that the daily free quota is the max
across operations and shared.

---

### [P3] `x-api-key` is trimmed but `Authorization: Bearer` token is not

**Location:** `extractApiKey` (key-verifier.ts lines ~210–230).

**Problem.** `x-api-key` is `.trim()`'d before validation; the bearer
token captured by `/^Bearer\s+(\S+)/i` is not. A key with trailing
whitespace in the `Authorization` header fails `isApiKeySecret` and is
rejected; the same key in `x-api-key` works. Inconsistent leniency.

**Impact.** Minor interop annoyance; clients that pad the bearer token
fail mysteriously.

**Fix.** Trim both, or trim neither. Trimming both is the friendlier
choice.

---

### [P3] Invalid / missing API key returns 402, not 401

**Location:** lines 119, 126 (`paymentRequiredResponse`).

**Problem.** Missing and invalid API keys both return 402
`payment_required` with `www-authenticate: Bearer`. Semantically, 401 is
"authentication required / failed" and 402 is "payment required". The x402
design intentionally unifies these into a single self-service envelope
(agents are told how to create a key), which is a reasonable product
choice — but it conflates "you have no credentials" with "you have no
money", and any standard HTTP client will mis-categorize.

**Impact.** Minor spec-semantics issue; monitoring/alerting that keys on
401 vs 402 will mis-count auth failures as billing failures.

**Fix.** Acceptable as-is if the x402 unified envelope is the product
decision; if not, return 401 for missing/invalid key and 402 only for
insufficient credits. At minimum, document the conflation.

---

## Summary

**Counts:** P0: 0 · P1: 7 · P2: 9 · P3: 6 — **22 findings total.**

The prior pass found 4 P2 + 4 P3; this deep-dive expands to 7 P1 + 9 P2 +
6 P3, with the new P1s concentrated in the two areas the ticket named
explicitly: **credit-gate integrity** (settle result discarded, in-flight
reaper missing, upstream fetch unbounded) and **header/proxy hygiene**
(cookie/set-cookie passthrough, x-forwarded-* spoofing, SSRF, error leak).

**Top 3 to fix before any production traffic:**

1. **P1 — `settle`/`refund` return values discarded + no in-flight reaper +
   no upstream timeout.** Together these mean any worker eviction, DO
   transient, or hung upstream permanently pins consumer credits with no
   cleanup, no observability, and no refund. This is the credit-gate
   bypass-by-attrition the ticket is hunting for.
2. **P1 — header hygiene in both directions.** Strip `cookie` /
   `set-cookie`, strip and re-derive `x-forwarded-*`, and add `Via`. The
   cookie passthrough is a session-fixation vector against publisher
   upstreams and a tracking-cookie injection on the gateway origin; the
   XFF passthrough is consumer-controllable client-IP spoofing.
3. **P1 — SSRF + error leakage on the upstream URL.** Validate
   `servers[0].url` against private/loopback/link-local ranges, and
   return a fixed human-safe 502 message instead of the raw `fetch` error.
   Together these close the "publisher drives the worker to internal
   endpoints and reads the error" scanner.
