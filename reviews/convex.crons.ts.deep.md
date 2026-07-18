# Tiger Review — `convex/crons.ts` + `convex/cronTasks.ts` (deep)

Files reviewed together: `convex/crons.ts`, `convex/cronTasks.ts`, plus
`convex/wallets.ts`, `convex/usage.ts`, `convex/webhooks.ts`,
`convex/earnings.ts`, `convex/payouts.ts`, `convex/lib/webhookDelivery.ts`,
`convex/lib/notifications.ts`, and `convex/schema.ts` (for index shapes).
Callers grepped: `releaseMatureEarnings`, `checkLowBalances`,
`initiatePublisherTransfer`, `fireWebhookEvent`, `recordDeliveryAttempt`.

---

## Verdict

**Unfit to ship as the cron backbone of a money-moving system.** The entire
scheduled-task surface is one hourly mutation that (a) is scheduled at the
wrong cadence for its own idempotency key, (b) has no per-org error isolation,
(c) does an unbounded full-table scan + N+1 reads, and (d) returns a value no
one logs. The publisher payout side is worse: `releaseMatureEarnings` exists,
has a purpose-built `by_status_available` index, and is wired to *nothing*
scheduled — mature earnings sit in `pending_risk` until a human clicks
"transfer", and the `available` balance reported by `getPayoutState` is
consequently always 0 until that click. The webhook retry state machine has no
terminal-state guard and the delivery action is not idempotent, so Convex's
at-least-once action re-execution can double-POST endpoints, double-count
attempts, and flip a delivered-`ok` row back to `failed`. No praise. Below.

---

## File Stats

| File | LOC | Crons | Internal fns | Scheduled callers |
|---|---|---|---|---|
| `convex/crons.ts` | 12 | 1 (`hourly`) | `cronTasks.checkLowBalances` | only `crons.hourly` |
| `convex/cronTasks.ts` | 48 | — | `checkLowBalances` | invoked by `crons.ts` |
| `convex/webhooks.ts` | 330 | — | `fireWebhookEvent`, `recordDeliveryAttempt`, `deliverWebhook` | `specs.publish`, `specs.deprecateVersion`, `admin.setProjectVisibility`, self-retry |
| `convex/payouts.ts` | 754 | — | `releaseMatureEarnings`, `preparePublisherTransfer`, … | only `initiatePublisherTransfer` (user action) |

Scheduled background work for the whole backend = **one hourly tick**. There
is no daily/hourly sweep for mature earnings, no stuck-delivery reaper, no
wallet/DO reconciliation, no stale-notification cleanup.

---

## Findings

### [P1] `releaseMatureEarnings` is not wired to any cron — mature earnings orphaned, `available` reporting permanently wrong

`payouts.ts:296` defines `releaseMatureEarnings`, which flips
`publisherEarnings.status` `pending_risk → available` once
`availableAt <= now`. Grep confirms the **only** caller is
`initiatePublisherTransfer` (`payouts.ts:620`), a user-triggered `action`
behind `requireActiveClerkOrgInAction`. There is no cron entry in `crons.ts`.

```ts
// crons.ts — the entire scheduled surface
crons.hourly("low-balance-check", { minuteUTC: 0 },
  internal.cronTasks.checkLowBalances);
```

```ts
// payouts.ts:296 — only called from a human action, never scheduled
export const releaseMatureEarnings = internalMutation({
  args: { publisherOrganizationId: v.id("organizations") },
  handler: async (ctx, args): Promise<void> => {
    const now = Date.now();
    const pending = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", args.publisherOrganizationId))
      .filter((q) => q.eq(q.field("status"), "pending_risk"))
      .collect();
    for (const earning of pending) {
      if (earning.availableAt <= now) {
        await ctx.db.patch(earning._id, { status: "available", updatedAt: now });
      }
    }
  },
});
```

**Impact.** Two compounding failures:

1. **Orphaned mature earnings.** A publisher who never proactively opens
   `/app/earnings` and clicks "transfer" has every `publisherEarning` row
   frozen in `pending_risk` indefinitely — even after `availableAt` (now +
   `PUBLISHER_RISK_HOLD_MS`) has long passed. The risk hold has effectively no
   expiry for inactive publishers.
2. **Wrong reporting.** `getPayoutState` (`payouts.ts:665`) computes
   `totals.available` by summing `earning.netCredits` where
   `status === "available"`. Since nothing flips the status without a human
   action, **`available` is structurally always 0** in the UI until the
   publisher initiates a transfer. The earnings *exist* but are invisible to
   the statement the publisher sees. This is a money-transparency bug, not a
   cosmetic one.

**Fix.** Add a cron that sweeps globally, not per-org:

```ts
crons.daily("release-mature-earnings", { hourUTC: 0, minuteUTC: 5 },
  internal.cronTasks.releaseMatureEarnings);
```

and make `releaseMatureEarnings` take no `publisherOrganizationId`, scanning
the `by_status_available` index (see next finding) for
`status === "pending_risk" && availableAt <= now` in a bounded paginated
loop. Daily is sufficient; the risk-hold is hours-to-days, not minutes.

---

### [P1] `releaseMatureEarnings` ignores the purpose-built `by_status_available` index

`schema.ts:302`:

```ts
.index("by_status_available", ["status", "availableAt"]),
```

This index was created *specifically* to answer "find `pending_risk` rows
whose `availableAt <= now`". `releaseMatureEarnings` does not use it:

```ts
const pending = await ctx.db
  .query("publisherEarnings")
  .withIndex("by_publisher", (q) =>
    q.eq("publisherOrganizationId", args.publisherOrganizationId))
  .filter((q) => q.eq(q.field("status"), "pending_risk"))   // post-filter
  .collect();
for (const earning of pending) {
  if (earning.availableAt <= now) { … }                      // in-memory filter
}
```

It scans **every** `publisherEarning` row for the org via `by_publisher`, then
post-filters `status === "pending_risk"` in Convex's filter pipeline, then
filters `availableAt <= now` in JS. For an org with 100k settled calls, that's
100k rows loaded to find the ~handful that are still in risk hold. The index
that would make this O(mature) is sitting unused.

**Impact.** The per-org call from `initiatePublisherTransfer` is needlessly
O(all-time earnings for org) instead of O(currently-held earnings). If/when a
global cron is added per the previous finding, doing it per-org in a loop
would be O(orgs × lifetime-earnings) — catastrophic.

**Fix.**

```ts
const mature = await ctx.db
  .query("publisherEarnings")
  .withIndex("by_status_available", (q) =>
    q.eq("status", "pending_risk").lt("availableAt", now))
  .take(BATCH);
```

---

### [P1] No per-org error boundary in `checkLowBalances` — one throwing org blocks every org created after it, every tick

`cronTasks.ts:20-46`:

```ts
const wallets = await ctx.db.query("wallets").collect();
let notified = 0;
for (const wallet of wallets) {
  if (wallet.balance >= LOW_BALANCE_THRESHOLD) continue;
  const org = await ctx.db.get(wallet.organizationId);
  if (org === null) continue;
  const refId = `low_balance:${org.clerkOrgId}:${dayKey}`;
  const result = await createNotification(ctx, { …, refId });
  if (result.created) notified += 1;
}
return { notified };
```

`wallets.collect()` returns rows in table order (by `_creationTime`/`_id`).
The loop is fully sequential with no `try/catch`. If iteration `i` throws —
e.g. `createNotification`'s `unique()` throwing on a duplicate `refId` (see
separate finding), a transient Convex error, a `db.get` on a malformed id, or
any future code added inside the loop — the mutation aborts at org `i` and
**orgs `i+1..N` are never visited on this tick**. Because the same
deterministically-bad org throws at the same position on every hourly retry,
every subsequent tick also aborts at the same org. Net effect: all orgs
created *after* the bad org are permanently un-notified, on every tick, until
the bad org is manually fixed or deleted.

Convex crons do re-run the next hour, so it is not "stuck forever after one
throw" — but it *is* "stuck at the same break point every hour for the rest of
the day", and the 23 wasted hourly retries (see next finding) all abort at the
same org.

**Impact.** A single corrupt row or duplicate `refId` silently disables
low-balance alerts for every newer org in the system. No alarm fires; the
cron's `notified` count just drops.

**Fix.** Wrap each iteration in `try/catch`, continue on error, and accumulate
a `failed` count. Better: collect all `organizationId`s first, then process
in bounded batches via `ctx.scheduler.runAfter(0, …)` per batch so one bad
batch cannot abort the others.

---

### [P1] `checkLowBalances` hourly cadence with day-scoped `refId` wastes 23/24 ticks and defeats the stated intent

`crons.ts:5`:

```ts
/** Hourly low-balance check — one notification per org per UTC day. */
crons.hourly("low-balance-check", { minuteUTC: 0 },
  internal.cronTasks.checkLowBalances);
```

`cronTasks.ts:30`:

```ts
const dayKey = new Date(utcDay).toISOString().slice(0, 10); // YYYY-MM-DD
const refId = `low_balance:${org.clerkOrgId}:${dayKey}`;
```

The `refId` is scoped to the UTC *day*, and `createNotification` is idempotent
on `refId`. So within a single UTC day, **only the first hourly tick can ever
create a notification**; ticks 2–24 hit the `by_ref` `unique()` lookup, find
the existing row, and return `{ created: false }`. Each of those 23 wasted
ticks still performs:

- `wallets.collect()` — full table scan
- N × `ctx.db.get(wallet.organizationId)` — N+1 reads
- N × `createNotification` → `notifications.by_ref` `unique()` query

For N=1000 orgs that is ~46,000 wasted reads/day against the Convex bill, with
zero behavioral delta. The doc-comment's stated intent — "catch low balances
that develop during the day" — is *not* met: if a wallet is topped up at 00:30
and drops again at 12:00, **no** new notification fires because the day's
`refId` is already consumed. The hourly cadence is pure cost with no upside
over a single daily tick.

**Impact.** 24× the Convex read cost of a correct daily cron, for identical
user-visible behavior — actually *worse* behavior, since within-day re-drops
are silently suppressed by the day-scoped key.

**Fix.** Either:
- `crons.daily("low-balance-check", { hourUTC: 0, minuteUTC: 0 }, …)` and
  accept once-per-day notification, or
- keep hourly but make the `refId` hour-scoped (`dayKey:HH`) if within-day
  re-notification is actually desired.

Do not ship hourly + day-scoped `refId` together.

---

### [P1] `recordDeliveryAttempt` has no terminal-state guard — late/duplicate attempts flip `ok ↔ failed` and re-arm retry loops

`webhooks.ts:185`:

```ts
export const recordDeliveryAttempt = internalMutation({
  args: { deliveryId: v.id("webhookDeliveries"), ok: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, args): Promise<void> => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (delivery === null) return;
    const nextAttempts = delivery.attempts + 1;

    if (args.ok) {
      await ctx.db.patch(args.deliveryId, { status: "ok", attempts: nextAttempts });
      return;
    }
    if (nextAttempts < MAX_WEBHOOK_ATTEMPTS) {
      await ctx.db.patch(args.deliveryId, { attempts: nextAttempts, lastError: args.error });
      const backoffSec = WEBHOOK_BACKOFF_SECONDS[nextAttempts - 1] ?? 300;
      await ctx.scheduler.runAfter(backoffSec * 1000, internal.webhooks.deliverWebhook,
        { deliveryId: args.deliveryId });
      return;
    }
    // Final failure — mark failed + notify
    await ctx.db.patch(args.deliveryId, { status: "failed", attempts: nextAttempts, lastError: args.error });
    …
  },
});
```

There is no check on `delivery.status` before mutating. Scenarios:

1. **`ok` row re-flipped to `failed`.** Delivery already `status:"ok"`. A late
   `deliverWebhook` re-execution (Convex at-least-once) or a duplicate
   scheduled retry reports `ok:false`. `nextAttempts` is bumped; if
   `< MAX_WEBHOOK_ATTEMPTS` it patches `attempts` and schedules *another*
   `deliverWebhook` retry — a successful delivery is now re-entering the retry
   loop. If `>= MAX`, it flips `status:"ok" → "failed"` outright. The
   `webhook_failed` notification is saved by its own `refId` idempotency, but
   the **delivery status itself is wrong** and visible in `listDeliveries`.
2. **`failed` row re-flipped to `ok`.** A late `ok:true` flips a finalized
   failure back to `ok`. Same observability/correctness problem in reverse.
3. **Attempt counter drift.** Every duplicate `recordDeliveryAttempt` call
   increments `attempts` unconditionally, so `MAX_WEBHOOK_ATTEMPTS = 3` can be
   reached after fewer *real* HTTP attempts. A delivery that legitimately
   succeeded on attempt 1 can be marked `failed` after two duplicate
   `ok:false` callbacks that never actually hit the wire.

**Impact.** Webhook delivery state is non-monotonic and unreliable. Ops cannot
trust `status:"ok"` or `status:"failed"` as terminal. Publisher dashboards
will show "failed" deliveries that actually succeeded.

**Fix.** Early-return on terminal state:

```ts
if (delivery.status === "ok" || delivery.status === "failed") return;
```

before any patch, and make `attempts` advancement conditional on the row still
being `pending`.

---

### [P1] `deliverWebhook` is not idempotent — Convex action re-execution double-POSTs the endpoint AND double-counts attempts

`webhooks.ts:301`:

```ts
export const deliverWebhook = internalAction({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, args): Promise<void> => {
    const info = await ctx.runQuery(internal.webhooks.getDeliveryForAction, {
      deliveryId: args.deliveryId,
    });
    if (info === null) return;
    if (!info.active) { … recordDeliveryAttempt({ ok:false, … }); return; }
    const parsed = JSON.parse(info.payload) as { … };
    const result = await postWebhook({ url: info.url, secret: info.secret, … });
    await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, {
      deliveryId: args.deliveryId, ok: result.ok, error: result.error,
    });
  },
});
```

Convex `internalAction`s scheduled via `ctx.scheduler.runAfter` have
**at-least-once** execution semantics: if the action times out, the worker
node dies, or the function appears to not have completed, Convex re-runs it.
There is no guard here against re-execution:

1. **Double-POST.** Each re-run calls `postWebhook` → a real HTTP POST to the
   publisher's endpoint. The endpoint receives the same `event`+`data`+
   `timestamp` twice. The publisher's webhook handler is assumed idempotent —
   not guaranteed, and not documented as a contract anywhere visible here. For
   `version_deprecated` or `visibility_changed` events this can mean
   double-side-effects downstream.
2. **Double attempt-counting.** Each re-run calls `recordDeliveryAttempt`,
   bumping `attempts`. With `MAX_WEBHOOK_ATTEMPTS = 3`, two re-executions of
   the *same* failed attempt consume 2 of the 3 budget — a delivery can hit
   "final failure" after only one real HTTP call.

Combined with the previous finding (no terminal guard in
`recordDeliveryAttempt`), a single `deliverWebhook` re-execution can take a
delivery from `ok` → retrying → `failed` without any new network outcome.

**Impact.** Endpoints get hammered on Convex infra hiccups; delivery state
machine is observable-wrong.

**Fix.** Make the action idempotent by checking delivery state in
`getDeliveryForAction` (return `null`/a "skip" sentinel if
`delivery.status !== "pending"`), and have `recordDeliveryAttempt` ignore
results that don't advance a `pending` row (terminal-state guard, previous
finding). Also consider moving the POST + record into a single
`internalAction` that uses a Convex-transactional mutation to claim the
attempt slot before posting.

---

### [P1] `createNotification`'s `unique()` throws on duplicate `refId` — a single dupe anywhere aborts the entire `checkLowBalances` tick

`lib/notifications.ts:38`:

```ts
const existing = await ctx.db
  .query("notifications")
  .withIndex("by_ref", (q) => q.eq("refId", args.refId))
  .unique();   // throws ConvexError if >1 row matches
```

`schema.ts:132` defines `by_ref` as a *non-unique* index
(`.index("by_ref", ["refId"])` — not `.index`-with-unique). `unique()` in
Convex throws when the index returns more than one document. If two rows with
the same `refId` ever exist — from a race in a prior code path, a manual
insert, a Convex scheduler double-fire that predated the current idempotency,
or any future caller that mis-builds a `refId` — then *every* subsequent
`createNotification` call with that `refId` throws. In `checkLowBalances`,
which calls `createNotification` once per low-balance wallet in a tight loop
with no `try/catch`, the first such collision aborts the whole tick at that
org, blocking all later orgs (see the per-org-error-boundary finding).

**Impact.** Latent landmine. The idempotency contract is enforced by
*throwing*, not by degrading to `first()`. One duplicate row anywhere in
`notifications` permanently disables that org's low-balance alert and every
org after it in the scan.

**Fix.** Use `.first()` instead of `.unique()`, or wrap with `try/catch` and
treat a multi-result as "already exists". If true uniqueness is required, add
a Convex unique index (`index` fields cannot be unique in Convex — would need
application-level enforcement with a sentinel row).

---

### [P2] Unbounded `wallets.collect()` + N+1 `db.get(organizationId)` in `checkLowBalances`

`cronTasks.ts:25`:

```ts
const wallets = await ctx.db.query("wallets").collect();
…
for (const wallet of wallets) {
  …
  const org = await ctx.db.get(wallet.organizationId);   // N+1
  …
  await createNotification(ctx, { … });                    // +1 query per wallet
}
```

Full-table scan with no `.take(N)` bound, plus one `db.get` and one
`notifications.by_ref` `unique()` query per wallet — 2N+1 reads/tick,
unbounded in N (orgs). At 10k orgs that's ~20k reads every hour, 23 of which
hours are wasted (see hourly-cadence finding). The `wallets` table is
`O(orgs)` by design (one wallet per org), so this is "fine in absolute terms"
at small scale and "gradually becomes the dominant Convex cost line item" at
scale, with no backpressure.

**Impact.** Cost; also amplifies the no-error-boundary finding — more
iterations = more chances to throw and abort.

**Fix.** (a) Fix the cadence to daily. (b) Use the `by_organization` index
already on `wallets` and stream in batches via pagination rather than
`.collect()`. (c) The `db.get(organizationId)` is unavoidable per-wallet but
can be batched by collecting distinct `organizationId`s and reading them in
chunks — though Convex has no `getMany`, so the realistic fix is to store
`clerkOrgId` denormalized on `wallets` (it's needed for the `refId` anyway)
and drop the per-row `db.get` entirely.

---

### [P2] No concurrency guard on overlapping cron ticks

Convex crons do not guarantee non-overlap: if `checkLowBalances` runs past the
next `minuteUTC: 0` boundary (plausible at scale with the unbounded
`.collect()` + N+1 above), the next hourly tick starts while the prior is
still running. Both will read the same wallet balances, both will call
`createNotification` with the same day-scoped `refId`. The `by_ref` `unique()`
lookup (or `first()` after the fix) makes the *insert* idempotent — one wins,
one gets `created: false` — but the second tick still pays the full 2N+1 read
cost for zero effect.

The same overlap concern applies to `releaseMatureEarnings` *if* it is ever
wired to a cron: two concurrent sweeps could both load the same `pending_risk`
rows and both `patch` them. The `patch` is idempotent (same status value), so
no correctness loss, but wasted writes.

**Impact.** Wasted Convex budget under slow-tick conditions; no correctness
break today thanks to `refId`/`status` idempotency, but the safety is
incidental rather than designed.

**Fix.** Use a per-tick lock doc (e.g. a `cronLocks` table keyed by job name +
day/hour) claimed in a transaction at start, released at end; or schedule the
next tick only from within the current tick's completion.

---

### [P2] No jitter on `WEBHOOK_BACKOFF_SECONDS` — synchronized retry waves (thundering herd)

`webhooks.ts:23`:

```ts
export const WEBHOOK_BACKOFF_SECONDS = [60, 300] as const;
```

Retries are scheduled at exactly `+60s` then `+300s` after failure, with no
jitter. If a publisher endpoint goes down and 200 webhook events are queued
simultaneously (bulk spec publish, batch deprecate, admin visibility sweep),
all 200 fail their first attempt within seconds of each other, then all 200
retry at exactly `+60s`, then all 200 retry at exactly `+300s`. When the
endpoint recovers, it receives ~400 simultaneous POSTs in two synchronized
waves — often enough to re-trip rate limits or crash a recovering server,
which then looks like "still down" and triggers the final-failure path.

**Impact.** Retry synchronization amplifies downstream outages and can turn a
transient blip into a permanent delivery failure for the whole batch.

**Fix.** Add ±20% jitter: `backoffSec * (0.8 + Math.random() * 0.4)`. Also
consider per-endpoint concurrency limiting (next finding).

---

### [P2] No per-endpoint rate limiting in `fireWebhookEvent` — unbounded deliveries + scheduled actions

`webhooks.ts:46`:

```ts
export async function fireWebhookEvent(ctx, projectId, event, data): Promise<void> {
  const endpoint = await ctx.db.query("webhookEndpoints")
    .withIndex("by_project", (q) => q.eq("projectId", projectId)).unique();
  if (endpoint === null || !endpoint.active) return;
  const timestamp = Date.now();
  const payload = JSON.stringify({ event, data, timestamp });
  const deliveryId = await ctx.db.insert("webhookDeliveries", { … });
  await ctx.scheduler.runAfter(0, internal.webhooks.deliverWebhook, { deliveryId });
}
```

Every call inserts a `webhookDeliveries` row AND schedules a separate
`deliverWebhook` action. There is no per-endpoint cap, no batching, no
coalescing. A tight caller loop (`specs.publish` called in a batch; an admin
script toggling visibility across N projects sharing one endpoint) produces
N independent scheduled actions, each doing its own HTTP POST. Combined with
the no-jitter backoff, a downed endpoint can accumulate O(events × attempts)
scheduled actions and HTTP calls.

**Impact.** Cost blowup under bursty callers; downstream DoS of the publisher
endpoint; Convex scheduler pressure.

**Fix.** Coalesce within a short window (e.g. `runAfter(1, …)` with a
dedup keyed on `endpointId + event + SHA(data)`), and/or cap concurrent
in-flight deliveries per `endpointId` by checking
`webhookDeliveries` `status:"pending"` count before scheduling more.

---

### [P2] No sweeper cron for stuck `pending` webhook deliveries

`webhookDeliveries` rows start life as `status:"pending"`. They only leave
`pending` when `deliverWebhook` runs and calls `recordDeliveryAttempt`. If
`scheduler.runAfter(0, deliverWebhook, …)` never executes the action (Convex
scheduler backlog, action throws before `recordDeliveryAttempt`, worker node
loss, or the `JSON.parse(info.payload)` throw below), the row is **stuck in
`pending` forever**. There is no cron that finds
`status:"pending", createdAt < now - 10min` and re-schedules or
force-fails them.

The same applies to a `recordDeliveryAttempt` throw mid-state-machine: the
row is left at its current `attempts` count with no retry scheduled and no
final-failure path.

**Impact.** Silent delivery loss. A webhook event that the publisher needed
to receive (e.g. `version_deprecated`) just vanishes from the pipeline with
no error and no retry — the `listDeliveries` UI shows it eternally
"pending".

**Fix.** Add a cron (15-minutely or hourly) that scans
`webhookDeliveries.withIndex(...)` for stale `pending` rows and either
re-schedules `deliverWebhook` (if under attempt budget) or marks them failed
with `lastError:"stuck-pending-sweep"`. Requires a `by_status` or
`by_status_createdAt` index on `webhookDeliveries` (current schema only has
`by_endpoint`).

---

### [P2] `deliverWebhook` `JSON.parse(info.payload)` unguarded — parse failure strands delivery in `pending`

`webhooks.ts:318`:

```ts
const parsed = JSON.parse(info.payload) as { event: string; data: unknown; timestamp: number; };
const result = await postWebhook({ …, event: parsed.event, data: parsed.data, … });
await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, { … });
```

`info.payload` is produced by `JSON.stringify(...)` at insert time
(`fireWebhookEvent`), so under normal operation it always parses. But:
- a future schema change to the stored payload shape,
- a manual DB edit,
- corruption,
- or a `null`/`undefined` payload inserted by a buggy future caller

…makes `JSON.parse` throw. The throw escapes the action *before*
`recordDeliveryAttempt` is called, so the delivery stays `pending` with
`attempts: 0` and no retry scheduled. Combined with the missing
stuck-pending sweeper (previous finding), this is a permanent silent loss.

**Impact.** A single malformed payload permanently strands that delivery.

**Fix.** `try { parsed = JSON.parse(info.payload) } catch { recordDeliveryAttempt({ ok:false, error:"invalid payload JSON" }); return; }`.

---

### [P2] `recordDeliveryAttempt` and `checkLowBalances` return values discarded — zero observability for cron outcomes

`cronTasks.ts:46` returns `{ notified: number }`; Convex cron handlers'
return values are not surfaced anywhere (no log, no metric, no DB row).
`recordDeliveryAttempt` is `Promise<void>` by design, and `deliverWebhook`
also returns `void`. There is:
- no `console.log` of how many orgs were notified,
- no record of how many wallets were scanned,
- no record of how many webhook deliveries succeeded vs failed in a given
  window,
- no per-tick failure surface beyond Convex's own "function threw" dashboard
  (which only captures hard throws, not "notified: 0 because everyone threw
  inside try/catch").

**Impact.** When (not if) `checkLowBalances` silently notifies nobody because
every org throws inside a future `try/catch`, there is no signal. When a
publisher's webhooks all fail, there is no aggregate metric — only the
per-delivery `webhook_failed` notification, which itself is suppressed after
the first one per `deliveryId`.

**Fix.** Write a `cronRuns` row at end of each tick with
`{ job, startedAt, finishedAt, notified, failed, error? }`. At minimum,
`console.log` the result so Convex's function logs show it.

---

### [P2] No deduplication on `fireWebhookEvent` — rapid double-calls create duplicate deliveries

`fireWebhookEvent` uses `timestamp = Date.now()` as part of the payload *and*
as the only differentiator between two calls with the same `event`+`data`.
Two calls 1ms apart produce two `webhookDeliveries` rows with two different
`timestamp`s, two scheduled actions, and two HTTP POSTs to the endpoint with
the same `event`/`data` but different `timestamp`s. There is no
`refId`/idempotency key on `webhookDeliveries`.

Callers (`specs.publish`, `specs.deprecateVersion`, `admin.setProjectVisibility`)
are not audited here for double-call safety, but a double-click on "publish"
or a TanStack mutation retry will produce duplicate webhook deliveries, and
the publisher's handler is implicitly assumed idempotent.

**Impact.** Duplicate side-effects at publishers that aren't idempotent
(most aren't, by default).

**Fix.** Derive a stable delivery key from `endpointId + event +
SHA256(stable-serialization-of-data)` and use it as the `refId` on
`webhookDeliveries` with a `by_ref`-style idempotent insert (mirror the
`createNotification` pattern — but using `first()`, see the
`unique()` finding).

---

### [P3] `LOW_BALANCE_THRESHOLD = 1000` hardcoded — no env override, staging/prod identical

`cronTasks.ts:7`. No `process.env` lookup, no per-org override. A 1000-credit
threshold is appropriate for one price point and wrong for another. Staging
and production share the same threshold with no way to tune without a deploy.

**Fix.** `const LOW_BALANCE_THRESHOLD = Number(process.env.LOW_BALANCE_THRESHOLD ?? "1000");`

---

### [P3] `checkLowBalances` return `{ notified: number }` — count only, no per-org breakdown

Even if the return value were logged (see observability finding), a single
integer gives no signal about *which* orgs were notified or *which* threw.
For a money-related alert, "notified 3 of 1000 low-balance orgs" is
unactionable without the org list.

**Fix.** Return `{ notified, scanned, failed, failedOrgs: string[] }`.

---

### [P3] `crons.ts` uses `minuteUTC: 0` — future crons at the same minute create synchronized load spikes

`crons.ts:8`. Every hourly/daily cron added at `minuteUTC: 0` (or
`hourUTC: 0, minuteUTC: 0`) will fire simultaneously, creating a synchronized
load spike against Convex at the top of each hour/day. The current single
cron is fine; the *pattern* is a trap for the next addition.

**Fix.** Stagger: `minuteUTC: 7` for low-balance, `hourUTC: 0, minuteUTC: 12`
for mature-earnings release, etc.

---

### [P3] `checkLowBalances` notifies on negative (debt) balances with awkward message text

`reversePaymentCredits` explicitly "permits creating debt"
(`wallets.ts:124`). A wallet at -5000 credits is `< 1000`, so it triggers a
notification whose body reads `"Your wallet balance is -5000 credits. Top up
to avoid call interruptions."` — technically correct, UX-wise bad, and doesn't
distinguish "slightly low" from "deep in debt".

**Fix.** Differentiate: if `balance < 0`, use a `negative_balance` kind/body;
threshold checks should also handle the debt case explicitly.

---

### [P3] `crons.ts` has no comment explaining why other sweeps are omitted

The file registers one cron and stops. There is no `// TODO` or rationale for
why mature-earnings release, stuck-delivery sweep, wallet/DO reconciliation,
or stale-notification cleanup are not scheduled. A reader cannot tell
"intentionally omitted" from "forgot".

**Fix.** Either add the missing crons or a comment listing them as deferred
with owners/dates.

---

### [P3] Double JSON serialization in the webhook delivery path

`fireWebhookEvent` does `payload = JSON.stringify({event, data, timestamp})`
and stores it. `deliverWebhook` does `JSON.parse(info.payload)`, then passes
`{event, data, timestamp}` to `postWebhook`, which does
`JSON.stringify({event, data, timestamp})` *again*
(`lib/webhookDelivery.ts:38`). The signed body is therefore reconstructed
from the parsed object, not signed over the stored string. If key ordering
ever diverges between the two `JSON.stringify` calls (it won't today, since
both use the same object shape, but a future field addition that isn't
mirrored in both places would silently change the signed body).

**Fix.** Sign and POST the stored `payload` string directly; have
`postWebhook` accept a pre-serialized body, or have `fireWebhookEvent` store
the *signed* body. Eliminates the parse/re-serialize round trip and the
ordering risk.

---

### [P3] Orphan wallets (deleted orgs) scanned every tick forever — no cleanup

`checkLowBalances` handles `org === null` with `continue`, but the wallet row
for a deleted org is never itself cleaned up. It is re-scanned, re-`db.get`'d
(returns null), and skipped, every single tick, forever. With org churn this
is unbounded growth in the scanned set.

**Fix.** On `organizations` deletion, delete the wallet row (or mark it
`tombstoned` and skip via an index filter).

---

## Summary

**Counts:** P0: 0 · P1: 7 · P2: 8 · P3: 7 · **total: 22**

(Up from the prior review's 3 P1 + 4 P2 + 5 P3 = 12. All seven prior findings
verified and retained; 10 new findings expanded from the deep read of
`payouts.ts`, `webhooks.ts`, `webhookDelivery.ts`, and `notifications.ts`.)

**Top 3 (do these before anything else):**

1. **Wire `releaseMatureEarnings` to a daily cron using the `by_status_available`
   index** (P1 × 2 findings). Today, mature publisher earnings are frozen in
   `pending_risk` until a human clicks "transfer", and the `available` total
   in `getPayoutState` is structurally always 0. This is a money-visibility +
   money-mobility bug affecting every publisher who doesn't proactively
   withdraw.

2. **Add a terminal-state guard to `recordDeliveryAttempt` and make
   `deliverWebhook` idempotent** (P1 × 2 findings). Convex's at-least-once
   action re-execution currently double-POSTs publisher endpoints,
   double-counts attempts, and can flip a delivered-`ok` row to `failed`.
   The webhook delivery state machine is non-monotonic and untrustworthy.

3. **Fix `checkLowBalances` cadence + error boundary** (P1 × 3 findings).
   Hourly + day-scoped `refId` wastes 23/24 ticks (~46k reads/day at 1k orgs)
   with zero behavioral benefit and silently suppresses within-day re-drops.
   One throwing org (e.g. a `unique()` blowup on a duplicate `refId`) blocks
   every org created after it, every tick, with no alarm. Switch to daily,
   wrap each iteration in `try/catch`, and replace `unique()` with `first()`.
