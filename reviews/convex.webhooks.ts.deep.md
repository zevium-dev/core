# Tiger-Style Deep-Dive — `convex/webhooks.ts`

Publisher-side outbound webhook delivery. This file owns the URL-validation
guard (`validateWebhookUrl`), endpoint CRUD, the delivery retry state machine
(`recordDeliveryAttempt`), and the scheduling seams (`fireWebhookEvent`,
`deliverWebhook`). The HMAC signing primitive itself lives in
`convex/lib/webhookDelivery.ts` (reviewed separately); every structural defect
below is rooted *here*, in `webhooks.ts`.

Verified against `convex/schema.ts`, `convex/projects.ts`, `convex/lib/auth.ts`,
`convex/lib/notifications.ts`, `convex/lib/webhookDelivery.ts`, `convex/http.ts`,
`convex/crons.ts`, `convex/cronTasks.ts`, `convex/webhooks.test.ts`, and the
`fireWebhookEvent` call sites in `convex/specs.ts` / `convex/admin.ts`.

---

## Verdict

**Incorrect / insecure.** The single URL-validation guard accepts every
`https:` URL regardless of destination — `https://169.254.169.254/`,
`https://10.0.0.1/`, `https://[::1]`, `https://metadata.google.internal/` all
pass — making the publisher-supplied webhook URL a direct server-side request
forgery vector from the Convex runtime. The `http://localhost` dev carve-out
is active in production with no env gate and accepts any port. The URL is
never ownership-verified (no challenge-response), never re-validated at fetch
time, and the delivery state machine is not idempotent: it has no
terminal-state guard, retries permanent 4xx, treats intentional endpoint
deactivation as a retryable failure (generating spurious `webhook_failed`
notifications), interpolates raw transport-error strings into the
publisher-visible notification body, and never propagates `deliveryId` to the
HTTP layer so consumers cannot dedupe at-least-once deliveries. Endpoint
deletion orphans delivery rows; no retention job exists.

---

## File Stats

- File: `convex/webhooks.ts` (330 lines)
- Exports: `MAX_WEBHOOK_ATTEMPTS`, `WEBHOOK_BACKOFF_SECONDS`,
  `validateWebhookUrl`, `fireWebhookEvent`, `upsertEndpoint`, `getEndpoint`,
  `deleteEndpoint`, `listDeliveries`, `getDeliveryForAction`,
  `recordDeliveryAttempt`, `deliverWebhook`
- Callers of `fireWebhookEvent`: `convex/specs.ts:182` (`spec.published`),
  `convex/specs.ts:346` (`spec.deprecated`), `convex/admin.ts:242`
  (`project.visibility_changed`)
- Schema: `webhookEndpoints` (one per project, `by_project`),
  `webhookDeliveries` (`by_endpoint` = `[endpointId, createdAt]`)
- Findings: 28 — P0: 1, P1: 9, P2: 9, P3: 9

---

## Findings

### [SEV: P0] SSRF: `validateWebhookUrl` accepts every `https:` URL including private IPs and metadata endpoints

**Location:** `convex/webhooks.ts:34-46`

```ts
export function validateWebhookUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;          // ← unguarded
  if (parsed.protocol === "http:" && parsed.hostname === "localhost") {
    return true;
  }
  return false;
}
```

**Problem:** The `https:` branch returns `true` unconditionally. There is no
blocklist for private/loopback/link-local/CGNAT ranges, no metadata-hostname
denylist, no DNS resolution. Every one of these is accepted and later fetched
server-side by `postWebhook` (`convex/lib/webhookDelivery.ts:62`):

- `https://169.254.169.254/latest/meta-data/iam/security-credentials/` (AWS IMDS — https works against the IP literal)
- `https://10.0.0.1/`, `https://192.168.1.1/`, `https://172.16.0.1/` (RFC1918)
- `https://[::1]/`, `https://[fc00::1]/` (IPv6 loopback / ULA)
- `https://100.64.0.1/` (CGNAT)
- `https://metadata.google.internal/computeMetadata/` (GCP metadata — DNS-resolved private)
- `https://0x7f000001/`, `https://2130706433/` (decimal/hex IPv4 encodings — `new URL` does not normalize these away)
- Any hostname whose A/AAAA record resolves to a private IP (DNS rebinding)

The `http://localhost` carve-out (next finding) widens this further. This
guard is the **only** URL check in the pipeline; `postWebhook` does none. It
runs once at `upsertEndpoint` time, so every stored endpoint URL is trusted
blindly thereafter. `http.ts` inbound routes (Clerk/Stripe) are unrelated;
this is purely the publisher-controlled outbound surface.

**Impact:** A publisher (any project member) registers an internal `https:`
URL; Zevium's Convex runtime issues an authenticated, HMAC-signed POST to an
internal service, cloud metadata, or loopback admin surface.
Reconnaissance and credential theft from a multi-tenant vantage point.
Composes with the redirect-following SSRF (P0 in `webhookDelivery.ts`) — a
"clean" `https://attacker.com/` URL can 302 to `http://169.254.169.254/`.

**Fix:** Resolve the hostname and reject `127.0.0.0/8`, `10.0.0.0/8`,
`172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`,
`0.0.0.0`, `::1`, `fc00::/7`, `fe80::/10`, and metadata hostnames
(`metadata.google.internal`, `169.254.169.254`, AWS/GCP/Azure variants).
Re-validate at fetch time in `postWebhook` (defense in depth), pass
`redirect: "manual"` and re-resolve each hop. Gate `http://localhost` behind
an explicit dev flag. Reject IP-literal forms and decimal/octal/hex
encodings by normalizing through `URL` + `node:dns.lookup(..., { all: true })`.

---

### [SEV: P1] `http://localhost` carve-out is production-active, any port, no env gate

**Location:** `convex/webhooks.ts:43-45`

```ts
if (parsed.protocol === "http:" && parsed.hostname === "localhost") {
  return true;
}
```

**Problem:** The dev carve-out accepts `http://localhost:<any-port>` with no
environment discrimination — it is enforced identically in dev and prod. In
production this reaches every loopback service bound on the Convex runtime:
`http://localhost:6379` (Redis), `http://localhost:9099` (internal admin),
`http://localhost:8080` (sidecar proxies), etc. The hostname check is exact
(`=== "localhost"`), so `http://127.0.0.1` is rejected but `http://localhost`
is not — a sharper tool than necessary for "dev callback". There is no
allowlist of dev ports.

**Impact:** Loopback SSRF to every service on the Convex host in production.
Distinct from the P0 (which is `https:` to the whole private range) — this is
the `http:` scheme specifically, which the P0 guard would otherwise block.

**Fix:** Gate the localhost exception behind `process.env.NODE_ENV !==
"production"` (or an explicit `WEBHOOK_ALLOW_LOCALHOST` flag). Restrict to a
small allowlist of dev ports. Move the check into `validateWebhookUrl` only
after the dev-flag passes.

---

### [SEV: P1] URL validated once at upsert, never re-validated at fetch time

**Location:** `convex/webhooks.ts:104-149` (`upsertEndpoint` calls
`validateWebhookUrl`); `convex/lib/webhookDelivery.ts:62` (`postWebhook` calls
`fetchImpl(params.url, …)` with no validation)

**Problem:** The guard is a single-point check at `upsertEndpoint` time. The
stored URL is fetched verbatim by `deliverWebhook` → `postWebhook`, which
performs no validation of its own. If `validateWebhookUrl` is ever tightened
(per the P0 fix), every endpoint registered before the fix keeps fetching
the now-blocked target — there is no migration path and no defense-in-depth.
The same applies if a future code path stores a URL without going through
`upsertEndpoint` (e.g. a bulk-import or admin mutation).

**Impact:** Stale URLs bypass future SSRF mitigations; the fetch site is
unguarded against any new validation rule.

**Fix:** Validate (and re-resolve) the URL inside `postWebhook` immediately
before `fetchImpl`, using the same blocklist as `upsertEndpoint`. Treat
`upsertEndpoint` validation as a UX-time early rejection, not the security
boundary.

---

### [SEV: P1] No webhook URL ownership verification (no challenge-response)

**Location:** `convex/webhooks.ts:104-149` (`upsertEndpoint`)

**Problem:** `upsertEndpoint` requires project membership and validates the
URL scheme, but never verifies that the caller *controls* the destination. Any
project member points Zevium's server at any `https:` URL and Zevium will
immediately begin POSTing HMAC-signed payloads to it on the next
`fireWebhookEvent`. Combined with the P0 (no private-IP blocklist), this is
the SSRF entry: the attacker does not even need a redirect — they register
the internal target directly as the webhook URL. Even with the blocklist
fixed, absent ownership verification a publisher can weaponize Zevium to
probe arbitrary public hosts (port-scan via timing, fingerprinting via
response status) and to launder authenticated POSTs toward third parties.

**Impact:** Unauthenticated-to-Zevium SSRF and authenticated POST origination
toward arbitrary targets. Also a correctness issue: a mistyped URL silently
receives signed deliveries the recipient cannot verify (they have no secret,
since the secret is returned only to the registrar).

**Fix:** Before activating an endpoint, issue a one-time verification
challenge: POST a random nonce to the URL, require a `2xx` response whose body
(or header) echoes the nonce, and only then flip `active: true`. Re-verify on
URL change. This is the standard webhook-ownership pattern (Slack, Stripe,
GitHub all do it).

---

### [SEV: P1] Inactive-endpoint retry storm: deactivation treated as retryable failure

**Location:** `convex/webhooks.ts:304-311` (`deliverWebhook` inactive branch)
→ `convex/webhooks.ts:255-271` (`recordDeliveryAttempt` retry branch)

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

**Problem:** When a publisher sets `active: false` via `upsertEndpoint`, any
deliveries already `pending` (scheduled but not yet run) hit this branch on
their next run. `recordDeliveryAttempt` receives `ok: false`, increments
`attempts`, and — because `nextAttempts < MAX_WEBHOOK_ATTEMPTS` — schedules
*another* `deliverWebhook` retry. The retry runs, the endpoint is still
inactive, the cycle repeats until `attempts === 3`, at which point the
final-failure branch fires a `webhook_failed` notification:

```
Delivery of "spec.published" failed after 3 attempts: Endpoint inactive.
```

The publisher explicitly disabled the endpoint and is now notified that it
"failed". There is no `cancelled` status (see P2 finding) and no early-exit
for the intentional-deactivation case. `fireWebhookEvent` itself no-ops when
`!endpoint.active` (`webhooks.ts:74`), so this only affects in-flight
deliveries — but those exist whenever deactivation races a pending delivery.

**Impact:** Two pointless retries per orphaned delivery to a disabled
endpoint; misleading `webhook_failed` notifications that erode trust in the
notification channel and conflate intentional disablement with breakage.

**Fix:** When `!info.active`, mark the delivery with a terminal
`status: "cancelled"` (requires schema addition) without retry and without
notification. Alternatively, short-circuit `recordDeliveryAttempt` to a
no-op-then-terminal when the endpoint is inactive.

---

### [SEV: P1] `recordDeliveryAttempt` has no terminal-state guard — late duplicates resurrect `failed` → `ok`

**Location:** `convex/webhooks.ts:244-271`

```ts
if (args.ok) {
  await ctx.db.patch(args.deliveryId, {
    status: "ok",
    attempts: nextAttempts,
  });
  return;
}
```

**Problem:** The mutation patches `status`/`attempts` unconditionally based
on `args.ok` without inspecting the delivery's *current* `status`. Convex's
scheduler is at-least-once: the same `deliverWebhook` action can be retried
after a transient failure, even after `recordDeliveryAttempt` has already
transitioned the delivery to a terminal state. Concretely:

1. Initial `deliverWebhook` runs, `postWebhook` succeeds, but the
   `ctx.runMutation(recordDeliveryAttempt, { ok: true })` call fails to
   commit (transient). Scheduler retries the action.
2. Retry re-runs `postWebhook` (double-delivery to the endpoint), then
   `recordDeliveryAttempt(ok: true)` patches `status: "ok"` — fine.
3. But for the failure path: if a delivery was already marked `failed` (final
   attempt) and a stale scheduler duplicate of the *original* action later
   runs and succeeds, `recordDeliveryAttempt(ok: true)` patches it back to
   `status: "ok"`. The `webhook_failed` notification (`refId:
   webhook_failed:<deliveryId>`, idempotent) has already fired and is not
   retracted — the publisher sees a "failed" notification for a delivery now
   recorded as `ok`.

The same lack of guard means a `failed` delivery can be re-retried if a stale
`recordDeliveryAttempt(ok: false)` duplicate lands after the final-failure
transition.

**Impact:** Terminal-state resurrection corrupts the delivery log; stale
notifications; impossible-to-reason-about state. Consumers see duplicate
deliveries with no way to correlate.

**Fix:** At the top of `recordDeliveryAttempt`, read `delivery.status` and
short-circuit if it is already terminal (`ok` or `failed`):

```ts
if (delivery.status === "ok" || delivery.status === "failed") return;
```

Use `ctx.db.patch` with an OCC guard or a conditional update keyed on the
expected prior `attempts` value.

---

### [SEV: P1] `recordDeliveryAttempt` is not idempotent under concurrent action delivery — duplicate retries, lost counts

**Location:** `convex/webhooks.ts:240-271`

**Problem:** When two `deliverWebhook` runs for the same `deliveryId` execute
concurrently (scheduler at-least-once, or the initial run racing a scheduled
retry), both call `recordDeliveryAttempt`. The mutation reads
`delivery.attempts`, computes `nextAttempts = delivery.attempts + 1`, and
patches. Under Convex OCC one patch will throw on commit, but the
*logical* outcome is still wrong: the surviving patch schedules a retry based
on a stale `attempts` count, and the thrown mutation either (a) silently
aborts its scheduled retry (good) or (b) depending on the failure mode,
leaves the delivery in an inconsistent state where the action's `postWebhook`
ran but the attempt was never recorded. Across the wider retry tree this
means duplicate POSTs to the endpoint with no corresponding `attempts`
increment, and potentially multiple scheduled retries for one logical
failure.

**Impact:** Duplicate outbound deliveries (no dedupe possible — see next
finding), undercounted `attempts`, retry-tree fan-out under adverse
scheduling. The delivery log no longer reflects reality.

**Fix:** Make `recordDeliveryAttempt` idempotent by keying the transition on
the expected prior state: only patch if `delivery.attempts === expectedPrior`
(supplied by the caller) and `delivery.status === "pending"`. Alternatively,
use a conditional `patch` that fails the mutation if the doc changed, and
have callers treat that failure as "already recorded, skip".

---

### [SEV: P1] `deliveryId` never propagated to `postWebhook` — no `Idempotency-Key` header possible

**Location:** `convex/webhooks.ts:313-321` (`deliverWebhook`)

```ts
const result = await postWebhook({
  url: info.url,
  secret: info.secret,
  event: parsed.event,
  data: parsed.data,
  timestamp: parsed.timestamp,
});
```

**Problem:** `deliverWebhook` holds `args.deliveryId` but does not pass it to
`postWebhook`. `PostWebhookParams` (`convex/lib/webhookDelivery.ts:3-10`) has
no field for it. The HTTP request therefore carries no
`x-zevium-delivery-id`, no `x-zevium-attempt`, and no `Idempotency-Key`.
Consumers cannot distinguish a genuine retry from a scheduler duplicate, and
have no stable identifier to dedupe on — the signature is identical across
retries (same body, same `timestamp` read from the stored payload). This is
the root cause of the lib's "no idempotency key" P1: even if `postWebhook`
gained the header, the action never supplies the value. At-least-once
delivery with side-effecting consumers (cache invalidation, provisioning,
deprecation handling) means N applied side effects per logical delivery.

**Impact:** Duplicate side effects at every receiver; no consumer-side
dedupe mechanism is even expressible against the current API.

**Fix:** Add `deliveryId: string` and `attempt: number` to
`PostWebhookParams`; emit `Idempotency-Key: <deliveryId>` and
`x-zevium-delivery-id` / `x-zevium-attempt` headers in `postWebhook`. Pass
`args.deliveryId` and `info.attempts + 1` from `deliverWebhook`. Document
that consumers MUST dedupe on `x-zevium-delivery-id`.

---

### [SEV: P1] Raw transport-error string interpolated into publisher-visible notification body

**Location:** `convex/webhooks.ts:282`

```ts
body: `Delivery of "${delivery.event}" failed after ${MAX_WEBHOOK_ATTEMPTS} attempts${args.error !== undefined ? `: ${args.error}` : ""}.`,
```

**Problem:** `args.error` flows here from `postWebhook`'s catch branch
(`convex/lib/webhookDelivery.ts:81-83`), which returns `err.message` verbatim.
Node/undici fetch errors routinely embed internal hostnames, IPs, and ports:
`connect ECONNREFUSED 10.0.5.23:443`, `getaddrinfo ENOTFOUND
internal-admin.zevium.svc`, `certificate has expired for
internal-api.local`. The notification body is persisted in the
`notifications` table and surfaced to every member of the publisher's Clerk
org via the notifications feed. There is no length cap, no allowlist, no
sanitization. `delivery.lastError` (`webhooks.ts:252, 268`) stores the same
raw string and is returned by `listDeliveries` to org members. A redirect
chain URL or stack-trace fragment could be persisted indefinitely.

**Impact:** Internal network topology / hostname / IP disclosure to org
members (who may be untrusted relative to Zevium infra). Unbounded string
persistence in `notifications.body` and `webhookDeliveries.lastError`.

**Fix:** Map transport errors to a small fixed vocabulary before they leave
`postWebhook` (`"timeout"`, `"connection_refused"`, `"dns_failure"`,
`"tls_error"`, `"network_error"`). Cap `error` length at ~200 chars. Never
interpolate `err.message` into a user-visible surface; in
`recordDeliveryAttempt`, treat `args.error` as already-sanitized and
additionally truncate before persisting.

---

### [SEV: P1] Every non-2xx retried, including permanent 4xx — false `webhook_failed` alarms

**Location:** `convex/webhooks.ts:255-271` (retry branch keyed only on
`!args.ok`); upstream `convex/lib/webhookDelivery.ts:73-80` returns `ok: false`
for any non-2xx

**Problem:** `postWebhook` returns `ok: false` for every non-2xx status
(including `404 Not Found`, `410 Gone`, `401 Unauthorized`, `403 Forbidden`,
`451 Unavailable For Legal Reasons`). `recordDeliveryAttempt` treats all
`ok: false` identically: increment, schedule retry, and on the 3rd attempt
fire `webhook_failed`. A permanently-gone endpoint (410) or a misconfigured
auth (401) generates two pointless retries and a false alarm. Only `5xx`,
`408`, and `429` are meaningfully transient; `4xx` (except `408`/`429`) is a
contract/configuration error retrying cannot fix.

**Impact:** Wasted outbound requests, endpoint spam for misconfigured
publishers, false `webhook_failed` notifications that train publishers to
ignore the channel. Compounds the inactive-endpoint storm (P1 above).

**Fix:** Have `postWebhook` return a `retryable` flag (or split the result
type) based on status: retry only `5xx`, `408`, `429`, and transport
failures; treat other `4xx` as terminal-failure with no retry. Have
`recordDeliveryAttempt` honor that flag — for terminal-non-retryable
failures, jump straight to `status: "failed"` (and decide whether to notify;
a 410 probably should not notify).

---

### [SEV: P2] `deleteEndpoint` orphans `webhookDeliveries` rows and does not cancel scheduled retries

**Location:** `convex/webhooks.ts:167-183` (`deleteEndpoint`)

```ts
await ctx.db.delete(existing._id);
return { deleted: true };
```

**Problem:** Deleting a `webhookEndpoints` row leaves every `webhookDeliveries`
row with a dangling `endpointId`. `listDeliveries` loads the endpoint first
(`by_project`) and returns an empty page when the endpoint is gone, so the
orphaned deliveries become invisible to the publisher but persist in the DB
forever (no retention job — next finding). Worse, any already-scheduled
`deliverWebhook` retry for those deliveries will still fire: `getDeliveryForAction`
returns `null` (endpoint deleted), `deliverWebhook` returns silently, so no
infinite loop — but the delivery remains `status: "pending"` with stale
`attempts`, an orphan forever. There is no cascade delete and no
`scheduler.cancel` of pending retries.

**Impact:** Storage leak; orphaned rows that confuse any future query that
joins deliveries to endpoints; unreclaimable pending deliveries.

**Fix:** On `deleteEndpoint`, delete all `webhookDeliveries` rows for the
endpoint (via `by_endpoint` index) or mark them cancelled. Cancel any
scheduled `deliverWebhook` jobs for those deliveries (Convex exposes
`scheduler.cancel`).

---

### [SEV: P2] No retention / TTL for `webhookDeliveries` — unbounded growth

**Location:** `convex/webhooks.ts` (no cleanup); `convex/crons.ts` (only
`low-balance-check`); `convex/cronTasks.ts` (only `checkLowBalances`)

**Problem:** Every `fireWebhookEvent` inserts a `webhookDeliveries` row that
is never deleted by any code path. `crons.ts` registers a single hourly
low-balance job; no webhook-delivery retention exists. A project with an
active endpoint and frequent publish/deprecate events accumulates deliveries
indefinitely. The `payload` column stores the full signed body (unbounded —
see P2 below), so each row is potentially large.

**Impact:** Unbounded table growth; `listDeliveries` pagination degrades over
time; storage cost; no data-retention compliance story.

**Fix:** Add a daily cron that deletes (or archives) `webhookDeliveries`
older than N days (e.g. 30), scoped per `by_endpoint` then `createdAt`.
Consider a `ttl` config on the table if Convex exposes one for non-referenced
logs.

---

### [SEV: P2] No secret rotation endpoint — leaked secret requires delete + recreate

**Location:** `convex/webhooks.ts:120-149` (`upsertEndpoint` update path
preserves `secret`; no rotate mutation)

**Problem:** `upsertEndpoint` explicitly preserves `existing.secret` on
update ("Secret preserved on update" per the docstring). There is no
mutation to rotate the signing secret. If a secret leaks (e.g. logged
accidentally, committed, or exposed via a compromised member), the only
remediation is `deleteEndpoint` + `upsertEndpoint`, which generates a new
`webhookEndpoints._id` and severs the `endpointId` link to historical
`webhookDeliveries` rows (they become orphans per the P2 above). Existing
consumers who verified with the old secret silently break with no transition
period.

**Impact:** No recovery path for a leaked secret that preserves delivery
history or allows consumer rotation. No grace period for dual-key
verification.

**Fix:** Add a `rotateSecret` mutation that generates a new secret and
optionally keeps the previous one valid for a grace window (schema field
`previousSecret` + `previousSecretExpiresAt`), with `postWebhook` accepting
either during the window.

---

### [SEV: P2] `upsertEndpoint` returns the secret on every call (create and update)

**Location:** `convex/webhooks.ts:120-149` (returns `Doc<"webhookEndpoints">`
which includes `secret`)

**Problem:** The mutation returns the full endpoint document including
`secret` on both the create path (necessary — the publisher needs the secret
to verify) and the update path (where the secret is preserved and unnecessary
to re-expose). `getEndpoint` (`webhooks.ts:152-164`) also returns the full
doc including `secret`. Every URL change or `active` toggle re-sends the
secret over the wire to the client. While the secret is the publisher's own,
each transmission is an exposure surface (client-side logging, network
intermediaries, browser devtools).

**Impact:** Unnecessary secret re-transmission on every endpoint read/update;
expanded window for client-side leakage.

**Fix:** Return the secret only on create (or via a dedicated `revealSecret`
mutation with separate audit). Have `getEndpoint` and the update path return
a doc with `secret` redacted (e.g. `{ ...doc, secret: undefined }` or a
projection that omits it).

---

### [SEV: P2] No payload size cap on `data` / stored `payload`

**Location:** `convex/webhooks.ts:77-78` (`fireWebhookEvent`)

```ts
const payload = JSON.stringify({ event, data, timestamp });
const deliveryId = await ctx.db.insert("webhookDeliveries", { …, payload });
```

**Problem:** `fireWebhookEvent` accepts `data: unknown` and stringifies it
into both the stored `webhookDeliveries.payload` column and (via
`deliverWebhook` → `postWebhook`) the outbound HTTP body. There is no size
cap anywhere in the pipeline. Convex caps document size near 1 MB; a large
`data` object will either fail the DB insert (after the mutation has already
done work) or succeed at insert and produce an outbound body that exceeds
reasonable receiver limits (triggering retry storms per the 4xx P1). The
current callers (`specs.ts`, `admin.ts`) pass small objects, but the type
signature invites future callers to pass anything.

**Impact:** DB write failures on large events; oversized deliveries; retry
storms when receivers reject large bodies.

**Fix:** Enforce a maximum serialized body size (e.g. 64 KB) in
`fireWebhookEvent` before insert, and again in `postWebhook` before signing.
Reject oversized events with a clear error rather than letting them fall
through to a deep size-limit failure.

---

### [SEV: P2] Fixed backoff with no jitter — thundering herd on endpoint recovery

**Location:** `convex/webhooks.ts:14-16, 263-265`

```ts
export const WEBHOOK_BACKOFF_SECONDS = [60, 300] as const;
…
const backoffSec = WEBHOOK_BACKOFF_SECONDS[backoffIndex] ?? 300;
await ctx.scheduler.runAfter(backoffSec * 1000, internal.webhooks.deliverWebhook, …);
```

**Problem:** The retry schedule is fixed (60s, 300s) with no jitter. When an
endpoint goes down and many deliveries are in flight (e.g. a bulk
deprecation triggers N `spec.deprecated` events), all pending deliveries
retry at the same instant — `+60s` for all first-failures, then `+300s` for
all second-failures. On endpoint recovery the herd hits simultaneously,
potentially overwhelming the receiver and causing new failures (and new
retries). Standard practice is exponential backoff with decorrelated jitter
(`equalJitter` or `decorrelatedJitter`).

**Impact:** Synchronized retry waves; receiver overload on recovery;
amplified failure cascades.

**Fix:** Add ±20% jitter to each backoff interval, or use
`base * 2^attempt * random(0.5..1)`. Compute the jitter at schedule time so
it is persisted with the scheduled job.

---

### [SEV: P2] No `cancelled` status — deactivation/deletion forces deliveries into the pending→failed chain

**Location:** `convex/schema.ts` (`webhookDeliveries.status` union:
`pending | ok | failed`); `convex/webhooks.ts:304-311` (inactive branch),
`167-183` (delete branch)

**Problem:** The schema has no terminal `cancelled` state. Deliveries
orphaned by endpoint deactivation or deletion cannot be cleanly marked
cancelled — they are forced down the `pending → failed` retry chain (see the
inactive-endpoint P1) or left `pending` forever (delete case). This conflates
intentional cancellation with delivery failure in the log and in the
notification stream.

**Impact:** Misleading delivery states; spurious `webhook_failed`
notifications for intentionally-cancelled deliveries; no clean way to
represent "the publisher turned this off" vs "the endpoint is broken".

**Fix:** Add `cancelled` to the `status` union; transition orphaned
deliveries to `cancelled` on deactivation/deletion without retry or
notification.

---

### [SEV: P2] `fireWebhookEvent` has no rate limiting / fan-out cap

**Location:** `convex/webhooks.ts:60-91`

**Problem:** Every `fireWebhookEvent` call inserts one delivery and schedules
one action. There is no per-project, per-event, or per-window rate limit. A
caller that fires many events in quick succession (e.g. a script that
publishes and deprecates many versions, or an admin bulk visibility change)
creates an unbounded number of deliveries and scheduled actions. The callers
in `specs.ts` / `admin.ts` are individually gated, but nothing in
`fireWebhookEvent` prevents a burst. Combined with no dedup (next finding),
concurrent same-event fires produce duplicate deliveries.

**Impact:** Delivery bursts that overwhelm the receiver; scheduled-action
spikes; no backpressure.

**Fix:** Track a per-project delivery rate (e.g. a token bucket keyed on
`projectId`) or coalesce near-simultaneous identical events. At minimum,
cap pending deliveries per endpoint.

---

### [SEV: P2] `WEBHOOK_BACKOFF_SECONDS[backoffIndex] ?? 300` fallback is dead code

**Location:** `convex/webhooks.ts:263-264`

```ts
const backoffIndex = nextAttempts - 1;
const backoffSec = WEBHOOK_BACKOFF_SECONDS[backoffIndex] ?? 300;
```

**Problem:** This branch is only entered when `nextAttempts <
MAX_WEBHOOK_ATTEMPTS`, i.e. `nextAttempts ∈ {1, 2}`, so `backoffIndex ∈ {0,
1}`. `WEBHOOK_BACKOFF_SECONDS` has exactly 2 entries (`[60, 300]`), so
`WEBHOOK_BACKOFF_SECONDS[backoffIndex]` is always defined; the `?? 300`
fallback can never execute. If `MAX_WEBHOOK_ATTEMPTS` were ever raised
without extending `WEBHOOK_BACKOFF_SECONDS`, the fallback would silently cap
at 300s — a latent footgun rather than a safety net.

**Impact:** Dead code today; misleading safety signal; latent misbehavior if
constants diverge.

**Fix:** Either derive the backoff programmatically
(`60 * 5 ** (backoffIndex)` with jitter) so the arrays cannot diverge, or add
a compile-time assertion that `WEBHOOK_BACKOFF_SECONDS.length >=
MAX_WEBHOOK_ATTEMPTS - 1` and drop the `?? 300`.

---

### [SEV: P3] `getDeliveryForAction` returns `event` and `attempts` fields that `deliverWebhook` never reads

**Location:** `convex/webhooks.ts:219-237` (return shape); `convex/webhooks.ts:313-321` (consumer)

**Problem:** The internal query returns `{ url, secret, active, event, payload,
attempts }`, but `deliverWebhook` only reads `url`, `secret`, `active`, and
`payload` (it re-derives `event` from `JSON.parse(info.payload).event`).
`info.event` and `info.attempts` are dead. `attempts` is also recomputed
inside `recordDeliveryAttempt` from the delivery doc directly, not from this
query.

**Impact:** Minor wasted serialization; misleading API surface (suggests the
action uses these fields).

**Fix:** Drop `event` and `attempts` from the return type.

---

### [SEV: P3] `recordDeliveryAttempt` does not clear `lastError` on success

**Location:** `convex/webhooks.ts:247-252`

```ts
if (args.ok) {
  await ctx.db.patch(args.deliveryId, {
    status: "ok",
    attempts: nextAttempts,
  });
  return;
}
```

**Problem:** On a successful attempt the patch sets `status: "ok"` and
`attempts` but leaves any prior `lastError` intact. A delivery that fails
(attempt 1, `lastError` set) then succeeds (attempt 2) shows `status: "ok"`
with a stale `lastError` in `listDeliveries`, misleading operators
investigating the log.

**Impact:** Cosmetic/log-accuracy issue.

**Fix:** `patch({ status: "ok", attempts: nextAttempts, lastError: undefined })`
— note Convex `patch` cannot unset optional fields; use `replace` or accept
`lastError: ""`.

---

### [SEV: P3] `upsertEndpoint` has no URL length cap

**Location:** `convex/webhooks.ts:109-115`

**Problem:** `args.url.trim()` is validated for scheme but not length. A
megabyte-length URL (path/query) passes `validateWebhookUrl` and is stored
in `webhookEndpoints.url`, then sent as the fetch target. `new URL` accepts
arbitrarily long paths.

**Impact:** Storage abuse; potential fetch-target URL overflow.

**Fix:** Cap URL length at ~2048 chars after trim.

---

### [SEV: P3] No audit trail for URL changes — old URL overwritten, no history

**Location:** `convex/webhooks.ts:120-149` (`patch({ url, active })`)

**Problem:** When the URL changes, the old URL is overwritten with no
history. If a compromised member repoints the webhook at an attacker URL,
there is no audit trail in the `webhookEndpoints` table (only the current
URL). `webhookDeliveries` rows still carry the `endpointId` but not the URL
used at delivery time — `getDeliveryForAction` reads the *current* URL, so a
post-hoc investigation cannot recover which URL a past delivery was sent to.

**Impact:** No forensic recovery for endpoint hijack; deliveries cannot be
attributed to a URL after the fact.

**Fix:** Store a lightweight audit event (notification or a
`webhookEndpointChanges` table) on URL change, or snapshot the URL into
each `webhookDeliveries` row at fire time.

---

### [SEV: P3] `listDeliveries` has no filter by `status` or `event`

**Location:** `convex/webhooks.ts:186-215`

**Problem:** The query paginates all deliveries for an endpoint newest-first
with no filter. A publisher investigating failures must paginate the entire
log (including `ok` deliveries) to find `failed` rows. The `by_endpoint` index
is `[endpointId, createdAt]` — no `status` filter is expressible without a
scan.

**Impact:** Operational friction; full-log scans for failure triage.

**Fix:** Add an optional `status` arg and a `by_endpoint_status` index
(`[endpointId, status, createdAt]`) so failures can be queried directly.

---

### [SEV: P3] `deliverWebhook` uses an unchecked `as` cast on `JSON.parse(info.payload)`

**Location:** `convex/webhooks.ts:314-318`

```ts
const parsed = JSON.parse(info.payload) as {
  event: string;
  data: unknown;
  timestamp: number;
};
```

**Problem:** The cast trusts that the stored payload matches the shape. The
payload is written by `fireWebhookEvent` (`webhooks.ts:77`) via
`JSON.stringify({ event, data, timestamp })`, so today it is safe. But there
is no runtime validation; a future code path that writes a malformed
`payload` (or a manual DB edit) would surface as a cryptic downstream error
in `postWebhook` rather than a clear validation failure. The `event` field
read here is also redundant with `info.event` (which the query already
returned — see the dead-field P3).

**Impact:** Latent fragility; no defense against malformed stored payloads.

**Fix:** Validate with a Convex validator (`v.object({ event: v.string(),
data: v.unknown(), timestamp: v.number() })`) at the boundary, or reuse
`info.event` and drop the parse-for-event.

---

### [SEV: P3] Tests do not cover the SSRF surface — `https:` private IPs, DNS rebinding, redirect-SSRF all untested

**Location:** `convex/webhooks.test.ts:19-46` (`validateWebhookUrl` suite)

**Problem:** The validation suite tests `http://example.com` and
`http://192.168.1.1` are rejected — but only because the scheme is `http:`,
not because the host is private. The cases that actually matter for the P0
are untested:

- `https://192.168.1.1/hook` — would PASS (the bug).
- `https://169.254.169.254/` — would PASS.
- `https://10.0.0.1/`, `https://[::1]`, `https://metadata.google.internal/`.
- Decimal/octal/hex IP encodings.
- Redirect-based SSRF (no test asserts `postWebhook` does not follow
  cross-protocol redirects).

The existing `http://192.168.1.1` assertion gives false confidence that the
private-IP case is handled.

**Impact:** The P0 SSRF has no regression test; a future tightening could be
silently reverted.

**Fix:** Add assertions that the private-IP / metadata / loopback forms are
rejected over both `http:` and `https:`. Add a `postWebhook` test asserting
`redirect: "manual"` (or `"error"`) is set and a 302 to a private http
target is not followed.

---

### [SEV: P3] Tests do not cover retry-state-machine edge cases — concurrency, terminal resurrection, inactive storm, duplicate delivery

**Location:** `convex/webhooks.test.ts:301-521` (`recordDeliveryAttempt` suite)

**Problem:** The state-machine suite covers the three happy/sad paths
(ok / final-failure-with-notification / non-final-failure-stays-pending) but
not the bugs found above:

- No test that a `recordDeliveryAttempt(ok: true)` on an already-`failed`
  delivery is rejected (P1 terminal-state guard).
- No test that concurrent `recordDeliveryAttempt` calls do not double-schedule
  retries (P1 idempotency).
- No test that deactivating an endpoint mid-flight does not generate a
  `webhook_failed` notification (P1 inactive storm).
- No test that a duplicate `deliverWebhook` action run does not double-deliver
  (P1 idempotency).

**Impact:** The most serious correctness bugs in the file have no regression
coverage.

**Fix:** Add tests for each of the above, using `convexTest`'s scheduler
control to simulate duplicate action runs and concurrent mutations.

---

### [SEV: P3] The "non-final failure" test deletes the endpoint to neutralize the scheduled retry rather than asserting the no-op

**Location:** `convex/webhooks.test.ts:435-470`

**Problem:** The test seeds a delivery at `attempts: 0`, calls
`recordDeliveryAttempt(ok: false, error: "timeout")`, asserts `attempts: 1`
/ `status: "pending"` / `lastError: "timeout"`, then *deletes the endpoint*
with the comment "Delete endpoint so scheduled retry action finds no endpoint
→ no cascade". This hides the orphaned-delivery bug (P2): the test
acknowledges a scheduled retry exists but does not assert what happens when
it runs, nor that the orphaned delivery is cleaned up. The final assertion is
merely `expect(endpointId).toBeDefined()` — a tautology.

**Impact:** The orphaned-delivery behavior is untested; the test structure
masks the P2 bug rather than documenting it.

**Fix:** Let the scheduled retry run and assert the delivery reaches a
clean terminal state (cancelled or cleaned up), or assert explicitly that
orphaned rows remain and document that as known behavior pending the fix.

---

## Summary

**Counts:** P0 = 1 · P1 = 9 · P2 = 9 · P3 = 9 · **Total = 28**

The prior review of the sibling `convex/lib/webhookDelivery.ts` found
1 P0 + 3 P1 + 4 P2 + 6 P3 = 14; this deep-dive on `convex/webhooks.ts`
verifies those findings compose (the SSRF guard lives *here* in
`validateWebhookUrl`, not in the lib) and expands the count to 28 by
surfacing the delivery state-machine defects (terminal-state resurrection,
non-idempotent `recordDeliveryAttempt`, inactive-endpoint retry storm, no
`cancelled` status), the missing `deliveryId` propagation that blocks
consumer-side idempotency, the endpoint-lifecycle leaks (orphaned deliveries
on delete, no retention, no secret rotation, secret re-exposed on every
read), and the test-suite gaps that leave the entire SSRF and retry surfaces
unprotected.

**Top 3 to fix first:**

1. **P0 — SSRF via `validateWebhookUrl`.** The `https:` branch accepts every
   private IP and metadata endpoint. Add a private-range blocklist at both
   `upsertEndpoint` and `postWebhook` fetch time; pass `redirect: "manual"`.
   This is the single highest-impact defect in the file.
2. **P1 — Terminal-state guard + idempotent `recordDeliveryAttempt`.** The
   retry state machine has no protection against late/duplicate scheduler
   runs resurrecting `failed` deliveries or double-scheduling retries. Add
   a `delivery.status` check at the top and key the patch on the expected
   prior `attempts`.
3. **P1 — `deliveryId` propagation + inactive-endpoint handling.** Without
   `deliveryId` reaching `postWebhook`, consumers cannot dedupe at-least-once
   deliveries; and the inactive-endpoint branch generates spurious retries
   and `webhook_failed` notifications for intentionally-disabled endpoints.
   Both are quick fixes with outsized correctness payoff.
