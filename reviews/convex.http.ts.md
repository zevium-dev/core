# Tiger-Style Review — `convex/http.ts`

The Convex HTTP router is the unauthenticated ingress: Clerk (Svix), Stripe V1
(2 routes), Stripe V2, the gateway's `GATEWAY_INTERNAL_SECRET`-gated settlement
ingest, and the wallet-grants checkpoint. Every line below is a problem.

---

## Verdict

**Incorrect.** The router ships with a timing-unsafe secret comparison on its
internal-auth gates, drops `user.deleted` events (PII retained forever), leaks
raw internal errors back to webhook senders on every mutation failure, and
carries a dead validated input field through the settlement path. None are
catastrophic in isolation; collectively the ingress boundary is weaker than the
rest of the codebase assumes.

---

## File Stats

- File: `convex/http.ts` (424 lines)
- Routes: 6 (`/clerk-webhook`, `/stripe-webhook`, `/stripe-connect-webhook`,
  `/stripe-connect-v2-webhook`, `/ingest-usage`, `/wallet-grants`)
- Unauthenticated ingress: all 6
- Findings: 13 — P0: 0, P1: 0, P2: 4, P3: 9

---

## Findings

### [SEV: P2] Timing-unsafe comparison of `GATEWAY_INTERNAL_SECRET`

**Location:** `convex/http.ts:359-363` (`/ingest-usage`), `convex/http.ts:397-401`
(`/wallet-grants`)

```ts
const secret = process.env.GATEWAY_INTERNAL_SECRET;
if (
  secret === undefined ||
  secret.length === 0 ||
  request.headers.get("x-internal-secret") !== secret
) {
  return json({ error: "unauthorized" }, 401);
}
```

**Problem:** `!==` on two strings short-circuits on the first mismatched byte.
The Convex HTTP deployment URL is public; an attacker who can reach it can
measure response time across crafted `x-internal-secret` values to recover the
secret byte-by-byte. Both internal routes (settlement ingest, wallet
checkpoint including key settings) are gated only by this comparison. The
codebase already uses `crypto.subtle` HMAC elsewhere (`convex/lib/webhookDelivery.ts:30`);
the same primitive should gate ingress.

**Impact:** Secret recovery → arbitrary credit settlement writes
(`recordUsage`) and full wallet/key-setting read access for every org.

**Fix:** constant-time compare (WebCrypto, available in Convex actions):
```ts
async function ctSecretEqual(provided: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
```
Then `if (secret === undefined || secret.length === 0 || !(await ctSecretEqual(request.headers.get("x-internal-secret") ?? "", secret)))`.

---

### [SEV: P2] Clerk `user.deleted` silently dropped — PII retained indefinitely

**Location:** `convex/http.ts:51` switch, `convex/http.ts:87-96` (`user.created`
/ `user.updated` only)

```ts
switch (event.type) {
  case "organization.created":
  case "organization.updated": { ... }
  case "organization.deleted": ...
  case "user.created":
  case "user.updated": { ... }
  default:
    break;          // user.deleted lands here → 200, no-op
}
```

**Problem:** Clerk emits `user.deleted` on account deletion. There is no case
for it, and `convex/users.ts` exposes no `deleteFromClerk` mutation (grep
confirms only `upsertFromClerk` + `ensureUser`). So a deleted Clerk user's row
in `users` (name, email) persists forever. Orgs get `deleteFromClerk`
(cascades wallet + walletEntries), users get nothing.

**Impact:** PII retention past account deletion (GDPR/CCPA exposure); the org
delete path proves the project knows how to cascade — users were missed.

**Fix:** add `user.deleted` case + a `users.deleteFromClerk` internal mutation
that takes `clerkUserId` and deletes the row (and any user-scoped data).

---

### [SEV: P2] Clerk webhook mutation failures are uncaught — leaks errors, causes indefinite retry

**Location:** `convex/http.ts:58-65`, `convex/http.ts:68-70`, `convex/http.ts:88-96`

```ts
const data = event.data as ClerkOrgEventData;
await ctx.runMutation(internal.organizations.upsertFromClerk, {
  clerkOrgId: data.id,
  name: data.name,
  slug: data.slug,                 // undefined if Clerk shape changes → Convex throws
  imageUrl: data.image_url ?? undefined,
});
```

**Problem:** None of the three `ctx.runMutation` calls in the Clerk handler are
wrapped in try/catch. The Svix `verify` is wrapped (line 44-49), but the
mutation is not. If `upsertFromClerk` / `deleteFromClerk` / `users.upsertFromClerk`
throws — arg-validation failure (`slug` undefined → "Argument 'slug' is not of
type 'string'"), a Convex transient, or a future unique-index conflict — the
uncaught error propagates out of the httpAction. Convex returns the raw error
message in a 500 body to Clerk, which then retries the same event. Permanent
failures retry until Clerk's retry budget is exhausted, at which point the org/
user sync is silently lost.

**Impact:** Internal error strings (table names, validator messages, constraint
names) leak to the webhook sender; permanent mutation failures produce infinite
retry then data loss.

**Fix:** wrap each `runMutation` in try/catch; return 400 for permanent
(payload-shape) failures (no retry) and 500 only for transient failures; never
surface the raw `error.message` — log it, return `"webhook handler error"`.

---

### [SEV: P2] Stripe webhook `receiveStripeEvent` / scheduler errors uncaught — leaks to Stripe

**Location:** `convex/http.ts:173-184` (`stripeWebhookRoute`),
`convex/http.ts:235-248` (`/stripe-connect-v2-webhook`)

```ts
const receipt = await ctx.runMutation(internal.billing.receiveStripeEvent, {
  stripeEventId: event.id,
  stripeAccount,
  eventType: event.type,
  objectId,
});
if (receipt.isNew) {
  await ctx.scheduler.runAfter(0, internal.billing.processStripeEvent, { ... });
}
return new Response(null, { status: 200 });
```

**Problem:** `verifyStripeWebhook` is wrapped (line 146-157), but the
`receiveStripeEvent` mutation and the `runAfter` scheduling are not. If
`receiveStripeEvent` throws (Convex transient, future arg-validator tightening,
DB error), the raw error message goes back to Stripe in a 500 body. Stripe
retries; on a permanent failure the payment event is eventually dropped — and
with it the credit grant for a paid checkout.

**Impact:** Internal error leakage to Stripe; permanent mutation failures risk
lost `checkout.session.completed` delivery → lost credit grant for a paying
customer.

**Fix:** wrap the mutation+scheduling in try/catch; return a generic 500 body
(`"webhook processing error"`) and log internally; reserve 400 for
signature/shape problems only.

---

### [SEV: P3] `organizationId` field in `IngestUsageEvent` is validated then discarded

**Location:** `convex/http.ts:222` (type), `convex/http.ts:268-273`
(`requiredStrings`), `convex/http.ts:374-378` (cast as `Id<"organizations">`)

```ts
type IngestUsageEvent = {
  organizationId: string;     // …validated, cast, never read
  projectId: string;
  ...
};

// parseIngestUsageBody forces it to be a non-empty string:
const requiredStrings = [
  event.organizationId,        // ← validated
  event.projectId,
  ...
];

// route handler casts and forwards:
events: parsed.events.map((event) => ({
  ...event,
  organizationId: event.organizationId as Id<"organizations">,
  projectId: event.projectId as Id<"projects">,
})),
```

**Problem:** `convex/wallets.ts:317` (`usageEventArg`) declares
`organizationId: v.id("organizations")`, so Convex rejects the request unless
the gateway sends a syntactically valid org ID — and then
`recordUsage` (`convex/wallets.ts:396`) ignores `event.organizationId`
entirely, deriving the consumer org from `consumerClerkOrgId`:
`organizationId: consumerOrg._id`. The gateway is forced to send a valid
Convex org ID that is never used; a stale/wrong value silently passes.

**Impact:** Dead validated input. Masks gateway bugs (wrong org ID accepted),
blocks valid settlements if the gateway doesn't know the publisher's Convex
ID, and contradicts the docstring "one-wallet settlement batch" contract.

**Fix:** remove `organizationId` from `IngestUsageEvent`, `usageEventArg`, and
`parseIngestUsageBody`'s required-strings list; or use it where the consumer
org is currently derived.

---

### [SEV: P3] `parseIngestUsageBody` accepts non-integer `status`, negative `latencyMs` / `at`

**Location:** `convex/http.ts:300-313`

```ts
if (
  typeof event.credits !== "number" ||
  !Number.isSafeInteger(event.credits) ||
  event.credits < 0 ||
  typeof event.status !== "number" ||
  !Number.isFinite(event.status) ||      // 200.5, -1, Infinity all pass
  typeof event.latencyMs !== "number" ||
  !Number.isFinite(event.latencyMs) ||   // -500, NaN→no (NaN fails), -1 ok
  typeof event.at !== "number" ||
  !Number.isFinite(event.at)              // negative epoch, far-future ok
) { ... }
```

**Problem:** `credits` is correctly bounded (`Number.isSafeInteger` + `>= 0`),
but `status` is only `Number.isFinite` (accepts `200.5`, `-1`, `1e308`),
`latencyMs` admits negatives, and `at` admits negative or far-future epochs.
These flow into `usageEvents` rows unclamped. The downstream
`recordUsage` re-validates with the same weak `Number.isFinite` checks
(`convex/wallets.ts:355-360`), so the garbage propagates to the ledger.

**Impact:** Polluted usage analytics; HTTP status is semantically an integer
code and `latencyMs < 0` is nonsensical. Auth-gated, so low blast radius.

**Fix:** `Number.isSafeInteger(event.status)` with a sane HTTP range
(`>= 100 && < 600`), `event.latencyMs >= 0`, `event.at` bounded to a reasonable
epoch window (e.g. `> 0` and within ±1 day of `Date.now()`).

---

### [SEV: P3] No payload size limit on any webhook route

**Location:** `convex/http.ts:45` (`await request.text()` for Clerk),
`convex/http.ts:144` (Stripe V1), `convex/http.ts:217` (Stripe V2),
`convex/http.ts:364` (`await request.json()` for ingest)

**Problem:** Every route reads the entire body into memory before verification.
`parseIngestUsageBody` caps *event count* at 500 but not byte size — each event
can carry multi-MB strings. Convex has a deployment-level body cap, but it is
generous; a signed-but-large Stripe payload or a valid-internal-secret ingest
can OOM the action.

**Impact:** DoS / cost amplifier via oversized signed payloads.

**Fix:** read body with a `Content-Length` guard and/or stream-cap; reject
`> 256 KB` for Stripe/Clerk, `> 1 MB` for ingest, before parsing.

---

### [SEV: P3] `parseIngestUsageBody` accepts unbounded string field lengths

**Location:** `convex/http.ts:283-293`

```ts
if (
  requiredStrings.some(
    (value) => typeof value !== "string" || value.trim() === "",
  )
) { ... }
```

**Problem:** `endpoint`, `method`, `keyId`, `settleRefId`,
`consumerClerkOrgId` are checked for non-emptiness only. A 1 MB `endpoint`
string passes and is persisted into `usageEvents` (`convex/wallets.ts:402-410`).
Auth-gated, but if the secret leaks (see P2 timing finding) this is a cheap
storage blowup.

**Fix:** cap each string (e.g. `value.length > 1024` → reject) before
forwarding.

---

### [SEV: P3] Clerk webhook unknown event types silently dropped

**Location:** `convex/http.ts:99-101`

```ts
default:
  break;
}
return new Response(null, { status: 200 });
```

**Problem:** Returning 200 for unknown event types is correct (don't retry),
but the drop is silent — no `console.warn`. When Clerk adds a new event
type (e.g. `organization.domain_verification.*`, `session.revoked`), the
handler accepts it and discards it with zero observability. The Stripe side
at least records `ignored` events (`convex/billing.ts` `markStripeEvent`); the
Clerk side has nothing.

**Impact:** New Clerk event types go unhandled indefinitely with no signal.

**Fix:** `console.warn("clerk webhook: unhandled event type", { type: event.type })`
in the default branch.

---

### [SEV: P3] `/stripe-connect-v2-webhook` swallows all errors in the secret loop

**Location:** `convex/http.ts:219-227`

```ts
for (const secret of secrets) {
  try {
    event = await stripeClient().parseEventNotificationAsync(
      rawBody, signature, secret,
    );
    break;
  } catch {
    // Try the next configured destination secret.
  }
}
if (event === null) {
  return new Response("Invalid Stripe signature", { status: 400 });
}
```

**Problem:** The catch absorbs every error — not just signature mismatch but
malformed-payload errors, network errors, SDK bugs. If the first secret is
correct and the payload is malformed, the real error is discarded and the
second secret is tried (also failing), then a misleading "Invalid Stripe
signature" 400 is returned. Stripe does not retry on 400, so the event is
lost with no diagnostic trail.

**Impact:** Malformed V2 events are silently attributed to "bad signature" and
dropped; debugging impossible.

**Fix:** catch only the expected signature-error type (or re-throw non-signature
errors); `console.error` each attempt with the failure class; return 400 only
when all secrets genuinely failed signature verification.

---

### [SEV: P3] `verifyStripeWebhook` status mapping depends on exact error-string match

**Location:** `convex/http.ts:152-157`

```ts
} catch (error) {
  const message = error instanceof Error ? error.message : "Invalid Stripe signature";
  console.error("stripe webhook verification failed", { path, message });
  const status = message === "Webhook secret is not configured" ? 503 : 400;
  return new Response(
    status === 503 ? message : "Invalid Stripe signature",
    { status },
  );
}
```

**Problem:** The 503-vs-400 decision keys off `message === "Webhook secret is
not configured"`. If anyone edits that error string in `verifyStripeWebhook`
(line 124), the misconfiguration silently degrades to 400 — Stripe stops
retrying and the event is lost instead of alerting that the deployment is
misconfigured. Also returns the raw `message` ("Webhook secret is not
configured") in the 503 body, a minor internal-detail leak.

**Fix:** have `verifyStripeWebhook` throw a typed error (`class
WebhookMisconfigured`) and `instanceof`-check it; return a generic body in both
branches.

---

### [SEV: P3] Stripe V1 connect route defaults `event.account` to `"platform"`

**Location:** `convex/http.ts:167`

```ts
const stripeAccount =
  typeof event.account === "string" ? event.account : "platform";
```

**Problem:** For `/stripe-connect-webhook`, `event.account` is the connected
account ID. When it's absent (malformed/unexpected event), defaulting to
`"platform"` is not neutral: `processStripeEvent`'s `payout.*` branch uses
`args.stripeAccount` to decide whether to pass `{ stripeAccount }` to
`stripe.payouts.retrieve` (`convex/billing.ts:862-866`) and stores it as
`stripeConnectedAccountId` (`convex/billing.ts:868`). A misrouted or malformed
connect event thus retrieves the payout under the platform key (wrong context,
likely fails or returns wrong data) and persists `"platform"` as the connected
account ID.

**Impact:** Misattributed payout records for any connect event missing
`event.account`; silent corruption rather than a clean rejection.

**Fix:** when `event.account` is not a string on a connect route, return 400
and let Stripe retry with a well-formed event.

---

### [SEV: P3] Clerk `event.data` cast to typed shapes with no runtime validation

**Location:** `convex/http.ts:56` (`as ClerkOrgEventData`), `convex/http.ts:69`
(`as ClerkOrgEventData`), `convex/http.ts:71` (`as ClerkOrgEventData` again),
`convex/http.ts:89` (`as ClerkUserEventData`)

```ts
const data = event.data as ClerkOrgEventData;
await ctx.runMutation(internal.organizations.upsertFromClerk, {
  clerkOrgId: data.id,            // undefined → Convex validator throws
  name: data.name,               // undefined → throws
  slug: data.slug,               // undefined → throws
  imageUrl: data.image_url ?? undefined,
});
```

**Problem:** Svix `verify` only checks signature + timestamp — it does not
validate payload shape. `event.data` is typed as a union
(`ClerkUserEventData | ClerkOrgEventData | Record<string, unknown>`) but the
case branches cast unconditionally. If Clerk ever ships a payload where `slug`
or `name` is `null`/absent (or if a `user.*` payload is misrouted into an
`organization.*` case by a future maintainer), the Convex arg validator throws
"Argument 'X' is not of type 'string'" — which is the uncaught-leak path
flagged in the P2 finding above. The `email` derivation for users already
defends against missing emails; the org path does not defend against missing
`slug`/`name`.

**Impact:** Fragile coupling to Clerk's exact payload shape; any drift surfaces
as a leaked validator error + infinite retry.

**Fix:** validate with `zod` (or hand-rolled guards) before dispatch; reject
shape violations with 400 (no retry) rather than letting the Convex validator
throw a 500.

---

## Summary

**Counts:** P0: 0 · P1: 0 · **P2: 4** · P3: 9 · Total: 13

**Top 3:**

1. **Timing-unsafe `GATEWAY_INTERNAL_SECRET` compare** (P2) — the entire
   internal-auth gate for settlement writes and wallet/key-setting reads is
   a short-circuiting `!==`. Replace with constant-time compare.
2. **Clerk `user.deleted` dropped + mutation errors uncaught** (P2 × 2) — PII
   retained forever, and any mutation failure leaks the raw error to Clerk and
   retries until the sync is lost.
3. **Stripe `receiveStripeEvent` errors uncaught** (P2) — internal errors leak
   to Stripe; permanent failures risk dropping a paid-checkout event and its
   credit grant.

**Cross-cutting note:** signature verification itself (Svix + Stripe
`constructEventAsync` / `parseEventNotificationAsync`) is correctly fed raw
bodies and inherits timestamp-replay protection from the SDKs — that part is
not the weakness. The weakness is everything *after* verification: error
handling, the internal-secret gate, and dead/weak input validation.
