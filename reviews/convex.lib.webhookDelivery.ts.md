# Tiger-Style Review — `convex/lib/webhookDelivery.ts`

This file is the entire outbound delivery surface: it builds the JSON body,
signs it with HMAC-SHA256, and POSTs it to a **publisher-controlled** URL from
inside the Convex server runtime. The signing primitive itself
(WebCrypto HMAC-SHA256) is correct; everything around it — the destination
URL, the redirect chain, the response status, the transport error, the
attempt counter, the caller's transaction, the scheduler's at-least-once
semantics — is treated as trusted when none of it is.

Cross-file reach: `postWebhook` is invoked by `convex/webhooks.ts:315`
(`deliverWebhook` internal action), which is scheduled by
`fireWebhookEvent` (`webhooks.ts:60`) and re-scheduled by
`recordDeliveryAttempt` (`webhooks.ts:244`). Several findings below live in
that caller/state-machine because the helper's contract makes them
unavoidable. Every line below is a problem.

---

## Verdict

**Incorrect and unsafe to ship as-is.** Two independent SSRF vectors (one
reaches cloud metadata over HTTP via redirect-following, one accepts any
`https://` URL including private IPs, loopback, link-local, CGNAT, and
DNS-rebinding targets), an at-least-once delivery channel with no
idempotency key AND no try/catch around the action body (so a scheduler
retry re-POSTs the same body), a retry state machine that burns 3 attempts
+ a false `webhook_failed` notification for an endpoint that was never
even contacted (inactive), retries permanent 4xx as if transient, leaks
raw transport error strings into the publisher-visible notification body,
ships no payload size limit, no jitter, no secret-rotation path, and
signs a re-stringified body that is not the bytes stored in
`webhookDeliveries.payload`.

---

## File Stats

- File: `convex/lib/webhookDelivery.ts` (85 lines)
- Exports: `PostWebhookParams`, `PostWebhookResult`, `WEBHOOK_TIMEOUT_MS`,
  `computeSignature`, `postWebhook`
- Callers: `convex/webhooks.ts:315` (`deliverWebhook` action); tests in
  `convex/webhooks.test.ts`
- Findings: 22 — P0: 1, P1: 6, P2: 8, P3: 7

---

## Findings

### [SEV: P0] Redirect-following SSRF reaches cloud metadata and drops the body

**Location:** `convex/lib/webhookDelivery.ts:62-71`

```ts
const response = await fetchImpl(params.url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-zevium-event": params.event,
    "x-zevium-signature": signature,
  },
  body,
  signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
});
```

**Problem:** No `redirect` option is passed, so the fetch uses the default
`redirect: "follow"` (undici/edge-runtime behavior). The publisher's
endpoint is attacker-controlled. A publisher registers a legitimate
`https://` URL (passes `validateWebhookUrl`) whose server responds
`302 Location: http://169.254.169.254/latest/meta-data/iam/security-credentials/`
(or any private/internal HTTP target, including
`http://metadata.google.internal/computeMetadata/v1/`). Convex's fetch
follows the cross-protocol (https→http) redirect server-side and reads the
cloud-metadata response. The `https:`-only guard in `validateWebhookUrl`
is fully bypassed because the *initial* URL is https; the *final* URL is
whatever the publisher redirects to. The signed body and signature are
sent to the redirect target on `307`/`308`.

Separately, for `301`/`302`/`303` fetch rewrites the method POST→GET and
**drops the request body and signature**. The publisher's redirect target
receives a `GET` with no payload, the response comes back `200`, and
`postWebhook` returns `ok: true`. The webhook is recorded as successfully
delivered even though the endpoint never received the body. Silent data
loss that cannot be detected from the delivery log.

**Impact:** Cloud-instance credential theft from the Convex runtime (or
any internal HTTP service reachable from it); impersonation of Zevium's
server toward internal services. The redirect-then-body-drop path is a
delivery correctness bug that hides as success.

**Fix:** Do not follow redirects. Either reject them outright
(`redirect: "error"`) or handle `redirect: "manual"` and re-validate each
`Location` against the same blocklist used for the initial URL before
following — and never follow a redirect that downgrades scheme or crosses
into a private range. For an idempotent delivery channel,
`redirect: "error"` is the only safe default.

---

### [SEV: P1] Direct SSRF: no internal-IP / metadata blocklist at the fetch site

**Location:** `convex/lib/webhookDelivery.ts:62` (and the upstream guard
`convex/webhooks.ts:32-43`)

```ts
// webhooks.ts — the only guard, applied once at upsert time:
if (parsed.protocol === "https:") return true;
if (parsed.protocol === "http:" && parsed.hostname === "localhost") return true;
// webhookDelivery.ts — passes params.url straight to fetch with zero checks:
const response = await fetchImpl(params.url, { ... });
```

**Problem:** `postWebhook` passes `params.url` straight to `fetchImpl` with
zero validation. The only guard is `validateWebhookUrl`, applied once at
`upsertEndpoint` time. `if (parsed.protocol === "https:") return true;`
accepts **any** https URL — `https://10.0.0.1/`,
`https://192.168.1.1/`, `https://[::1]/`,
`https://metadata.google.internal/computeMetadata/`, and any hostname that
resolves to a private IP (DNS-rebinding). The `http://localhost` exception
is wider than dev needs: it reaches **every** loopback service on every
port of the Convex runtime, not just a dev callback. There is no blocklist
for `169.254.0.0/16` (link-local + cloud metadata), `127.0.0.0/8`,
`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` (CGNAT),
`0.0.0.0`, or IPv6 `::1`/`fc00::/7`. IP-literal forms, decimal/octal/hex
encodings (`https://0x7f.0.0.1/`), and DNS-rebinding are all unmitigated.
The validation also runs only at upsert; nothing prevents a URL whose DNS
later resolves to a private IP at delivery time.

**Impact:** Publisher triggers Zevium-server-side requests to internal
HTTPS services and loopback-only admin surfaces; reconnaissance of the
internal network from a multi-tenant vantage point. (Direct
`http://169.254.169.254` is blocked by the https-only rule, but is
reachable via the redirect vector above — the two findings compose.)

**Fix:** Resolve the URL hostname and reject private/loopback/link-local/
CGNAT/metadata ranges *at fetch time in `postWebhook`*, not only at upsert
time — defense in depth. Block `http://localhost` outside an explicit dev
flag. Use `redirect: "manual"` so a re-resolution runs on each hop.

---

### [SEV: P1] `deliverWebhook` action body is unguarded — scheduler retries re-POST the webhook

**Location:** `convex/webhooks.ts:292-330` (the action that calls
`postWebhook`), `convex/lib/webhookDelivery.ts:53-83`

```ts
// webhooks.ts deliverWebhook — no try/catch around the body:
const info = await ctx.runQuery(internal.webhooks.getDeliveryForAction, {...});
if (info === null) return;
if (!info.active) { /* record + return */ }
const parsed = JSON.parse(info.payload) as {...};          // can throw
const result = await postWebhook({...});                    // never throws (internal try)
await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, {...}); // can throw
```

**Problem:** `postWebhook` itself catches internally and never throws, but
`deliverWebhook`'s body has no try/catch around `JSON.parse(info.payload)`,
`ctx.runQuery`, or `ctx.runMutation`. If any of those throw, the Convex
scheduler treats the action as failed and **re-runs it**, with its own
backoff and retry budget that is independent of `MAX_WEBHOOK_ATTEMPTS`.
The re-run re-executes `postWebhook` — a second HTTP POST of the same
signed body to the endpoint. Because there is no idempotency key (see
next finding) and no "already attempted" guard on the delivery row, the
receiver cannot tell the scheduler-retry from a genuine retry and applies
side effects twice. The `attempts` counter in `recordDeliveryAttempt` is
never incremented for the first run (it threw before reaching there), so
the state machine is unaware a delivery already happened.

**Impact:** Unbounded (scheduler-controlled) duplicate HTTP deliveries for
any delivery whose `recordDeliveryAttempt` mutation throws — DB contention,
transient Convex unavailability, or a thrown `createNotification` on the
final-attempt path all trigger it. Duplicate side effects at receivers.

**Fix:** Wrap the action body so that *once `postWebhook` has been called*,
any subsequent failure is recorded via `recordDeliveryAttempt` rather than
left to the scheduler. Better: make `deliverWebhook` idempotent by
checking `delivery.status` / `delivery.attempts` in
`getDeliveryForAction` and skipping the POST if the delivery is already
`ok` or has already exhausted attempts. Record the attempt *before* the
POST or use a CAS patch (`patch if attempts === expected`) so concurrent
runs dedupe.

---

### [SEV: P1] No idempotency key or delivery ID on an at-least-once channel

**Location:** `convex/lib/webhookDelivery.ts:64-71` (headers)

```ts
headers: {
  "Content-Type": "application/json",
  "x-zevium-event": params.event,
  "x-zevium-signature": signature,
},
```

**Problem:** Convex's scheduler is at-least-once: the same `deliverWebhook`
action can run twice for one `deliveryId` (scheduler retry after a
transient action failure — see previous finding), and
`recordDeliveryAttempt` schedules up to 3 attempts per delivery. All
attempts carry the **same** `timestamp` (read back from the stored
payload), so a consumer cannot distinguish a genuine retry from a
scheduler duplicate, and has no stable delivery identifier to dedupe on.
There is no `x-zevium-delivery-id` header, no `x-zevium-attempt` header,
and no `Idempotency-Key` header. Consumers who apply side effects on
receipt (the whole point of a webhook) will apply them N times. The
signature scheme cannot help the consumer dedupe because every retry
signs an identical body.

**Impact:** Duplicate side effects at receivers (double provisioning,
double cache invalidation, double deprecation handling).

**Fix:** Add `x-zevium-delivery-id: <deliveryId>`,
`x-zevium-attempt: <n>`, and `Idempotency-Key: <deliveryId>` headers.
Document that consumers MUST dedupe on `x-zevium-delivery-id`. Pass the
attempt number through from `recordDeliveryAttempt` → `deliverWebhook`
→ `postWebhook`.

---

### [SEV: P1] All non-2xx retried, including permanent 4xx client failures

**Location:** `convex/lib/webhookDelivery.ts:73-80`,
`convex/webhooks.ts:244-263`

```ts
if (response.status >= 200 && response.status < 300) {
  return { ok: true, status: response.status };
}
return { ok: false, status: response.status, error: `HTTP ${response.status}` };
```

**Problem:** Every non-2xx status — including `410 Gone`, `404 Not Found`,
`401 Unauthorized`, `403 Forbidden`, `451` — is returned as `ok: false`,
which `recordDeliveryAttempt` treats as retryable. The endpoint is hit 3
times (initial + 60s + 300s), and on the third failure a `webhook_failed`
notification is fired to the publisher org. A permanently-gone endpoint
generates two pointless retries and a false alarm. Only `5xx`, `408`, and
`429` are meaningfully transient; `4xx` (except `408`/`429`) is a
contract/configuration error that retrying cannot fix. Worse, `429` is
retried with a fixed 60s/300s backoff that ignores the server's
`Retry-After` header.

**Impact:** Wasted outbound requests, endpoint spam for misconfigured
publishers, false `webhook_failed` notifications that erode trust in the
notification channel, `Retry-After` violations.

**Fix:** Return a `retryable` flag (or split the result type) from
`postWebhook` based on status: retry only `5xx`, `408`, `429`, and
transport failures; treat other `4xx` as terminal-failure with no retry.
Honor `Retry-After` on `429`/`503`. Have `recordDeliveryAttempt` honor
that flag instead of always scheduling a retry.

---

### [SEV: P1] Raw transport error messages leaked into publisher notification body

**Location:** `convex/lib/webhookDelivery.ts:81-83` →
`convex/webhooks.ts:252, 268, 282`

```ts
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, status: 0, error: message };
}
// webhooks.ts — flowed unmodified into:
body: `Delivery of "${delivery.event}" failed after ${MAX_WEBHOOK_ATTEMPTS} attempts${args.error !== undefined ? `: ${args.error}` : ""}.`
```

**Problem:** The raw `err.message` from `fetch` is returned verbatim as
`error`. That string flows unmodified into `delivery.lastError`
(`webhooks.ts:252` and `:268`) and into the `webhook_failed` notification
body (`webhooks.ts:282`), surfaced to every member of the publisher's
Clerk org via the notifications feed. Node/undici fetch error messages
routinely embed internal hostnames, IPs, and ports: `connect ECONNREFUSED
10.0.5.23:443`, `getaddrinfo ENOTFOUND internal-admin.zevium.svc`,
`certificate has expired for internal-api.local`,
`network error for https://10.0.0.5:8080/hook`, etc. There is no length
cap, no allowlist of safe substrings, and no sanitization. A long stack
trace, a redirect-chain URL, or a TLS chain dump could be persisted into
the `notifications.body` column indefinitely. The `lastError` column is
also returned to clients via `listDeliveries`.

**Impact:** Internal network topology / hostname / IP disclosure to
publisher org members (who may be untrusted relative to Zevium infra).
Persistence of arbitrary-length error strings in the DB.

**Fix:** Map transport errors to a small fixed vocabulary before returning
(`"timeout"`, `"connection_refused"`, `"dns_failure"`, `"tls_error"`,
`"network_error"`) and discard the original message. Cap `error` length
at ~200 chars. Never pass `err.message` through to user-visible surfaces.

---

### [SEV: P1] Inactive endpoint burns 3 retries + fires a false `webhook_failed` notification

**Location:** `convex/webhooks.ts:309-313`

```ts
if (!info.active) {
  await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, {
    deliveryId: args.deliveryId,
    ok: false,
    error: "Endpoint inactive",
  });
  return;
}
```

**Problem:** When a publisher sets `active: false` (revokes the endpoint)
via `upsertEndpoint`, any already-scheduled `deliverWebhook` for that
endpoint short-circuits here. So far so good — no HTTP POST is made (the
"revoked endpoint still receiving" concern is therefore **verified
clean** at the network layer). But the short-circuit still calls
`recordDeliveryAttempt({ok: false, error: "Endpoint inactive"})`, which
the state machine treats identically to a transport failure: it
increments `attempts`, schedules another retry at 60s, then 300s, and on
the third pass fires a `webhook_failed` notification to the publisher
org. So revoking an endpoint generates **3 scheduler invocations and a
spurious "Webhook delivery failed: Endpoint inactive" notification** for
every in-flight delivery — even though the publisher themselves revoked
it. The publisher gets alarm noise for their own configuration change.

**Impact:** Scheduler load, false alarms, notification-channel noise
directly caused by the publisher's own action. Erodes trust in
`webhook_failed` as a signal.

**Fix:** Treat `!info.active` as terminal: mark the delivery
`status: "failed"` (or a new `status: "cancelled"`) with `attempts`
unchanged, schedule no retry, and fire no notification. Distinguish
"never tried" from "tried and failed" in the delivery log.

---

### [SEV: P2] `fireWebhookEvent` couples webhook insert + `JSON.stringify` to the caller's transaction

**Location:** `convex/webhooks.ts:60-86`

```ts
const payload = JSON.stringify({ event, data, timestamp });
const deliveryId = await ctx.db.insert("webhookDeliveries", { ..., payload });
await ctx.scheduler.runAfter(0, internal.webhooks.deliverWebhook, { deliveryId });
```

**Problem:** `fireWebhookEvent` runs inside the caller's mutation
(`specs.publish`, `specs.deprecateVersion`, `admin.setProjectVisibility`).
Two failure modes abort the parent business operation:

1. `JSON.stringify({event, data, timestamp})` throws if `data` contains a
   `BigInt`, a circular reference, a `Symbol`-keyed value, or a `.toJSON()`
   that throws. The throw propagates out of `specs.publish` and the
   entire spec publish is rolled back.
2. `ctx.db.insert("webhookDeliveries", {payload})` throws if the
   serialized payload exceeds Convex's ~1 MB document limit (see
   payload-size finding below), or on any DB transient. Same rollback —
   the publish fails because of a webhook.

The webhook subsystem is not isolated from the business operation it
happens to be notifying. There is also no try/catch and no fallback
("best-effort" semantics) — the caller cannot opt out of "publish fails if
webhook insert fails."

**Impact:** A future spec payload shape that includes a non-JSON-safe
value, or an oversized payload, breaks `specs.publish` /
`admin.setProjectVisibility` rather than just the webhook.

**Fix:** Wrap the `fireWebhookEvent` body in try/catch that logs and
swallows on failure (webhooks are best-effort notifications, not
transactional side effects). Validate `data` is JSON-safe and
under-size *before* stringifying. Consider moving the delivery insert
out of the caller's transaction via a separate scheduled mutation.

---

### [SEV: P2] No payload size limit on `data` or stored `payload`

**Location:** `convex/lib/webhookDelivery.ts:53-57`, `convex/webhooks.ts:78`

```ts
const body = JSON.stringify({ event: params.event, data: params.data, timestamp: params.timestamp });
// and at fire time:
const payload = JSON.stringify({ event, data, timestamp });
```

**Problem:** `params.data` is `unknown` (type at L11) and is stringified
with no bound. The same unbounded string is stored as
`webhookDeliveries.payload` in `fireWebhookEvent` (`webhooks.ts:78`).
Convex caps document size near 1 MB; a large `data` object will fail the DB
insert (aborting the parent publish — see previous finding) OR succeed at
insert time and then produce an outbound body that exceeds reasonable
receiver limits. There is no explicit enforcement anywhere in the
pipeline. The signature is computed over the full unbounded body.

**Impact:** DB write failures on large events (which present as
`specs.publish` failures), or oversized deliveries that some receivers
will reject (and then retry-storm per the 4xx-retry finding).

**Fix:** Enforce a maximum serialized body size (e.g. 64 KB) in
`postWebhook` before signing, and at `fireWebhookEvent` before insert.
Reject oversized events with a clear error rather than letting them fall
through to a size-limit failure deep in the pipeline.

---

### [SEV: P2] `attempts` counter is read-modify-write — concurrent runs amplify retries

**Location:** `convex/webhooks.ts:246-272`

```ts
const delivery = await ctx.db.get(args.deliveryId);
const nextAttempts = delivery.attempts + 1;
if (nextAttempts < MAX_WEBHOOK_ATTEMPTS) {
  await ctx.db.patch(args.deliveryId, { attempts: nextAttempts, lastError: args.error });
  await ctx.scheduler.runAfter(backoffSec * 1000, internal.webhooks.deliverWebhook, { deliveryId });
}
```

**Problem:** `recordDeliveryAttempt` reads `attempts`, increments in JS,
and patches back. Convex serializes mutations, so two concurrent calls
don't corrupt the counter, but they both still schedule a retry. If two
`deliverWebhook` actions run concurrently for the same `deliveryId`
(scheduler duplicate — see the unguarded-action finding), each calls
`recordDeliveryAttempt` with `ok:false`; the first patches `0→1` and
schedules a retry at +60s, the second patches `1→2` and schedules a retry
at +300s. The delivery now has **two** outstanding scheduled retries
instead of one, and the next incoming retry will find `attempts=2` and
schedule a third at +300s. The state machine has no concept of "a retry
is already scheduled" — every failure schedules another. With scheduler
duplicates this can fan out beyond the intended 3 deliveries. There is no
conditional patch (`patch where attempts === expected`) to detect a
concurrent run and bail out.

**Impact:** Retry amplification beyond `MAX_WEBHOOK_ATTEMPTS` under
duplicate scheduler invocations; extra endpoint traffic; potential for
the same delivery to be marked `ok` and `failed` by racing branches.

**Fix:** Use a conditional patch that only updates if `attempts` equals
the value read by *this* call (CAS). Before scheduling a retry, check
whether one is already scheduled (or use a `nextAttemptScheduledAt`
field). Better: dedupe at the `deliverWebhook` action level by skipping
the POST if `delivery.status !== "pending"` or `delivery.attempts` has
already advanced past what this run expects.

---

### [SEV: P2] No jitter + unbounded scheduler-retry on action throw → thundering herd

**Location:** `convex/webhooks.ts:22-24` (`WEBHOOK_BACKOFF_SECONDS = [60, 300]`),
`convex/webhooks.ts:258-263`

```ts
export const WEBHOOK_BACKOFF_SECONDS = [60, 300] as const;
// ...
const backoffSec = WEBHOOK_BACKOFF_SECONDS[backoffIndex] ?? 300;
await ctx.scheduler.runAfter(backoffSec * 1000, internal.webhooks.deliverWebhook, { deliveryId });
```

**Problem:** The backoff is a fixed `[60, 300]` schedule with no jitter.
If a publisher's endpoint goes down during a burst of `spec.published`
events (a plausible failure mode), every delivery for that endpoint
fails simultaneously, retries at exactly +60s, then exactly +300s — a
synchronized thundering herd hitting the recovering endpoint. Worse,
when `deliverWebhook` *throws* (JSON.parse, runMutation throw — see
unguarded-action finding), it is the **Convex scheduler** that retries,
with its own backoff that is independent of `MAX_WEBHOOK_ATTEMPTS` and
not visible in the delivery log. The application-level 3-attempt cap
only governs `recordDeliveryAttempt`-driven retries, not
scheduler-driven retries of the action itself. So the effective retry
budget is "3 + N" where N is the scheduler's own retry policy.

**Impact:** Synchronized retry storms against recovering endpoints;
retry budget that is not actually bounded by `MAX_WEBHOOK_ATTEMPTS` when
the action body throws.

**Fix:** Add jitter (`backoffSec + random(0, 30)`) to decorrelate
retries. Ensure `deliverWebhook` never throws to the scheduler by
catching everything and routing through `recordDeliveryAttempt` — then
the application-level cap is the true cap.

---

### [SEV: P2] `deleteEndpoint` orphans deliveries and leaves scheduled retries dangling

**Location:** `convex/webhooks.ts:151-162`

```ts
export const deleteEndpoint = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<{ deleted: boolean }> => {
    // ...
    await ctx.db.delete(existing._id);
    return { deleted: true };
  },
});
```

**Problem:** Deleting an endpoint does not (a) cancel any already-scheduled
`deliverWebhook` actions for that endpoint's deliveries, (b) delete or
mark the `webhookDeliveries` rows, or (c) mark them `failed`. The
schema (`convex/schema.ts:144-152`) has `endpointId: v.id("webhookEndpoints")`
with no cascade — deleting the endpoint leaves orphaned delivery rows
referencing a now-nonexistent `endpointId`. Scheduled retries will fire,
`getDeliveryForAction` returns `null` (endpoint gone), and `deliverWebhook`
silently exits without recording — so the delivery rows stay `pending`
with `attempts: 0`/`1`/`2` forever in the log. `listDeliveries`
(`webhooks.ts:165-188`) queries by `endpointId` — once the endpoint is
deleted there's no way back in to even see them, but the rows persist in
the DB.

**Impact:** Orphaned rows accumulating in `webhookDeliveries`; scheduled
actions firing against deleted endpoints (no-op but consumes scheduler
slots); no clean terminal state for in-flight deliveries on deletion.

**Fix:** On `deleteEndpoint`, mark all `pending` deliveries `failed`
with `lastError: "endpoint deleted"`, cancel scheduled retries (or
render them no-ops via a `deletedAt` tombstone check in
`getDeliveryForAction`), and either cascade-delete the delivery rows or
retain them with a terminal status.

---

### [SEV: P2] Signature carries no version prefix — cannot rotate algorithm

**Location:** `convex/lib/webhookDelivery.ts:40-42, 67`

```ts
return Array.from(new Uint8Array(sig))
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");
// ...
"x-zevium-signature": signature,
```

**Problem:** The signature header is a bare hex digest:
`x-zevium-signature: <64 hex chars>`. There is no `v1=` prefix and no
algorithm identifier. Once consumers are taught to verify this format,
Zevium can never migrate off HMAC-SHA256 (e.g. to HMAC-SHA-384 or a
keyed blake3) without breaking every receiver simultaneously. Stripe
(`t=...,v1=...`), Svix (`v1,sha256=...`), and GitHub all version their
signatures for exactly this reason. The `x-zevium-event` header is also
not covered by the signature (it duplicates `body.event`, so this is
not exploitable today, but a future header-only field would be unsigned
by construction).

**Impact:** Permanent lock-in to HMAC-SHA256; no migration path; no
forward-compatible verification protocol.

**Fix:** Emit `x-zevium-signature: v1=<hex>` and document the scheme.
Reserve `v2=` for a future algorithm. Consider including a `t=<ts>`
segment in the signed string so consumers can enforce a replay window
without parsing the body (see next finding).

---

### [SEV: P2] Timestamp exists only in the body — consumers must parse before replay-checking

**Location:** `convex/lib/webhookDelivery.ts:53-57, 64-68`

**Problem:** The replay-window timestamp lives inside the JSON body
(`timestamp` field). To reject a replayed delivery, a consumer must
first read the body, parse JSON, and extract `timestamp` — only then can
they decide whether the delivery is fresh. Standard webhook schemes
(Stripe, Svix) ship the timestamp as a header (`t=<unix>` or
`webhook-timestamp`) so consumers can reject stale deliveries *before*
verifying the signature or touching the body. The current scheme also
provides no nonce/message-id, so a captured-and-replayed body (same
timestamp, same signature) cannot be detected as a replay at all without
consumer-side state.

**Impact:** Receivers cannot cheaply reject replays; the signature alone
authenticates the bytes but not the freshness of any particular
delivery.

**Fix:** Add `x-zevium-timestamp: <unix-ms>` header and sign
`"${timestamp}.${body}"` (Stripe-style) so the header timestamp is
cryptographically bound to the body. Recommend consumers reject
deliveries whose timestamp is more than ~5 minutes off their wall clock.

---

### [SEV: P2] Signed body is a re-stringification, not the stored `payload`

**Location:** `convex/lib/webhookDelivery.ts:53-57`, caller
`convex/webhooks.ts:307-319`

```ts
// deliverWebhook:
const parsed = JSON.parse(info.payload) as { event, data, timestamp };
const result = await postWebhook({ ..., event: parsed.event,
  data: parsed.data, timestamp: parsed.timestamp });
// postWebhook:
const body = JSON.stringify({ event: params.event, data: params.data,
  timestamp: params.timestamp });
```

**Problem:** `fireWebhookEvent` stores `payload = JSON.stringify({event,
data, timestamp})` in the DB. `deliverWebhook` then `JSON.parse`s it back
and passes the parts to `postWebhook`, which **re-stringifies** them. The
bytes that get signed and sent are the re-stringified bytes, not the
stored `payload` bytes. Today V8 preserves insertion order across
`parse`→`stringify`, so the two coincide — but this is a load-bearing
coincidence, not a guarantee. If `data` ever contains non-JSON-safe
values, `BigInt`, `undefined`-bearing objects, or a future code path
mutates `data` between parse and stringify, the signed body diverges from
the persisted payload. Any future verification API that re-verified
`delivery.payload` against the recorded signature would silently fail. It
also doubles the serialization cost per delivery.

**Impact:** Latent signature/payload divergence; no verifiable trail from
stored payload → delivered body → signature today, and a fragile invariant
for any future change to the body shape.

**Fix:** Pass the stored `payload` string through to `postWebhook` as the
body to sign and send (e.g. `postWebhook({ body: info.payload, secret,
event })`), or have `postWebhook` accept a pre-serialized body. Sign
exactly the bytes that are transmitted and stored.

---

### [SEV: P2] No secret-rotation path; secret returned on every read by any project member

**Location:** `convex/webhooks.ts:96-138` (`upsertEndpoint`),
`convex/webhooks.ts:139-148` (`getEndpoint`)

**Problem:** `upsertEndpoint` generates the secret only on the *create*
branch (`webhooks.ts:119`); the update branch preserves the existing
secret and offers no rotation. There is no `rotateSecret` mutation. A
publisher whose secret has leaked (e.g. committed to a repo, exfiltrated
by a departed member) has no way to rotate it short of deleting the
endpoint — which orphans all delivery history (see orphan finding above)
and changes the `endpointId` every receiver-side audit log keys on.
Separately, `getEndpoint` (`webhooks.ts:139-148`) and `upsertEndpoint`
both return the full `Doc<"webhookEndpoints">` including `secret` on
every call. `requireProjectMember` is the only gate, so any project
member (including `org:member`, not just `org:admin`) can read the
signing secret at any time, indefinitely.

**Impact:** No recovery path from a compromised secret; broad read
access to a credential that ought to be write-only-after-create.

**Fix:** Add a `rotateSecret` mutation that patches `secret:
generateSecret()` and returns the new secret once. Stop returning
`secret` from `getEndpoint` (or gate it behind an explicit
`includeSecret` flag with admin role). Document that the secret is
shown once at create/rotate time.

---

### [SEV: P3] `fetchImpl: typeof fetch = fetch` captures global at module-eval

**Location:** `convex/lib/webhookDelivery.ts:53`

```ts
fetchImpl: typeof fetch = fetch,
```

**Problem:** The default `fetch` is bound at module evaluation time. If
the runtime swaps `globalThis.fetch` later (instrumentation, fetch shim
upgrade, test harness), this module keeps the stale reference. Low
impact in production today; mostly a footgun for test harnesses that
replace `globalThis.fetch` after import.

**Impact:** Stale fetch reference; minor test/debug fragility.

**Fix:** Default to `() => fetch(...)` or resolve `fetch` lazily inside
the function body (`const f = fetchImpl ?? globalThis.fetch;`).

---

### [SEV: P3] `computeSignature` allocates per byte for hex encoding

**Location:** `convex/lib/webhookDelivery.ts:40-42`

```ts
return Array.from(new Uint8Array(sig))
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");
```

**Problem:** Builds a 32-element boxed-number array, then 32 intermediate
strings, then joins — per delivery. The canonical pattern
(`Array.from(uint8, b => b.toString(16).padStart(2,"0"))` on the
`Uint8Array` directly, or a precomputed 256-entry lookup table) avoids the
`Array.from` boxing. Cosmetic.

**Impact:** Minor GC pressure in a hot path; no correctness issue.

**Fix:** Iterate the `Uint8Array` directly, or use a 256-entry hex table.

---

### [SEV: P3] No `User-Agent` / `Accept` headers

**Location:** `convex/lib/webhookDelivery.ts:64-68`

```ts
headers: {
  "Content-Type": "application/json",
  "x-zevium-event": params.event,
  "x-zevium-signature": signature,
},
```

**Problem:** No `User-Agent` and no `Accept` header. Some WAFs, CDNs, and
API gateways reject or challenge requests with no `User-Agent`; receivers
have no way to identify Zevium traffic in their access logs.
`Accept: application/json` would let content-negotiating servers respond
correctly.

**Impact:** Spurious failures / poor observability at receivers.

**Fix:** Set a stable `User-Agent: Zevium-Webhook/1.0 (+https://zevium.dev)`
and `Accept: application/json`.

---

### [SEV: P3] `status: 0` conflates every transport failure class

**Location:** `convex/lib/webhookDelivery.ts:82-83`

```ts
return { ok: false, status: 0, error: message };
```

**Problem:** Timeout, DNS failure, connection refused, TLS handshake
failure, and abort are all collapsed to `status: 0`.
`recordDeliveryAttempt` stores only `lastError`, so the only signal
distinguishing "endpoint unreachable" from "endpoint timed out" is the
free-text `error` string — the very string that the leakage finding shows
should be sanitized. There is no structured failure category for
ops/dashboard triage.

**Impact:** Cannot aggregate failure causes; ops cannot tell a
misconfigured-DNS publisher from a slow-endpoint publisher from the
delivery log alone.

**Fix:** Add a `failureKind` enum (`timeout | dns | conn_refused | tls |
aborted | network`) to `PostWebhookResult` so `recordDeliveryAttempt`
can store and aggregate it.

---

### [SEV: P3] No `verifySignature` helper exported — constant-time responsibility pushed to consumers

**Location:** `convex/lib/webhookDelivery.ts:29-43` (only `computeSignature`
exported, no verify)

**Problem:** The file exports the producer side (`computeSignature`) but
no consumer-side `verifySignature` helper. Verification is documented as
a consumer responsibility, but consumers routinely implement comparison
with `===` over hex strings — a non-constant-time comparison that leaks
the signature via timing. Stripe, Svix, and GitHub all ship a
`verify` helper that does a constant-time compare. By exporting only the
producer, this module invites the most common webhook-verification bug.

**Impact:** Consumers are likely to write timing-unsafe verification;
no reference implementation to point them at.

**Fix:** Export a `verifySignature(secret, body, signature): Promise<boolean>`
that uses `crypto.subtle.verify` (constant-time in WebCrypto) or a
constant-time byte compare. Document the comparison requirement.

---

### [SEV: P3] `x-zevium-event` header value not sanitized against CRLF injection

**Location:** `convex/lib/webhookDelivery.ts:67`

```ts
"x-zevium-event": params.event,
```

**Problem:** `params.event` is a bare `string` placed directly into a
header. If a future caller passes a value containing `\r\n`, fetch may
either reject it (good) or, depending on the runtime's header sanitizer,
permit additional injected headers (HTTP request splitting). Today the
callers pass hardcoded constants (`"spec.published"`,
`"spec.deprecated"`, `"project.visibility_changed"`), so this is not
exploitable now — but `postWebhook` is a general-purpose helper that
performs no validation on `event`. `params.url` is safe because
`validateWebhookUrl` runs `new URL()` (which rejects CRLF) at upsert
time, but the same defense is not applied to `event`.

**Impact:** Latent request-splitting risk if a future caller passes
untrusted input as `event`.

**Fix:** Validate `event` against a strict allowlist of event names, or
at minimum reject any value containing `\r` / `\n` / control chars
before placing it in a header.

---

### [SEV: P3] `WEBHOOK_TIMEOUT_MS` is a module constant — not tunable per delivery

**Location:** `convex/lib/webhookDelivery.ts:23`

```ts
export const WEBHOOK_TIMEOUT_MS = 10_000;
```

**Problem:** Every delivery uses a fixed 10s timeout. There is no way
for a publisher to declare a longer acceptable latency, and no way for
Zevium to tune per-event-class. 10s is reasonable as a default but the
constant is exported yet never overridable through `PostWebhookParams`.
A slow-but-legitimate endpoint that takes 12s will be marked failed,
retried 3×, and ultimately generate a `webhook_failed` notification for
a delivery the endpoint would have succeeded at given another 2s.

**Impact:** False failures for slow endpoints; no escape hatch.

**Fix:** Accept an optional `timeoutMs` in `PostWebhookParams` (capped
to a sane maximum, e.g. 30s), defaulting to `WEBHOOK_TIMEOUT_MS`.

---

## Verified-clean checks (explicitly looked for, not found)

- **Secret leakage in delivered payload.** The delivered body is
  `{event, data, timestamp}`. `data` from all three current callers
  (`specs.publish`, `specs.deprecateVersion`, `admin.setProjectVisibility`)
  is `{projectId, version[, sunsetAt]}` / `{projectId, visibility}` — no
  secrets, no internal errors, no PII. The signing `secret` is never
  placed in the body or headers. Clean today (re-check if new event
  types are added).
- **Revoked endpoint still receiving HTTP.** `deliverWebhook`
  short-circuits on `!info.active` *before* calling `postWebhook`, so a
  deactivated endpoint does not receive the POST. (The short-circuit
  still has a separate bug — see the inactive-endpoint P1 above — but
  the network-side revocation is correct.)
- **HMAC algorithm correctness.** WebCrypto `importKey` with
  `{name: "HMAC", hash: "SHA-256"}` and `sign("HMAC", ...)` is the
  correct primitive selection; hex encoding is lowercase and
  zero-padded. The signing itself is sound.
- **Constant-time comparison.** Not applicable *in this file* —
  `computeSignature` only produces; it never compares. The
  constant-time concern is consumer-side and noted as a P3 contract gap
  (no `verifySignature` exported).

---

## Summary

22 findings — P0: 1, P1: 6, P2: 8, P3: 7.

**Top 3:**

1. **[P0] Redirect-following SSRF** (`webhookDelivery.ts:62-71`). `fetch`
   follows publisher-issued `302` to `http://169.254.169.254/…` and other
   internal HTTP targets, bypassing the `https:`-only guard; `301`/`302`
   also silently drops the POST body and records the delivery as `ok`.
   Fix: `redirect: "error"` (or manual + re-validate each hop).

2. **[P1] `deliverWebhook` action body unguarded → scheduler-retry
   duplicate deliveries** (`webhooks.ts:292-330`). No try/catch around
   `JSON.parse` / `runMutation`; a throw re-runs the action and re-POSTs
   the same signed body, on top of the at-least-once scheduler semantics
   with no idempotency key. Fix: catch everything → route through
   `recordDeliveryAttempt`; make `deliverWebhook` idempotent via
   `delivery.status`/`attempts` CAS.

3. **[P1] Inactive endpoint burns 3 retries + false notification**
   (`webhooks.ts:309-313`). Revoking an endpoint generates 3 scheduler
   invocations and a spurious `webhook_failed` notification per in-flight
   delivery, even though no HTTP was attempted. Compounded by
   [P1] direct SSRF (no internal-IP blocklist at fetch site), [P1] 4xx
   retried as transient, [P1] raw `err.message` leaked into the
   notification body, and [P1] no idempotency key.

**Underlying theme:** the helper signs correctly but treats the
destination URL, the redirect chain, the response status, the transport
error, the attempt counter, the caller's transaction, and the scheduler's
retry semantics as trusted inputs — none of them are. The signing
primitive was the only part of this file that needed to be right;
everything around it needs a trust boundary.
