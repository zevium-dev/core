# Tiger Review — `convex/crons.ts` + `convex/cronTasks.ts`

Reviewed together: `crons.ts` is the schedule, `cronTasks.ts` holds the task bodies. Cross-read: `convex/wallets.ts`, `convex/usage.ts`, `convex/webhooks.ts`, `convex/earnings.ts`, `convex/payouts.ts`, `convex/lib/notifications.ts`, `convex/schema.ts`. Grep confirmed callers.

---

## Verdict

**SHIP-BLOCKED on P1.** The single registered cron is correct in its idempotency contract but the **schedule does not match the documented intent**, **one throwing org aborts every subsequent org for the tick**, and a critical background sweep (`releaseMatureEarnings`) is not wired to any cron at all. Cost: 24× the necessary reads/day for an effectively-daily notification, plus a latent blast-radius bug where any single org document that throws during `createNotification` silently blocks every org after it in the iteration order for the rest of that hour. The cron layer is tiny and that is the problem — it is one `crons.hourly` registration away from being a real cron system and it isn't.

---

## File Stats

| File | LOC (effective) | Exports | Registered crons | Internal tasks |
|---|---|---|---|---|
| `convex/crons.ts` | 11 | 1 (`default`) | 1 (`low-balance-check`) | — |
| `convex/cronTasks.ts` | 47 | 1 (`checkLowBalances`) | — | 1 |

Read-by: `checkLowBalances` is referenced only by `crons.ts:10`. `releaseMatureEarnings` (`payouts.ts:296`) and `recordDeliveryAttempt`'s retry scheduler (`webhooks.ts:256`) are scheduler-driven, not cron-driven — see P1 #3.

---

## Findings

### [SEV: P1] Schedule is hourly but the task is daily — 23 of 24 ticks/day are pure waste, and a daily cadence is the wrong contract anyway

**Location:** `convex/crons.ts:7-11`, `convex/cronTasks.ts:34`

```ts
crons.hourly(
  "low-balance-check",
  { minuteUTC: 0 },
  internal.cronTasks.checkLowBalances,
);
```

```ts
const refId = `low_balance:${org.clerkOrgId}:${dayKey}`; // dayKey = YYYY-MM-DD
```

**Problem:** `crons.hourly` with `minuteUTC: 0` fires **24 times per UTC day**. The `refId` is scoped to `low_balance:{clerkOrgId}:{YYYY-MM-DD}`, so `createNotification` returns `{ created: false }` for every org on runs 2..24 of that UTC day. Those 23 runs still execute the full cost path: `wallets.collect()` + `ctx.db.get(wallet.organizationId)` for every wallet + `ctx.db.query("notifications").withIndex("by_ref").unique()` for every wallet. The comment on the cron (`/** Hourly low-balance check — one notification per org per UTC day. */`) admits the day-scoped dedupe but does not reconcile it with the hourly cadence.

**Impact:** 24× the Convex read load for 1× the user-visible effect. At N orgs this is `24 × (1 collect + 2N reads)` per day instead of `1 × (1 collect + 2N reads)`. Worse, the contract is incoherent: if a publisher's wallet dips below 1000 credits at 00:01 UTC and is topped up at 00:05 UTC then dips again at 23:00 UTC, the user gets **zero** notifications that day (the 00:00 tick already created one — actually no: 00:00 tick fires before the dip; the 01:00 tick creates the notification; the 23:00 tick is suppressed by the day-scoped refId). The day-scoped refId prevents re-alerting on a second genuine threshold crossing within the same UTC day, which is wrong for an alerting primitive.

**Fix:** Pick one:
1. If the intent is "alert once per day per org": use `crons.daily("low-balance-check", { hourUTC: 0, minuteUTC: 0 }, ...)` — matches the refId contract, 24× fewer reads.
2. If the intent is "alert on every threshold crossing": scope `refId` to a finer key (`low_balance:{clerkOrgId}:{utcHour}`) or to a wallet-state hash, and only suppress when the wallet was already below threshold on the prior tick (requires a `lastLowBalanceNotifiedAt` field on `wallets`).

---

### [SEV: P1] No per-org error boundary — one throwing org aborts every subsequent org for the tick (and on a bad org, forever)

**Location:** `convex/cronTasks.ts:22-43`

```ts
for (const wallet of wallets) {
  if (wallet.balance >= LOW_BALANCE_THRESHOLD) continue;
  const org = await ctx.db.get(wallet.organizationId);
  if (org === null) continue;
  const refId = `low_balance:${org.clerkOrgId}:${dayKey}`;
  const result = await createNotification(ctx, { /* … */ });
  if (result.created) notified += 1;
}
```

**Problem:** The loop body has no `try/catch`. Convex `internalMutation`s are **all-or-nothing transactions** — if `createNotification` throws for org at index `i` (transient Convex error, OCC conflict, `clerkOrgId` unexpectedly empty string violating an upstream invariant, etc.), the **entire mutation rolls back**, including every `created:true` notification inserted for orgs `0..i-1` in the same tick. The next hourly tick retries from org 0, so the data is recoverable on transient errors. **But:** if org `i` deterministically throws (e.g., a corrupted doc, a `clerkOrgId` that's `""` producing a malformed refId that some downstream invariant rejects, or any persistent condition), orgs `i+1..end` will **never** receive a low-balance notification as long as org `i` is in the table ahead of them. There is no skip-and-continue, no per-org error log, no circuit breaker.

**Impact:** Silent notification loss for an unbounded tail of orgs, dependent on iteration order (`wallets.collect()` has no `ORDER BY` — order is unspecified, so the "blocked tail" is nondeterministic). The cron returns `{ notified: number }` which the Convex cron scheduler discards, so there is no signal that something is wrong.

**Fix:** Wrap the body in try/catch, log the failure, continue:

```ts
for (const wallet of wallets) {
  if (wallet.balance >= LOW_BALANCE_THRESHOLD) continue;
  try {
    const org = await ctx.db.get(wallet.organizationId);
    if (org === null) continue;
    const refId = `low_balance:${org.clerkOrgId}:${dayKey}`;
    const result = await createNotification(ctx, { /* … */ refId });
    if (result.created) notified += 1;
  } catch (err) {
    // ctx.logger.warn(`low-balance: org ${wallet.organizationId} skipped`, err);
    continue;
  }
}
```

Note that this is safe only because `createNotification` is idempotent via `by_ref` — per-org rollback of an already-created notification would be silently re-created on the next tick.

---

### [SEV: P1] `releaseMatureEarnings` is not wired to any cron — publisher earnings sit at `pending_risk` forever unless the publisher clicks Withdraw

**Location:** `convex/crons.ts` (only `low-balance-check` registered); `convex/payouts.ts:296-316`

```ts
export const releaseMatureEarnings = internalMutation({
  args: { publisherOrganizationId: v.id("organizations") },
  handler: async (ctx, args): Promise<void> => {
    const now = Date.now();
    const pending = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", args.publisherOrganizationId),
      )
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

**Problem:** `releaseMatureEarnings` is invoked **only** from inside `initiatePublisherTransfer` (`payouts.ts:620`). It is org-scoped (`publisherOrganizationId` arg) and there is **no global variant** registered in `crons.ts`. The `schema.ts:302` index `by_status_available: ["status", "availableAt"]` exists specifically to serve this sweep and is referenced by **zero** queries (grep confirmed). Result: after `PUBLISHER_RISK_HOLD_MS` (7 days) elapses, a publisher's matured earnings are **never** promoted `pending_risk → available` until that publisher explicitly initiates a transfer. The dashboard `forOrg` earnings query (`earnings.ts`) reads whatever status is in the table, so the publisher sees earnings stuck in `pending_risk` that should be `available`.

**Impact:** Stale publisher-facing state; the `availableAt` field is computed and persisted but never acted on by the platform. The schema even has the correct index for the sweep and it is dead. This is a cron-system omission, not a payouts.ts bug — the fix belongs in `crons.ts` + a new global task in `cronTasks.ts`.

**Fix:** Add to `crons.ts`:

```ts
crons.interval(
  "release-mature-earnings",
  { seconds: 300 },
  internal.cronTasks.releaseMatureEarnings, // new global task, no org arg
);
```

And in `cronTasks.ts`:

```ts
export const releaseMatureEarnings = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const matured = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_status_available", (q) =>
        q.eq("status", "pending_risk").lt("availableAt", now),
      )
      .take(500); // bound the tick
    for (const e of matured) {
      await ctx.db.patch(e._id, { status: "available", updatedAt: now });
    }
  },
});
```

The `by_status_available` index is composite `["status", "availableAt"]`, so the `eq` + `lt` range is index-served — unlike the existing org-scoped variant, which `.filter()`s in JS after a full-publisher-history scan.

---

### [SEV: P2] Unbounded `wallets.collect()` + N+1 `ctx.db.get(organizationId)` — no pagination, no index on `balance`, no upper bound

**Location:** `convex/cronTasks.ts:23-26`

```ts
const wallets = await ctx.db.query("wallets").collect();
```

**Problem:** Full table scan with no index hint, no `.take(N)`, no pagination. For each wallet the loop then does `ctx.db.get(wallet.organizationId)` (a second round-trip per org) and `createNotification` does a `by_ref` index `.unique()` (a third round-trip per org). So a single tick is `1 + 3N` reads. The comment `// wallets table is O(orgs)` acknowledges this is intentional but provides no bound. Convex transactions have a 16 MB / N-reads ceiling; at sufficient org count (10k+ wallets) this mutation will exceed the transaction budget and **fail on every tick**, with no fallback. There is also no `balance < LOW_BALANCE_THRESHOLD` index — `wallets` only has `by_organization`, so the scan cannot be pruned by the predicate.

**Impact:** Linear read cost growth with org count, in a system that is "the control plane" for an agent marketplace that is expected to scale. Failure mode is silent (cron failure, return value discarded).

**Fix (incremental):** Acceptable short-term: `.take(1000)` per tick + a `continueCursor` persisted in a `cronState` table. Better long-term: add an index `by_low_balance: ["balance"]` and use `.withIndex("by_low_balance", q => q.lt("balance", LOW_BALANCE_THRESHOLD))` to prune at the index layer — though note Convex range scans on `balance` would still hit every low-balance wallet, which is exactly the working set we want. Also fetch orgs in a single `Promise.all` rather than serial `await` in the loop, or denormalize `clerkOrgId` onto `wallets` to drop the N+1 entirely (the `clerkOrgId` is already denormalized onto `keySettings` for the same reason — `schema.ts:225`).

---

### [SEV: P2] No concurrency guard — overlapping hourly ticks double-scan if a tick exceeds 1 hour

**Location:** `convex/crons.ts:7` (schedule), `convex/cronTasks.ts:23` (scan)

**Problem:** Convex crons do not guarantee non-overlapping execution. If `checkLowBalances` takes longer than 1 hour (plausible at scale per P2 #4 above, or under Convex deployment degradation), the next hourly tick fires a second instance while the first is still running. Both instances execute `wallets.collect()` and the per-org `createNotification` path. Because `createNotification` is `by_ref` idempotent and Convex serializes writes on the same doc, there is no double-notification — but there is **2× the read load** and a window of OCC conflicts on the `notifications` index that will cause one instance to retry. This compounds: a 90-minute tick produces 2 overlapping instances, a 2-hour tick produces 3, etc.

**Impact:** Read-cost amplification and retry storms under sustained slowness. No correctness violation (idempotency holds), but the system has no backpressure.

**Fix:** Either (a) switch to `crons.interval` with an interval larger than the worst-case tick duration, or (b) acquire a `cronState` row lock at the start of the task (insert/patch a doc with `lockKey = "low-balance-check"`, check `lastRunStartedAt` and bail if it's within the interval window). Convex's document-level serialization makes (b) trivially correct.

---

### [SEV: P2] `recordDeliveryAttempt` (webhooks) has no terminal-state guard — duplicate scheduler fires can push `attempts` past MAX and spuriously mark deliveries `failed`

**Location:** `convex/webhooks.ts:218-260` (called from `deliverWebhook` retry chain, not from crons.ts — but the cron layer is the natural place to add a recovery sweep)

```ts
const delivery = await ctx.db.get(args.deliveryId);
if (delivery === null) return;
const nextAttempts = delivery.attempts + 1;
if (args.ok) {
  await ctx.db.patch(args.deliveryId, { status: "ok", attempts: nextAttempts });
  return;
}
if (nextAttempts < MAX_WEBHOOK_ATTEMPTS) {
  await ctx.db.patch(args.deliveryId, { attempts: nextAttempts, lastError: args.error });
  // … schedule retry
  return;
}
// Final failure — mark failed + notify
```

**Problem:** The mutation does not check `delivery.status` before incrementing. If the scheduler double-fires `deliverWebhook` for a delivery that is already `"ok"` or `"failed"` (recovery after a Convex scheduler hiccup), `recordDeliveryAttempt` will still increment `attempts` and, on the failure path, schedule another retry or even flip an already-`failed` delivery into a second `webhook_failed` notification path. The `webhook_failed` notification uses `refId: webhook_failed:${deliveryId}` which is idempotent by `by_ref`, so no double notification — but the delivery's `attempts` counter is corrupted and an `ok` delivery could be re-marked `failed` if the duplicate fire carries `ok:false`.

**Impact:** State-machine corruption on duplicate scheduler fires. Not a cron bug per se, but the cron layer has no sweep that reconciles `pending` deliveries whose `createdAt` is older than `MAX_WEBHOOK_ATTEMPTS × WEBHOOK_BACKOFF_SECONDS` into a terminal state — those rows are stranded if the retry chain ever drops a scheduler event.

**Fix:** Guard at the top of `recordDeliveryAttempt`:

```ts
if (delivery.status === "ok" || delivery.status === "failed") return;
```

And consider a cron in `crons.ts` that sweeps `webhookDeliveries` with `status === "pending"` and `createdAt < now - (sum(WEBHOOK_BACKOFF_SECONDS) * 1000)` into `failed` with `lastError: "retry window exhausted"`.

---

### [SEV: P2] `checkLowBalances` return value is discarded by the cron scheduler — no observability, no alerting on anomalies

**Location:** `convex/cronTasks.ts:20, 43`

```ts
handler: async (ctx): Promise<{ notified: number }> => {
  // …
  return { notified };
};
```

**Problem:** Convex crons do not capture or log return values of `internalMutation` tasks. `{ notified }` is computed and thrown away. There is no `ctx.logger` call, no metrics emission, no write to a `cronRuns` table. If the cron silently degrades to `notified: 0` every tick because of a subtle bug (e.g., P1 #2's bad-org blocking, or a future change to `createNotification` that breaks the `by_ref` lookup), there is **zero signal** to operators. The function also swallows the `result.id` field returned by `createNotification` — no trace of which notifications were created.

**Impact:** Unobservable. A cron that does nothing looks identical to a cron that does something. For a notification system this is exactly the failure mode you want to detect.

**Fix:** Persist a `cronRuns` row (`{ task, startedAt, finishedAt, notified, error? }`) at the end of the handler, or at minimum `ctx.logger.info({ task: "low_balance_check", notified, scanned: wallets.length })`. Convex dashboard surfaces `ctx.logger`.

---

### [SEV: P3] `startOfUtcDay` is dead indirection — `new Date(now).toISOString().slice(0, 10)` is equivalent

**Location:** `convex/cronTasks.ts:8-11, 24`

```ts
function startOfUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
// …
const utcDay = startOfUtcDay(now);
const dayKey = new Date(utcDay).toISOString().slice(0, 10); // YYYY-MM-DD
```

**Problem:** `utcDay` is the UTC-midnight timestamp. `new Date(utcDay).toISOString()` produces the same `YYYY-MM-DD...Z` string as `new Date(now).toISOString()` because `toISOString()` always renders in UTC. The function and the intermediate variable add two hops of indirection for no behavioral difference.

**Impact:** Readability cost. A reader has to verify that `startOfUtcDay` isn't doing something meaningful (e.g., timezone shift) before realizing it isn't.

**Fix:** `const dayKey = new Date(now).toISOString().slice(0, 10);` and delete `startOfUtcDay`.

---

### [SEV: P3] `LOW_BALANCE_THRESHOLD = 1000` is a magic constant with no unit, no config, no per-org override

**Location:** `convex/cronTasks.ts:4`

```ts
/** Wallet balance below this triggers a low-balance notification (credits). */
const LOW_BALANCE_THRESHOLD = 1000;
```

**Problem:** Hardcoded at module scope. 1000 credits — is that $0.01 or $10? The unit is "credits" (documented) but the credit→USD mapping is not visible here, so the threshold is unreviewable in isolation. No env override, no per-org tuning (a publisher with 50 projects and 10M credits/month of throughput will get the same threshold as a hobbyist). No mechanism to suppress notifications for orgs that have explicitly opted out (e.g., prepaid enterprise contracts that never top up because they're invoiced).

**Impact:** Noise for high-volume orgs (irrelevant threshold), silence for low-volume orgs if raised globally. No escape hatch.

**Fix:** Move to env (`process.env.LOW_BALANCE_THRESHOLD` with default 1000) and/or denormalize a `lowBalanceThreshold` override onto `organizations` (nullable). At minimum document the credit→USD conversion in the comment.

---

### [SEV: P3] Notification body renders negative balances as a raw integer — confusing copy for orgs in debt

**Location:** `convex/cronTasks.ts:39`

```ts
body: `Your wallet balance is ${wallet.balance} credits. Top up to avoid call interruptions.`,
```

**Problem:** `reversePaymentCredits` (`wallets.ts:163`) is explicitly permitted to create negative balances ("Refund/dispute reversals are permitted to create debt"). For such an org, the notification reads `Your wallet balance is -500 credits. Top up to avoid call interruptions.` — which understates the severity (calls are already being rejected per `recordUsage`'s `wallet.balance - event.credits < 0` guard at `wallets.ts:414`) and offers no actionable detail (how much to top up to clear the debt + resume service).

**Impact:** Poor UX for the most-urgent recipient class. The cron fires once per day per org, so a debt-state org gets a single vague message.

**Fix:** Branch on `wallet.balance < 0`: `Your wallet is in debt (balance: ${wallet.balance} credits). Calls are blocked until you top up.` Optionally include the absolute amount needed to return to ≥0.

---

### [SEV: P3] File named `cronTasks` (plural) exports a single task — implies planned-but-missing work

**Location:** `convex/cronTasks.ts` (whole file), `convex/crons.ts` (single registration)

**Problem:** The plural filename and the existence of a dedicated task module (vs. inlining the mutation in `crons.ts`) signal that more cron tasks were planned. As of this review there is exactly one (`checkLowBalances`). P1 #3 above identifies at least one task that should exist here (`releaseMatureEarnings`) and P2 #6 identifies another (the `webhookDeliveries` pending-sweep). The naming is correct foresight; the absence of those tasks is the problem.

**Impact:** Naming/documentation mismatch. A reader sees `cronTasks.ts` and assumes the cron system is fleshed out.

**Fix:** Either add the missing tasks (preferred — see P1 #3, P2 #6) or rename to `cronTask.ts` until a second task lands.

---

### [SEV: P3] No try/catch around the top-level handler — a thrown error produces no cron-level diagnostic

**Location:** `convex/cronTasks.ts:19-44`

**Problem:** The handler has no outer try/catch. If `wallets.collect()` itself throws (Convex transient error), the mutation aborts and Convex's cron layer will retry on the next tick — but there is no logged record that the tick failed or why. The `notified` return is never persisted. This pairs with P2 #7 (no observability) but is the narrower issue: even a top-level `try { … } catch (err) { ctx.logger.error(…); throw err; }` would give the Convex dashboard something to surface.

**Impact:** Silent cron failures. The system can be down for an entire day with no signal beyond "no low_balance notifications were created" — which is itself unobservable because the return value is discarded (P2 #7).

**Fix:** Wrap the handler body in `try/catch`, log on failure, rethrow (so Convex's cron retry still fires).

---

## Summary

- **P0:** 0
- **P1:** 3 (hourly schedule wastes 23/24 ticks + wrong re-alert contract; no per-org error boundary blocks notification tail; `releaseMatureEarnings` not wired to any cron)
- **P2:** 4 (unbounded `wallets.collect()` + N+1 reads; no concurrency guard on overlapping ticks; `recordDeliveryAttempt` no terminal-state guard + no stranded-pending sweep; return value discarded + no observability)
- **P3:** 5 (dead `startOfUtcDay` indirection; magic `LOW_BALANCE_THRESHOLD` constant; negative-balance copy; plural filename with one task; no top-level try/catch)
- **Total:** 12

**Top 3 to fix before this cron layer is trustworthy:**

1. **P1 — Add the `releaseMatureEarnings` cron.** The schema already has `by_status_available` (dead index) and `availableAt` (computed-but-unused field). This is a one-task, ~15-line addition to `cronTasks.ts` + one `crons.interval` registration. Without it, the entire publisher payouts state machine is broken for passive publishers.
2. **P1 — Wrap the per-org loop in try/catch.** One line of defense (`try { … } catch { continue; }`) converts a silent whole-tick abort into a degraded-but-correct per-org skip. This is the cheapest correctness win in the file.
3. **P1 — Reconcile schedule with contract.** Either drop to `crons.daily` (matches the day-scoped `refId`, 24× read reduction) or re-scope `refId` to the hour (matches the "hourly check" name, enables genuine re-alerting). The current state is the worst of both: hourly cost, daily effect.
