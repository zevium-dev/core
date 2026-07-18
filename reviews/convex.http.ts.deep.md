# Tiger Review — `convex/http.ts` (deep-dive: Clerk + Stripe/Polar webhook handlers)

## Verdict

**DO NOT MERGE.** The webhook surface routes real money and PII through a
control flow that returns `200` to the sender **before** the credit grant is
attempted, schedules the actual fulfillment exactly once with **no retry, no
dead-letter, and no redelivery path**, and silently drops Clerk
`user.deleted` events (PII retained forever). Two of the three gateway-gated
routes authenticate a static shared secret with a timing-unsafe string compare
and no replay protection. The settlement ingest validates a field it never
uses and applies numeric bounds too weak to stop ledger abuse. The bones
(svix verify, Stripe `constructEventAsync`, `stripeEventId` dedup, `refId`
idempotency on the ledger) are sound, but the scheduling/retry model around
them is not.

## File Stats

- File: `convex/http.ts` (424 lines)
- Routes reviewed: `/clerk-webhook`, `/stripe-webhook`,
  `/stripe-connect-webhook`, `/stripe-connect-v2-webhook`, `/ingest-usage`,
  `/wallet-grants`
- Cross-read: `convex/billing.ts` (1048 ln), `convex/webhooks.ts`,
  `convex/users.ts`, `convex/organizations.ts`, `convex/lib/auth.ts`,
  `convex/lib/webhookDelivery.ts`, `convex/wallets.ts` (recordUsage /
  grantPaymentCredits / appendWalletEntry), `convex/schema.ts`

## Findings

---

### [P1] Credit-grant delivery is lost on any fulfillment failure: `200`-before-grant + schedule-once + no redelivery path

`convex/http.ts:173-188` (v1), `:238-250` (v2); fulfillment in
`convex/billing.ts:683-728` (`fulfillStripeSession`) and `:870-909`
(`processStripeEvent`).

```ts
const receipt = await ctx.runMutation(internal.billing.receiveStripeEvent, { stripeEventId: event.id, … });
if (receipt.isNew) {
  await ctx.scheduler.runAfter(0, internal.billing.processStripeEvent, { stripeEventId: event.id, … });
}
return new Response(null, { status: 200 });   // ← sender told “done” before the grant runs
```

```ts
// billing.ts — processStripeEvent catch
} catch (error) {
  const message = error instanceof Error ? error.message.slice(0, 240) : "Stripe event processing failed";
  await ctx.runMutation(internal.billing.markStripeEvent, { stripeEventId, status: "failed", error: message });
  throw error;   // ← scheduled action fails; Convex does not retry scheduled fns
}
```

**Problem (three compounding defects):**

1. **`200` before fulfillment.** The HTTP handler acknowledges Stripe the
   instant `processStripeEvent` is *scheduled*, not after it *succeeds*. The
   credit grant (`wallets.grantPaymentCredits`) runs inside the scheduled
   action, after the response is already flushed. Stripe will therefore never
   redeliver, because from its side the delivery succeeded.

2. **Schedule-once gated on `isNew`.** Re-delivery of the same `event.id`
   hits `receiveStripeEvent`, finds the existing row, returns `isNew:false`,
   and the handler **does not reschedule**. So even a manual Stripe resend
   (or the Stripe dashboard “Resend”) cannot recover a failed event — it
   only increments `attempts`.

3. **No retry / no dead-letter.** `processStripeEvent` catches the error,
   marks the row `failed`, and rethrows. Convex does **not** automatically
   retry a thrown scheduled function. There is no `runAfter` backoff, no
   requeue, no DLQ, no alerting hook. The row sits `failed` forever and the
   grant is silently never applied.

**Trigger surface (any of these is enough):**
- A single transient Stripe 5xx during `stripe.checkout.sessions.retrieve`,
  `listLineItems`, or `paymentIntents.retrieve` inside `fulfillStripeSession`
  → `throw` → `failed` → grant lost.
- `getCheckoutIntentForSession` returns `null` (intent row missing during a
  racy replay, or deleted) → `"Unknown Stripe Checkout session"` → permanent
  `failed`.
- `scheduler.runAfter` itself failing *between* `receiveStripeEvent` and
  the schedule call leaves the row `received` with `isNew:true` already
  consumed on the next delivery → never processed.
- Any throw inside `upsertPaidPayment` / `grantPaymentCredits` /
  `markPaymentGrantRecorded` after the payment row is inserted.

**Impact:** Paid customers do not receive credited units; refunds/disputes do
not reverse balances. Money changes hands at Stripe while the wallet ledger
silently diverges. Recovery requires manual DB surgery on `paymentEvents`.
This is the single most dangerous defect in the file — financial data loss
on a transient upstream hiccup.

**Fix:** Do not return `200` until fulfillment is durable. Either (a) run
`processStripeEvent` synchronously in the handler and return non-2xx on
failure so Stripe redelivers (relying on `stripeEventId` dedup for
idempotency), or (b) keep the schedule but make `receiveStripeEvent`
*always* re-arm a retry when the prior attempt failed (e.g. reschedule with
exponential backoff up to N attempts, then a `dead_letter` status that
fires an alert). On Stripe redelivery, if the event is `failed` or
`received`-but-stale, reschedule. Add a cron that scans `paymentEvents` for
`received`/`failed` rows older than X minutes and re-enqueues them.

---

### [P1] Clerk `user.deleted` silently dropped — PII retained forever

`convex/http.ts:57-103` (the `switch` has no `user.deleted` case; everything
not matched falls to `default: break` and returns `200`).

```ts
switch (event.type) {
  case "organization.created":
  case "organization.updated": { … }
  case "organization.deleted": { … }
  case "user.created":
  case "user.updated": { … }
  default:
    break;          // ← user.deleted lands here, returns 200, nothing happens
}
```

`convex/users.ts:8-46` stores `clerkUserId`, `name`, `email` (schema
`convex/schema.ts:16-20` — `users` table has no `deletedAt`/soft-delete
field, no purge mutation exists).

**Problem:** Clerk fires `user.deleted` when a user account is terminated
(GDPR/CCPA deletion request). The handler acknowledges it (`200`) and does
nothing. The `users` row — containing real name + email — is retained
indefinitely. There is no `internal.users.deleteFromClerk` to call even if
a case were added.

**Impact:** Privacy-law violation (right to erasure). PII outlives the
Clerk account. `clerkUserId` also lingers as a join key, so any later
re-creation with the same Clerk id reattaches to the stale PII row.

**Fix:** Add `case "user.deleted":` that calls a new
`internal.users.deleteFromClerk({ clerkUserId })` which deletes (or
redacts — `email=""`, `name="deleted"`) the row, and cascades any
user-scoped data. Do not return `200` until the purge mutation commits.

---

### [P1] Timing-unsafe shared-secret compare on both gateway-gated routes

`convex/http.ts:363` (`/ingest-usage`) and `:401` (`/wallet-grants`).

```ts
const secret = process.env.GATEWAY_INTERNAL_SECRET;
if (secret === undefined || secret.length === 0 ||
    request.headers.get("x-internal-secret") !== secret) {   // ← !== on strings
  return json({ error: "unauthorized" }, 401);
}
```

**Problem:** `!==` on JS strings short-circuits on the first differing
UTF-16 unit. The `x-internal-secret` header value is attacker-supplied and
reachable on the public Convex deployment URL (only the secret is meant to
protect `/ingest-usage`, which debits org wallets, and `/wallet-grants`,
which returns every org’s balance + key settings). A timing side-channel
allows byte-by-byte recovery of `GATEWAY_INTERNAL_SECRET` despite network
jitter (the attacker averages many requests per position).

Worse, once leaked the secret grants **unrestricted wallet draining**: an
attacker can POST forged settlements with arbitrary `consumerClerkOrgId`
and `credits` to debit any org’s balance (`recordUsage` only checks
`balance - credits < 0`, not authenticity of the consumer identity), and can
read any org’s wallet/keySettings via `GET /wallet-grants?clerkOrgId=…`.

**Fix:** Compare HMACs, not raw strings. Compute
`HMAC(secret, receivedHeader)` and `HMAC(secret, secret)` (or
`crypto.subtle` constant-time compare of equal-length buffers). Preferably
harden the channel further with a per-request nonce + timestamp signed by
the secret (see replay finding below).

---

### [P1] Clerk handler mutation errors are uncaught → permanent mirror drift

`convex/http.ts:61-72, 89-99`. None of the `ctx.runMutation` calls are
wrapped in `try/catch`; the `httpAction` propagates any throw as a `500`
with no record of the incoming event.

```ts
await ctx.runMutation(internal.organizations.upsertFromClerk, { clerkOrgId: data.id, name: data.name, slug: data.slug, imageUrl: data.image_url ?? undefined });
```

**Problem:** If the mutation throws for a *permanent* reason (Convex
validator rejection because Clerk changed a field shape — the `event.data`
is cast with `as ClerkOrgEventData` with zero runtime validation; or a
slug uniqueness conflict; or a transaction-size blowup in
`deleteFromClerk`), Clerk retries until its delivery window expires and
then drops the event. There is no persisted raw payload to replay from, so
the org/user mirror silently diverges from Clerk forever.

Contrast: the `verifyStripeWebhook` path *does* catch and translate errors;
the Clerk path does not, and neither path persists the raw event envelope
for replay.

**Impact:** Org metadata, wallet provisioning (`upsertFromClerk` calls
`ensureWallet`), and user PII mirror can fall out of sync with the source of
truth irrecoverably. A malformed `slug` (empty after Clerk side change)
throws inside the validator on every retry until Clerk gives up.

**Fix:** Wrap each mutation in `try/catch`; on failure, persist the raw
event to a `clerkWebhookEvents` table (idempotent on `svix-id`) and return
non-2xx so Clerk retries, with a cron reprocessing stuck rows. At minimum,
`console.error` with `event.type` + `svix-id` for observability (currently
there is zero logging on this route).

---

### [P2] Settlement ingest validates `organizationId` it never uses — dead field, missing cross-check

`convex/http.ts:301-308` (`requiredStrings` includes `event.organizationId`),
`:378-381` (cast + forward); `convex/wallets.ts:337-383` (`recordUsage`).

```ts
// http.ts parseIngestUsageBody — requiredStrings:
[event.organizationId, event.projectId, event.endpoint, event.method,
 event.keyId, event.settleRefId, event.consumerClerkOrgId]
// …then forwarded:
organizationId: event.organizationId as Id<"organizations">,
```

```ts
// wallets.ts recordUsage — the value is never read; consumerOrg._id is used instead:
const clerkOrgId = args.events[0]!.consumerClerkOrgId;
const consumerOrg = await getOrganizationByClerkId(ctx, clerkOrgId);
…
await ctx.db.insert("usageEvents", { organizationId: consumerOrg._id, … });
```

**Problem:** `organizationId` is type-validated (`v.id("organizations")` in
`usageEventArg`) and presence-validated (non-empty string in
`parseIngestUsageBody`), then **thrown away**. The consumer wallet is
resolved exclusively from `consumerClerkOrgId`. A gateway (or anyone with
the leaked internal secret) can submit events where `organizationId`
points to org A while `consumerClerkOrgId` points to org B; the system
silently debits org B and stores the settlement under org B’s id, with the
bogus `organizationId` never flagged. This is a dead validated field that
also *should* have been a defensive cross-check (`event.organizationId ===
consumerOrg._id`).

**Impact:** Defeats defense-in-depth on wallet attribution; makes audit
trails lie (the field exists in the schema/contract but carries no
guarantee). Hardens the impact of the secret-leak scenario above.

**Fix:** Either drop `organizationId` from `IngestUsageEvent` and
`usageEventArg` entirely, or require
`event.organizationId === consumerOrg._id` and reject the batch otherwise.
Do not validate a field whose value is ignored.

---

### [P2] Weak numeric/string bounds in settlement ingest

`convex/http.ts:311-324`.

```ts
if (typeof event.credits !== "number" || !Number.isSafeInteger(event.credits) || event.credits < 0 ||
    typeof event.status !== "number" || !Number.isFinite(event.status) ||
    typeof event.latencyMs !== "number" || !Number.isFinite(event.latencyMs) ||
    typeof event.at !== "number" || !Number.isFinite(event.at)) { … }
```

**Problems:**
- `credits` has **no upper bound** — `Number.MAX_SAFE_INTEGER` passes. A
  single forged event (post secret leak) drains an entire wallet in one
  settlement; even legitimate mis-metering can debit implausible amounts.
  Should be capped to a sane per-call ceiling (and ideally a per-batch sum).
- `status` is only `Number.isFinite` — accepts `3.14`, `-7`, `1e9`. It is
  stored as `v.number()` in `usageEvents` with no HTTP-status semantics.
  Should be `Number.isSafeInteger` and `100 <= status < 600`.
- `latencyMs` accepts negatives and `Infinity`-adjacent floats (only
  `isFinite` guard). Should be `Number.isSafeInteger` and `>= 0`, capped
  (e.g. `< 3_600_000`).
- `at` accepts `0`, negatives, and far-future timestamps — should be an
  integer ms epoch within a reasonable skew window of `Date.now()`
  (e.g. ±5 min) to reject garbage/batched-far-past settlements.
- All string fields (`endpoint`, `method`, `keyId`, `settleRefId`,
  `consumerClerkOrgId`, `organizationId`, `projectId`) have **no length
  limits**. `MAX_INGEST_EVENTS=500` caps count but each string can be
  megabytes → unbounded DB/storage amplification per request.

**Impact:** Ledger abuse surface (under the secret-compromise threat model)
and storage DoS; analytic data quality is unbounded.

**Fix:** Add upper bounds to `credits`; tighten `status`/`latencyMs`/`at`
to integers with semantic ranges; enforce max-length on all string fields
(e.g. `endpoint` ≤ 2048, `keyId`/`settleRefId` ≤ 128, etc.) and reject
oversized bodies before `request.json()`.

---

### [P2] `organization.deleted` cascades incompletely — orphaned projects, payments, usage PII

`convex/http.ts:69-73`; `convex/organizations.ts:104-133` (`deleteFromClerk`).

```ts
case "organization.deleted":
  await ctx.runMutation(internal.organizations.deleteFromClerk, { clerkOrgId: (event.data as ClerkOrgEventData).id });
```
```ts
// deleteFromClerk only touches wallet + walletEntries + org row
const entries = await ctx.db.query("walletEntries").withIndex("by_wallet", …).collect();
for (const entry of entries) await ctx.db.delete(entry._id);
await ctx.db.delete(wallet._id);
await ctx.db.delete(existing._id);
```

**Problem:** When Clerk deletes an org, the handler deletes the wallet, its
ledger entries, and the org row — and **nothing else**. Orphaned:
`projects`, `keySettings`, `usageEvents` (contains `endpoint`, `method`,
`keyId` — per-call PII), `payments`, `organizationPayments`, `checkoutIntents`,
`webhookEndpoints`, `webhookDeliveries`, `publisherEarnings` (if any). The
org is “gone” but its financial history and call logs persist under dangling
`organizationId` foreign keys.

**Impact:** Privacy retention beyond the org’s lifetime; data integrity
decay (dangling references); if the Clerk org id is later reused,
historical data re-attaches to a different tenant.

**Fix:** Either cascade-delete (batched, given Convex transaction limits)
or soft-delete the org (`deletedAt`) and quarantine its dependent rows.
At minimum purge `usageEvents`/`keySettings` PII.

---

### [P2] Stripe v2 webhook `400`s on events lacking `related_object.id` → permanent loss

`convex/http.ts:225-236`.

```ts
const objectId = "related_object" in event ? event.related_object?.id : undefined;
if (typeof objectId !== "string" || objectId.length === 0) {
  return new Response("Unsupported Stripe event object", { status: 400 });
}
```

**Problem:** Not every Stripe v2 `EventNotification` carries a
`related_object.id`. Any valid event of a type the handler doesn’t care
about (but Stripe still sends) returns `400`. Stripe treats `4xx` as a
**permanent** delivery failure and stops retrying — the event is lost. If
that event later matters (or if the set of “interesting” v2 types grows),
there is no recovery.

**Impact:** Silent, irreversible event loss for a class of v2 notifications.

**Fix:** Return `200` for events you choose to ignore (log + `markStripeEvent`
`ignored`), and only `400` for structurally invalid payloads. Reserve `400`
for “this could not be parsed as a Stripe event at all”, not “we don’t
recognize the object”.

---

### [P2] No replay protection on internal gateway routes

`convex/http.ts:357-366` (`/ingest-usage`), `:395-404` (`/wallet-grants`).

**Problem:** The internal-secret routes accept any request bearing the
shared secret with no timestamp, nonce, or sequence. A captured request can
be replayed indefinitely. Mitigations exist downstream (`settleRefId` dedup
→ `already_applied` for settlements; GET is read-only) but they are
incidental, not enforced at the auth layer. Combined with the timing-unsafe
compare (P1 above), an attacker who recovers the secret can replay forged
settlement batches to drain wallets at will — the dedup only blocks
identical `settleRefId` reuse, not new forged refIds.

**Fix:** Require a signed request envelope: `X-Internal-Timestamp` +
`X-Internal-Nonce` + `X-Internal-Signature = HMAC(secret, timestamp|nonce|body)`,
reject timestamps outside a ±5 min skew, and (optionally) cache nonces.

---

### [P2] No payload-size limit on webhook bodies

`convex/http.ts:151` (`await request.text()` for Stripe), `:361`
(`await request.json()` for ingest), `:50` (`await request.text()` for
Clerk).

**Problem:** None of the handlers enforce a `Content-Length` ceiling before
consuming the body. The ingest route caps *event count* at 500 but not
per-event field length, so a single request can carry arbitrarily large
strings. Stripe/Clerk bodies are normally small, but there is no defense
against a malformed or hostile sender.

**Impact:** Memory/parse amplification; potential to exceed Convex request
limits mid-parse with an opaque error.

**Fix:** Read `Content-Length`, reject > e.g. 1 MB for Stripe/Clerk and >
e.g. 2 MB for ingest before parsing; enforce per-field length caps in
`parseIngestUsageBody`.

---

### [P3] Stripe v1 route `400`s when `data.object` lacks a string `id`

`convex/http.ts:165-168`.

```ts
if (!("id" in event.data.object) || typeof event.data.object.id !== "string") {
  return new Response("Unsupported Stripe event object", { status: 400 });
}
```

**Problem:** Same permanent-loss pattern as the v2 finding. A valid event
whose `data.object` legitimately lacks an `id` (rare but possible for some
event types) returns `400` and is dropped by Stripe. The handler has no
`default: ignore` path for v1 event types it doesn’t care about — every
event must yield a usable `objectId`.

**Fix:** Return `200` + `ignored` for event types you don’t process; only
`400` for unparseable payloads.

---

### [P3] Clerk payload shape is `as`-cast with zero runtime validation

`convex/http.ts:60, 71, 76-88`.

```ts
const data = event.data as ClerkOrgEventData;
…
await ctx.runMutation(internal.organizations.upsertFromClerk, { clerkOrgId: data.id, name: data.name, slug: data.slug, … });
```

**Problem:** `event.data` is typed as
`ClerkUserEventData | ClerkOrgEventData | Record<string, unknown>` but cast
blindly per case. If Clerk ships a payload where `data.id` is `undefined`
(e.g. a schema change, or a delegated/admin event with a different shape),
`clerkOrgId: undefined` reaches the `v.string()` validator, the mutation
throws, the httpAction returns `500`, Clerk retries until it drops the event
(P1 above). `slug`/`name` emptiness is similarly unguarded.

**Fix:** Validate the per-case payload with a `v.object({...})` validator
(or `zod`) before dispatch; reject and `200`-ack malformed events with a log
rather than throwing into the validator.

---

### [P3] Stripe v2 verification failures silently swallowed in secret loop

`convex/http.ts:222-228`.

```ts
for (const secret of secrets) {
  try { event = await stripeClient().parseEventNotificationAsync(rawBody, signature, secret); break; }
  catch { /* Try the next configured destination secret. */ }
}
if (event === null) return new Response("Invalid Stripe signature", { status: 400 });
```

**Problem:** Every verification error — including non-signature errors
(malformed payload, parse failure, SDK bug) — is swallowed identically. The
final `400` gives no signal. If the real problem is a malformed body rather
than a wrong secret, the operator sees nothing.

**Fix:** Distinguish signature-mismatch from parse/SDK errors; log the last
error message (never the secret) before returning `400`.

---

### [P3] `deleteFromClerk` collect-then-loop can exceed Convex transaction limits

`convex/organizations.ts:112-124` (called from `http.ts:69-72`).

```ts
const entries = await ctx.db.query("walletEntries").withIndex("by_wallet", …).collect();
for (const entry of entries) await ctx.db.delete(entry._id);
```

**Problem:** `.collect()` with no `take()` bound loads every wallet entry
into one transaction and deletes them sequentially. A high-volume org
(thousands of ledger entries) will blow the Convex transaction size/time
budget, the mutation throws, the Clerk `organization.deleted` event is
retried until dropped (see P1), and the org is never deleted.

**Fix:** Batch/paginate deletes, or soft-delete the org and purge entries
asynchronously via a scheduled job.

---

### [P3] `getGatewayWallet` accepts arbitrary `clerkOrgId` with no audit trail

`convex/http.ts:413-424`, `convex/wallets.ts:233-256`.

**Problem:** `GET /wallet-grants?clerkOrgId=<any>` returns the wallet
balance + keySettings for any org given the shared secret. This is by
design (the gateway needs cross-org reads), but there is no audit log of
which orgs were queried. If the secret leaks, mass exfiltration is silent.

**Fix:** Log each query (`{ actor: "gateway", clerkOrgId, ts }`) to an audit
table; consider per-org scoping if the gateway doesn’t truly need
cross-org reads.

---

### [P3] `paymentEvents.attempts` grows unbounded under redelivery storm

`convex/billing.ts:339-357` (`receiveStripeEvent` increments `attempts` on
every duplicate receipt, called from `http.ts:173-188`/`:238-243`).

**Problem:** A broken Stripe endpoint or a replay attacker resending the
same event grows `attempts` without bound. No cap, no alert at a threshold.

**Fix:** Cap attempts; alert on redelivery count > N.

---

## Summary

- **P0:** 0
- **P1:** 4
- **P2:** 5
- **P3:** 6
- **Total findings:** 15

**Top 3 to fix before any deploy:**

1. **Lost credit-grant on transient fulfillment failure** (P1) — `200`-before-grant
   + schedule-once + no retry/DLQ + `isNew:false` blocks redelivery. Money
   moves at Stripe while the wallet ledger silently diverges. This is the
   financial-data-loss sinkhole at the center of this file.
2. **Clerk `user.deleted` silently dropped** (P1) — PII (name + email) is
   retained forever in the `users` table; add a purge case + mutation.
3. **Timing-unsafe shared-secret compare on `/ingest-usage` + `/wallet-grants`**
   (P1) — a `!==` string compare protects the route that can drain any org’s
   wallet and read every org’s keys. Switch to constant-time HMAC compare
   and add replay protection.
