# Tiger Review — `apps/gateway/src/wallet.ts` (deep-dive)

## Verdict

**Not shippable as-is for a money-handling primitive.** The Wallet DO is the
per-org working-balance authority for real credit flow (consumer debits,
publisher earnings, free tier, monthly caps). It carries the classic
ledger-correctness scaffolding — settlement-id idempotency, terminal-status
guard, `storage.transaction`-batched persist, `blockConcurrencyWhile` init,
single-flight sync — but the deep-dive confirms every prior finding and
unlocks three new data-loss / security paths the prior pass missed:

1. **`alarm()` has no `try/finally`** — a single throw from
   `flushToConvex`/`applySettlementResults` (e.g. a transient storage-transaction
   failure during ack) consumes the alarm without re-arming, orphaning every
   pending settlement on an idle org forever (lost usage + publisher earnings).
2. **Key enforcement fails open on three distinct paths**, not one: omitted
   `clerkOrgId`, *and* cold-start-with-failed-sync, *and* unknown keyId. A key
   that is simply absent from the `keySettings` cache is treated as unlimited
   — disabled keys and monthly caps are silently bypassed.
3. **Negative-balance escape via `settle` after `syncGrants` lowers the
   authoritative balance below a pre-existing inFlight hold.** `settle`
   debits without re-checking; `reserve`'s `available` clamp cannot protect
   against an in-flight hold that was approved against a now-stale balance.

The prior review's two P1s (alarm re-arm on `#load`, rejected-settlement
infinite retry) are **verified and expanded**; three prior P2s escalate to P1
(fractional-cost divergence, key fail-open, persist-failure divergence +
double-debit). Verified the requested TOCTOU/concurrency/replay surfaces:
within a single DO the `#mutate` promise-chain serializes read-modify-write
correctly, so there is no intra-DO over-debit race and settlement replay is
idempotent via stable `settle:{reservationId}` refs. The real failures are
*cross-failure* (persist-then-alarm, persist-failure rollback, sync-replaces-
balance-mid-hold) and *fail-open* (unknown key, missing clerkOrgId).

## File Stats

| metric | value |
|---|---|
| file | `apps/gateway/src/wallet.ts` |
| lines | 1103 |
| class | `WalletDO extends DurableObject<Cloudflare.Env>` |
| RPC surface | grant, reserve, settle, refund, consumeFreeTier, refundFreeTier, enqueueFreeUsage, flush, applySettlementResults, flushToConvex, syncGrants, getState, getFreeTierUsed, alarm |
| cross-ref | `convex/wallets.ts` (recordUsage, getGatewayWallet), `apps/gateway/src/usage.ts` (ConvexUsageClient, pendingToUsageRecord), `apps/gateway/test/wallet.test.ts`, `apps/gateway/test/ledger.ts` |

## Findings

### [SEV: P1] #1 — `#load()` never re-arms the flush alarm; pending settlements orphan forever for idle orgs

`apps/gateway/src/wallet.ts:273-312` (`#load`), `:392-397` (`#scheduleFlushAlarm`), `:1050-1066` (`alarm`)

```ts
async #load(): Promise<void> {
  const stored = await this.ctx.storage.get<…>([K_BALANCE, …, K_KEY_SETTINGS_AT]);
  this.#balance = (stored.get(K_BALANCE) as number | undefined) ?? 0;
  // …restores inFlight, pendingSettlements, terminal, keySettings…
  this.#loaded = true;   // ← no #scheduleFlushAlarm() even if pending non-empty
}
```

`#scheduleFlushAlarm` is only ever called from `settle` (`:546`) and
`enqueueFreeUsage` (`:698`). The alarm *payload* persists in storage across DO
eviction, but there are concrete paths where pending exists with **no alarm
set**:

- `settle` does `await this.#persist(...)` then `await this.#scheduleFlushAlarm()`.
  `setAlarm` is a *separate* storage op from the persist transaction; if it
  throws (transient storage error), the persist already committed but no alarm
  is set. The caller sees a rejected `settle()`; a retry returns
  `already_settled` (terminal persisted) which **does not re-arm**.
- `alarm()` throws before reaching the re-arm line (see P1 #6).
- An alarm fired, was consumed, and the handler threw → no alarm, pending remains.

On the next DO construction (cold start from an idle org's incoming request,
or a `syncGrants`/`getState` health probe), `#load()` restores the pending
settlements but never re-arms. For an idle org that issues no further
`settle`/`enqueueFreeUsage` calls, the pending settlements are orphaned
indefinitely — **permanently lost usage rows and publisher earnings**.

**Impact:** Silent data loss. Consumer is debited (balance reduced in storage)
but the settlement never reaches `wallets:recordUsage`; no usage event, no
`publisherEarnings` row, no accounting. Idle orgs are the common case, so this
is not a corner case.

**Fix:** At the end of `#load()`, if `this.#pendingSettlements.length > 0`,
`await this.#scheduleFlushAlarm()`. Also wrap `#scheduleFlushAlarm`'s
`setAlarm` so a failure there is surfaced (or retried) rather than silently
leaving the DO alarmless after a committed settle.

---

### [SEV: P1] #2 — Rejected settlements retry every 5 s forever; no DLQ, no max-retry, no backoff

`apps/gateway/src/wallet.ts:718-757` (`applySettlementResults`), `:1050-1066`
(`alarm`), `convex/wallets.ts:387-462` (`recordUsage`)

```ts
// applySettlementResults — only applied/already_applied are removable
const removable = new Set(results
  .filter(r => r.status === "applied" || r.status === "already_applied")
  .map(r => r.refId));
```

```ts
// alarm — re-arms while pending remains
if (this.#pendingSettlements.length > 0) {
  await this.ctx.storage.setAlarm(Date.now() + FLUSH_ALARM_MS); // 5_000
}
```

Convex `recordUsage` returns `rejected` for outcomes that are **permanent**:
`invalid settlement` (non-integer credits, empty ref), `settlement reference
belongs to another wallet`, `project not found`, `insufficient authoritative
balance`. The DO keeps these in `#pendingSettlements` (correctly, per the
"conservative local debit" design) and re-flushes them every 5 s via the alarm.
There is no dead-letter queue, no per-settlement retry counter, no exponential
backoff, and no escape hatch.

**Impact:** A single malformed or permanently-rejected settlement:
- Keeps the DO's alarm perpetually armed → the DO can **never be evicted** (it
  is woken every 5 s), consuming resident memory forever.
- Churns Convex with an identical rejected mutation every 5 s — 17 280
  rejected writes/day/org, each running a full `recordUsage` transaction with
  `walletEntries`/`usageEvents`/`publisherEarnings` index lookups.
- The rejected settlement's `cost` is held as a conservative local debit
  (`#acceptCheckpoint` subtracts `sumPendingCosts`), so the consumer is
  **permanently locked out of that credit** with no remediation path short of
  a manual storage intervention.

**Fix:** Add a per-settlement `attempts` counter and an `error`/`deadLetter`
flag; after N attempts or on permanent-rejection reasons, move the settlement
to a DLQ key and stop including it in flush batches. Exponential backoff on the
alarm (e.g. `min(FLUSH_ALARM_MS * 2**attempts, 5 * 60_000)`).

---

### [SEV: P1] #3 — Fractional `cost` accepted by `reserve`/`settle` but permanently rejected by Convex → balance divergence + orphan

`apps/gateway/src/wallet.ts:428-500` (`reserve`), `:502-565` (`settle`),
`convex/wallets.ts:402-408` (`recordUsage` validation)

```ts
// reserve — accepts fractional cost
if (!(cost > 0) || !Number.isFinite(cost)) {
  return { status: "rejected", reason: "cost must be > 0" };
}
```

```ts
// settle — deducts fractional cost from balance, enqueues pending
this.#balance -= cost;
this.#pendingSettlements.push(pending);
```

```ts
// convex recordUsage — permanently rejects non-integer credits
if (!Number.isSafeInteger(event.credits) || event.credits < 0 || …) {
  results.push({ refId: event.settleRefId, status: "rejected", reason: "invalid settlement" });
}
```

`reserve` only guards `cost > 0 && isFinite`, so `reserve("r1", 0.5)` succeeds.
`settle` deducts 0.5 from `#balance` and enqueues a pending settlement with
`cost: 0.5`. `pendingToUsageRecord` copies `credits: 0.5` verbatim. Convex
`recordUsage` rejects it with `invalid settlement` — **permanently**, because
`Number.isSafeInteger(0.5)` is false on every retry.

The 0.5 is now: deducted from the DO working balance (persisted), enqueued in
pending (retried forever per P1 #2), and never recorded in the authoritative
Convex ledger. On the next `syncGrants`, `#acceptCheckpoint` sets
`this.#balance = checkpoint.balance - sumPendingCosts(pending)`; the 0.5
remains in pending, so it is re-subtracted from the Convex checkpoint — i.e.
the consumer is permanently short 0.5 credit and the publisher never earns.

**Impact:** Money loss on both sides. Any fractional cost (a pricing bug
upstream, a miscomputed `publisherEarningSplit` remainder, a float math
artifact in the pipeline) silently diverges the DO from Convex and triggers the
infinite-retry/unevictable cascade of P1 #2. The DO's `grant` mutation is
likewise non-integer-tolerant (`!(amount > 0) || !Number.isFinite(amount)`)
while Convex `grantPaymentCredits` requires `Number.isSafeInteger` — same
class of divergence for the grant path.

**Fix:** In `reserve` (and `grant`), require `Number.isSafeInteger(cost)`
mirroring Convex's check. Reject at the edge, never let a fractional value
reach `settle`/pending.

---

### [SEV: P1] #4 — Key enforcement fails open on three paths: omitted `clerkOrgId`, cold-start + failed sync, and unknown keyId

`apps/gateway/src/wallet.ts:428-500` (`reserve`), `:941-987` (`#resolveKeySetting`), `:960-988` (`#isKeyDisabled`)

```ts
async #resolveKeySetting(keyId, clerkOrgId, nowMs): Promise<KeySetting | null> {
  if (!clerkOrgId) return null;                          // PATH A: no clerkOrgId → null
  if (nowMs - this.#keySettingsSyncedAt >= SYNC_GRANTS_WINDOW_MS) {
    await this.#syncGrantsSingleFlight(clerkOrgId, nowMs); // PATH B: sync fails → cache unchanged/empty
  }
  return this.#keySettings.get(keyId) ?? null;           // PATH C: unknown key → null
}
```

```ts
// reserve — enforcement block only runs if currentSetting is truthy
const currentSetting = opts.keyId
  ? (this.#keySettings.get(opts.keyId) ?? setting)
  : null;
if (opts.keyId && currentSetting) {                     // ← skipped when currentSetting === null
  if (this.#isKeyDisabled(currentSetting, now)) return { status: "rejected", reason: "key_disabled" };
  if (currentSetting.monthlyCapCredits !== undefined) { …cap check… }
}
// falls through to balance-only check; reservation SUCCEEDS with no cap / no disable
```

Three concrete fail-open scenarios, all reaching the same bypass:

- **PATH A** — `opts.clerkOrgId` omitted. `#resolveKeySetting` returns `null`
  immediately; no sync is ever triggered. If the key is not already cached
  (cold start), `currentSetting` is `null` → enforcement skipped.
- **PATH B** — cold-start DO (or post-hibernation with stale
  `#keySettingsSyncedAt`). `#resolveKeySetting` triggers
  `#syncGrantsSingleFlight`; if the Convex `/wallet-grants` fetch fails
  (network, 5xx, misconfig), `syncGrants` returns `sync_failed` and
  `#keySettings` stays empty. Every subsequent `reserve` for *any* key sees
  `currentSetting === null` → **all** key enforcement (disable + monthly cap)
  is bypassed until a sync eventually succeeds.
- **PATH C** — a keyId that is not present in the Convex `keySettings` table
  (typo, rotated-and-deleted, or a fabricated key) is treated as unlimited:
  not disabled, no cap. Even with a fully fresh cache, an unknown key reserves
  freely.

**Impact:** Security / billing bypass. A disabled or revoked API key can be
used to consume credit; a key over its `monthlyCapCredits` continues to
reserve; an attacker-supplied bogus keyId faces no cap at all. The balance
check is the only remaining gate, so the org's paid credit — not the key's cap
— becomes the effective limit. Defense-in-depth is absent: the DO trusts that
the upstream key-verifier rejected unknown keys, but does not enforce it.

**Fix:** Fail **closed**. If `opts.keyId` is present, require a non-null
`currentSetting` (i.e. a known, synced key); otherwise reject with
`key_unknown`. Require `clerkOrgId` when `keyId` is present. On `sync_failed`
during `#resolveKeySetting`, reject the reservation rather than proceeding
with an empty cache.

---

### [SEV: P1] #5 — `#persist` failure leaves in-memory state mutated while storage is unchanged → divergence + double-debit-on-eviction

`apps/gateway/src/wallet.ts:337-349` (`#mutate`), `:351-390` (`#persist`), `:502-565` (`settle`)

```ts
async #mutate<T>(operation: () => Promise<T>): Promise<T> {
  const previous = this.#mutationTail;
  let release;
  this.#mutationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();        // operation mutates #balance/#inFlight/#terminal in memory,
  } finally {                        // THEN calls #persist inside the same operation
    release?.();                     // ← no rollback of in-memory state if #persist throws
  }
}
```

`settle` mutates `this.#inFlight` (delete), `this.#balance` (−=cost),
`this.#terminal[reservationId] = "settled"`, pushes to
`#pendingSettlements`, and *then* `await this.#persist({...})`. If
`#persist`'s `storage.transaction` throws, the in-memory projection is already
in the post-settle state but storage retains the pre-settle state. The thrown
error propagates to the caller, but:

- The in-memory `#terminal[reservationId] === "settled"` persists for the life
  of this DO instance. A caller retrying `settle("r1")` receives
  `already_settled` (in-memory) — **even though storage never recorded the
  settle**. The caller believes the operation succeeded.
- If the DO is subsequently evicted (memory pressure, idle timeout),
  `#load()` restores from storage: `#inFlight["r1"]` is still present,
  `#terminal["r1"]` is absent. The reservation is now "un-settled" again. A
  later `settle("r1")` (e.g. a gateway retry after its own timeout) succeeds a
  **second time**: `#balance -= cost` again, a second pending settlement with
  the same `settle:r1` id is enqueued. Convex `recordUsage` dedupes by
  `settleRefId` (returns `already_applied` for the second), so only one debit
  lands in the authoritative ledger — but the **DO's working balance is now
  double-debited**, and the second pending settlement is orphaned (retried
  forever per P1 #2, held as a conservative local debit per P1 #3's mechanism).

The same divergence applies to `reserve` (inFlight entry added in memory, not
persisted), `grant` (`#balance += amount`, `#appliedGrantIds.add` not
persisted), `refund`, `consumeFreeTier`, `enqueueFreeUsage`, and
`applySettlementResults` (pending filtered in memory, checkpoint accepted in
memory, not persisted).

**Impact:** Money bug. The DO's working balance can silently diverge from the
authoritative Convex ledger, and a plausible eviction-between-persist-failure-
and-retry sequence double-debits the consumer. The `#mutate` lock serializes
operations but provides **no transactional rollback** of the in-memory
projection, which is the entire point of coupling the projection to the
persist.

**Fix:** Either (a) move the in-memory mutation *after* a successful
`#persist` (compute the new state, persist, then commit to `this.#…`), or
(b) snapshot the pre-mutation in-memory state in `#mutate` and restore it in
the `finally`/`catch` when `operation()` throws. (a) is cleaner and matches
the "storage is the source of truth" model the header comment claims.

---

### [SEV: P1] #6 — `alarm()` has no `try/finally`; a throw from `flushToConvex`/ack consumes the alarm without re-arming → orphan

`apps/gateway/src/wallet.ts:1050-1066` (`alarm`), `:759-817` (`flushToConvex`), `:718-757` (`applySettlementResults`)

```ts
async alarm(): Promise<void> {
  if (this.#pendingSettlements.length === 0) return;
  const hasUsage = this.#pendingSettlements.some((s) => s.usage !== undefined);
  if (hasUsage) {
    await this.flushToConvex();        // ← not wrapped; can throw
  }
  if (this.#pendingSettlements.length > 0) {
    await this.ctx.storage.setAlarm(Date.now() + FLUSH_ALARM_MS);  // ← skipped on throw
  }
}
```

`flushToConvex` catches the *Convex client* error (`.then(r=>…, err=>…)`) but
does **not** catch a throw from `applySettlementResults`:

```ts
const ack = await this.applySettlementResults(usageResult.value.results, usageResult.value.wallet);
```

`applySettlementResults` → `#mutate` → `#persist` → `storage.transaction`. A
transient storage-transaction failure during ack throws, propagates through
`flushToConvex` (no surrounding try/catch), propagates through `alarm()` (no
try/catch), and the re-arm `setAlarm` line is never reached. The alarm is
consumed; pending settlements (including the ones Convex *already applied*
this round) are now orphaned — and per P1 #1, `#load` will not re-arm them on
the next construction.

Worse, the in-memory state inside `applySettlementResults` has already
executed `this.#pendingSettlements = this.#pendingSettlements.filter(...)` and
`#acceptCheckpoint(...)` before the failing `#persist` (P1 #5 divergence),
so the DO also silently drops the acked settlements from its in-memory
projection while storage retains them.

**Impact:** Permanent orphan on a single storage hiccup during flush. Combined
with P1 #1 (no re-arm on `#load`) and P1 #5 (in-memory divergence), a transient
storage error during ack silently loses usage/earnings and corrupts the
projection. Cloudflare does not auto-retry an alarm handler that throws.

**Fix:** Wrap `alarm()` body in `try { … } finally { if
(this.#pendingSettlements.length > 0) await
this.ctx.storage.setAlarm(Date.now() + FLUSH_ALARM_MS); }`. Make
`applySettlementResults`'s in-memory mutation conditional on a successful
`#persist` (per P1 #5 fix).

---

### [SEV: P2] #7 — `refundFreeTier` decrements the *current* UTC day, not the day the unit was consumed

`apps/gateway/src/wallet.ts:644-658`

```ts
async refundFreeTier(keyId: string, nowMs: number = Date.now()): Promise<void> {
  if (!keyId) return;
  await this.#mutate(async () => {
    const storageKey = freeStorageKey(keyId, utcDayKey(nowMs));   // ← nowMs, not the consumption day
    const used = (await this.ctx.storage.get<number>(storageKey)) ?? 0;
    if (used > 0) await this.ctx.storage.put(storageKey, used - 1);
  });
}
```

`consumeFreeTier` writes to `free:{keyId}:{consumeDay}`. `refundFreeTier`
decrements `free:{keyId}:{refundDay}`. A request consumed at 23:59:55 UTC and
refunded at 00:00:05 UTC targets a different day key: the refund either no-ops
(if the new day's counter is 0, `used > 0` is false) or wrongly decrements the
new day's counter. The original day's counter stays inflated — the consumer is
permanently short one free-tier call on that day — and the new day gets a
spurious extra free call.

**Impact:** Free-tier accounting corruption at the UTC-day boundary (a daily
occurrence for any org with late-night traffic and upstream failures).

**Fix:** Accept a `consumedAt` (or the original day key) from the caller and
decrement that key. `consumeFreeTier` should return the day key it wrote so
the caller can pass it back.

---

### [SEV: P2] #8 — `consumeFreeTier` has no idempotency key; retries double-consume

`apps/gateway/src/wallet.ts:606-642`

```ts
async consumeFreeTier(keyId: string, limit: number, opts: { clerkOrgId?; nowMs? } = {}): Promise<FreeTierResult> {
  // … no reservationId / idempotency key accepted …
  const used = (await this.ctx.storage.get<number>(storageKey)) ?? 0;
  if (used >= limit) return { status: "exhausted", used, limit };
  const next = used + 1;
  await this.ctx.storage.put(storageKey, next);
  return { status: "consumed", used: next, limit };
}
```

`reserve`/`settle`/`enqueueFreeUsage`/`grant` all take a stable
`reservationId`/`grantId` and dedupe. `consumeFreeTier` takes none. If the
gateway calls it and the response is lost (network blip, worker restart), the
gateway retries → `used + 1` again → the org is charged two free-tier units for
one request. There is no `consumed`/`duplicate` distinction.

**Impact:** Silent over-consumption of the daily free quota on any retry; the
org is pushed toward paid credit unfairly.

**Fix:** Accept a `requestId`/`reservationId`; record consumed ids in a set (or
reuse the terminal-reservation mechanism) and return `duplicate` on replay.

---

### [SEV: P2] #9 — `settle` without `usage` escapes the monthly cap entirely

`apps/gateway/src/wallet.ts:502-565` (`settle`), `:428-500` (`reserve` cap check)

```ts
// settle — only increments the per-key monthly counter when usage.keyId + cost>0
await this.#persist({
  …,
  ...(usage?.keyId && cost > 0
    ? { settledCounter: { storageKey: settledStorageKey(usage.keyId, utcMonthKey(settledAt)), amount: cost } }
    : {}),
});
```

```ts
// reserve — cap check uses settledStorageKey(keyId, month) + sumInFlightForKey
const used = (await this.ctx.storage.get<number>(settledStorageKey(opts.keyId, month))) ?? 0;
const reserved = sumInFlightForKey(this.#inFlight, opts.keyId);
if (used + reserved + cost > currentSetting.monthlyCapCredits) return { status: "rejected", reason: "key_cap_exceeded" };
```

If `settle(reservationId)` is called without `usage` (the API permits it; the
test suite does it throughout), the reservation leaves `#inFlight` (so
`sumInFlightForKey` no longer counts it) but the `settled:` counter is **not**
incremented. The settlement is now invisible to the cap check: it is neither
in-flight nor settled-counter. Subsequent `reserve` calls for the same key
under-count and can exceed `monthlyCapCredits`.

In production the gateway always passes `usage`, but the DO does not enforce
this — a regression in the pipeline (a `settle` call site that forgets
`usage`, or a partial-usage object missing `keyId`) silently disables cap
enforcement for that key with no error.

**Impact:** Cap escape; a key can spend beyond its `monthlyCapCredits`.

**Fix:** Require `usage` (and `usage.keyId`) on `settle` for keyed
reservations, or track the cap counter from the reservation's `keyId`
(captured at `reserve` time into the `InFlightEntry`) rather than from
`usage.keyId` at settle time.

---

### [SEV: P2] #10 — `syncGrants` holds the `#mutate` lock across the Convex network fetch, blocking every wallet op for the org

`apps/gateway/src/wallet.ts:887-939` (`syncGrants`), `:337-349` (`#mutate`)

```ts
async syncGrants(clerkOrgId, nowMs = Date.now()): Promise<SyncGrantsResult> {
  return this.#mutate(async () => {           // ← lock acquired
    const last = (await this.ctx.storage.get<number>(K_SYNC_GRANTS_AT)) ?? 0;
    if (nowMs - last < SYNC_GRANTS_WINDOW_MS) return { status: "rate_limited", … };
    await this.ctx.storage.put(K_SYNC_GRANTS_AT, nowMs);
    const synced = await this.#fetchGrantsFromConvex(clerkOrgId);  // ← NETWORK CALL under lock
    …
  });
}
```

`#fetchGrantsFromConvex` is an outbound HTTP fetch to `/wallet-grants`. The
entire fetch — DNS, TLS, request, response parse — executes while holding the
`#mutationTail` lock that serializes `reserve`, `settle`, `refund`, `grant`,
`flush`, `applySettlementResults`, `consumeFreeTier`, `enqueueFreeUsage`, and
`refundFreeTier`. Every concurrent request for that org's wallet stalls behind
the sync. `syncGrants` is invoked lazily from `#resolveKeySetting` on the
*reserve* hot path (when the cache is stale), so a sync triggered by one
request blocks all other in-flight reservations for the org for the full
fetch latency.

`#syncGrantsSingleFlight` coalesces *concurrent* syncs, but does nothing for
*concurrent reservations* — they all wait on the same `#mutationTail`.

**Impact:** Tail-latency spikes and head-of-line blocking on the wallet hot
path whenever the 60 s freshness window expires; under load, an org's entire
wallet throughput is bounded by Convex `/wallet-grants` latency.

**Fix:** Do the fetch *outside* `#mutate`: read the rate-limit gate under the
lock, release, fetch, then re-acquire the lock to commit the new
`#keySettings`/checkpoint. The single-flight promise already serializes the
fetch itself.

---

### [SEV: P2] #11 — `syncGrants` claims the 60 s rate-limit window *before* the fetch; a transient failure blackouts key-refresh for 60 s (and persists across eviction)

`apps/gateway/src/wallet.ts:887-939` (`syncGrants`)

```ts
await this.ctx.storage.put(K_SYNC_GRANTS_AT, nowMs);          // window consumed
const synced = await this.#fetchGrantsFromConvex(clerkOrgId); // fetch may fail
if (synced === null) {
  return { status: "sync_failed", error: "could not fetch wallet checkpoint", … };
  // ← K_SYNC_GRANTS_AT is already persisted; no rollback
}
```

The rate-limit window (`K_SYNC_GRANTS_AT`) is persisted *before* the fetch. If
the fetch fails (network, 5xx, non-2xx, bad JSON, misconfig), the window is
already consumed and **persisted to storage** — so the failure survives DO
eviction. The next `syncGrants` within 60 s returns `rate_limited` regardless
of the prior outcome, so a transient Convex blip produces a 60 s blackout
during which `#resolveKeySetting` returns the stale/empty cache (feeding P1 #4
PATH B: fail-open key enforcement).

**Impact:** A single failed sync disables key-settings refresh for a full
minute; combined with P1 #4, a sync failure flips key enforcement to fail-open
for 60 s on every affected DO.

**Fix:** Claim the window *after* a successful fetch (or roll back
`K_SYNC_GRANTS_AT` in the `sync_failed` branch). Differentiate rate-limiting
(serve stale) from sync-failure (allow immediate retry).

---

### [SEV: P2] #12 — Negative-balance escape: `settle` after `syncGrants` lowers the authoritative balance below a pre-existing inFlight hold

`apps/gateway/src/wallet.ts:502-565` (`settle`), `:958-964` (`#acceptCheckpoint`), `:321-325` (`#available`)

```ts
// reserve approves against available = max(0, balance - sumInFlight)
const available = this.#available();
if (available < cost) return { status: "insufficient", available, cost };
this.#inFlight[reservationId] = { cost, … };

// syncGrants can later REPLACE #balance with a lower authoritative value:
#acceptCheckpoint(cp): boolean {
  if (cp.sequence <= this.#sequence) return false;
  this.#sequence = cp.sequence;
  this.#balance = cp.balance - sumPendingCosts(this.#pendingSettlements); // ← can drop below sumInFlight
  return true;
}

// settle then debits without re-checking:
this.#balance -= cost;   // ← can go negative even though reserve's clamp would now block
```

`reserve` clamps `available` to `max(0, balance - sumInFlight)`, so at reserve
time the wallet cannot overspend. But a held reservation stays in `#inFlight`
across a `syncGrants` checkpoint replacement: if Convex records a reversal
(`reversePaymentCredits`, which is explicitly permitted to create debt) or an
admin adjustment that lowers the authoritative balance below the held total,
`#acceptCheckpoint` sets `#balance` to the new (lower) value while
`#inFlight` is unchanged. `#available()` now returns `max(0, lowerBalance -
sumInFlight)` = 0, so *new* reserves are blocked — but the *existing* hold,
when settled, executes `this.#balance -= cost` unconditionally, driving
`#balance` negative.

The negative balance is then propagated to Convex on flush: `recordUsage`
rejects it (`wallet.balance - event.credits < 0` → `insufficient authoritative
balance` → permanent rejection → P1 #2 infinite retry + P1 #1 orphan via the
rejected-pending conservative debit). The consumer is locked out (available
clamped to 0) and the settlement is orphaned.

**Impact:** Surprise-overage: a reversal/adjustment race with an in-flight
reservation produces a negative working balance, a permanently-rejected
settlement, and a consumer lockout — the exact failure the `available` clamp
is supposed to prevent.

**Fix:** In `settle`, re-validate: if `this.#balance - cost < 0` *and* the
reservation's hold was approved against a now-superseded balance, either
reject the settle (leaving it in-flight for the gateway to refund) or
short-settle to the available balance. At minimum, do not enqueue a settlement
that Convex will permanently reject.

---

### [SEV: P2] #13 — Monthly cap counter is debited by settle-month but checked by reserve-month → cap escape at the UTC-month boundary

`apps/gateway/src/wallet.ts:455-475` (`reserve` cap check uses `utcMonthKey(now)`), `:534-545` (`settle` increments `utcMonthKey(settledAt)`)

```ts
// reserve (time T1): month = utcMonthKey(now_T1)
const used = (await this.ctx.storage.get<number>(settledStorageKey(opts.keyId, month))) ?? 0;
const reserved = sumInFlightForKey(this.#inFlight, opts.keyId);
if (used + reserved + cost > cap) reject;

// settle (time T2, possibly next month): increments settledStorageKey(keyId, utcMonthKey(settledAt_T2))
settledCounter: { storageKey: settledStorageKey(usage.keyId, utcMonthKey(settledAt)), amount: cost }
```

A reservation placed at 23:59 UTC on the last day of the month and settled at
00:01 UTC on the first day of the next month is counted against the *new*
month's `settled:` counter, but was checked against the *old* month's counter
at reserve time. After settle, the reservation is neither in the old month's
settled counter nor in `#inFlight` — so a subsequent same-month reserve
under-counts and the old month's cap is effectively exceeded.

**Impact:** Cap escape at the monthly boundary; an org can push a key beyond
its `monthlyCapCredits` by straddling the month rollover.

**Fix:** Capture the cap-month at `reserve` time (store it on the
`InFlightEntry`) and increment that same month's counter at settle, or
re-check the cap at settle against the reservation's original month.

---

### [SEV: P2] #14 — `consumeFreeTier` increment is not atomic with `enqueueFreeUsage`; partial failure loses free-tier units

`apps/gateway/src/wallet.ts:606-658` (`consumeFreeTier`), `:660-699` (`enqueueFreeUsage`)

The free-tier flow is two separate RPCs: `consumeFreeTier` (increments
`free:{keyId}:{day}`) then `enqueueFreeUsage` (enqueues the cost-0 pending
settlement). They are not transactional. If `consumeFreeTier` succeeds and
`enqueueFreeUsage` fails (network, worker restart), the day's counter is
incremented but no usage is enqueued — the consumer is short one free-tier
unit and no usage row is recorded. Recovery depends entirely on the gateway
calling `refundFreeTier`, which itself targets the wrong day if any time has
elapsed (P2 #7).

`consumeFreeTier`'s `put` is also a raw `storage.put` (not inside `#persist`'s
transaction), so it commits independently of anything else.

**Impact:** Silent loss of free-tier quota and usage attribution on any
partial failure.

**Fix:** Combine consume+enqueue into a single atomic RPC, or have
`consumeFreeTier` return a token the gateway must pass to `enqueueFreeUsage`,
with the counter increment only persisted on successful enqueue.

---

### [SEV: P3] #15 — `#loaded` flag is dead code

`apps/gateway/src/wallet.ts:263` (`#loaded = false;`), `:312` (`this.#loaded = true;`)

`#loaded` is written in `#load()` but never read anywhere. The constructor
calls `#load()` via `blockConcurrencyWhile`, which gates all requests
regardless of the flag. The field carries no semantic weight.

**Fix:** Delete `#loaded`.

---

### [SEV: P3] #16 — `flushSeq` / `batchId` persisted and returned but unused in production

`apps/gateway/src/wallet.ts:701-716` (`flush`), `:374-376` (`K_FLUSH_SEQ` persist)

`flush()` increments `#flushSeq`, persists it via a `storage.transaction`,
and returns `batchId: batch:${flushSeq}`. But the ack path
(`applySettlementResults`) keys removal on `settlementId`/`refId`, not
`batchId`. `batchId` is consumed only by `SimulatedLedger` in tests; the
production `flushToConvex` path never calls `flush()` and never reads
`batchId`. Every test-path `flush()` pays a transaction write for a counter
nothing uses.

**Fix:** Drop `#flushSeq`/`K_FLUSH_SEQ`/`batchId`, or use `batchId` to make
ack batch-idempotent if batch-level dedupe is desired.

---

### [SEV: P3] #17 — `getState`/`getFreeTierUsed` are not serialized by `#mutate`; can read mid-mutation in-memory state

`apps/gateway/src/wallet.ts:314-335` (`#snapshot`), `:651-658` (`getFreeTierUsed`)

`getState` calls `#snapshot()`, which copies `#balance`/`#inFlight`/
`#pendingSettlements` without holding `#mutationTail`. Because JS is
single-threaded these reads are not *torn*, but they can observe the
in-memory projection *between* a mutation and its `#persist` (per P1 #5, the
in-memory state is mutated before persist). A `getState` interleaved at an
`await` inside `settle`'s `#mutate` block returns a balance that storage has
not yet committed — and may never commit if `#persist` throws.

**Impact:** Minor consistency surface for display/admin reads; not a money
path.

**Fix:** Route reads through `#mutate` (or a shared read lock) so they observe
a committed projection.

---

### [SEV: P3] #18 — `#resolveKeySetting` serves up to 60 s stale key settings after short hibernation

`apps/gateway/src/wallet.ts:941-957` (`#resolveKeySetting`)

The refresh trigger is `nowMs - this.#keySettingsSyncedAt >= 60_000`. After a
short DO eviction (e.g. 30 s idle), `#keySettingsSyncedAt` is loaded from
storage and may be < 60 s old, so `#resolveKeySetting` serves the cached
settings without refresh. A key disabled in Convex during that window remains
usable for the remainder of the 60 s window. The comment acknowledges the
"bounded freshness interval," but for a security-sensitive control (disabled
keys) 60 s of stale-open is a wide window.

**Fix:** Tighten the freshness window for disable/rotation checks, or
optionally refresh on every reserve (cheap if `syncGrants` is moved out of the
lock per P2 #10).

---

### [SEV: P3] #19 — `enqueueFreeUsage` does not check key disabled / cap status

`apps/gateway/src/wallet.ts:660-699`

`enqueueFreeUsage` neither calls `#resolveKeySetting` nor `#isKeyDisabled`. A
free-usage row can be enqueued for a key that has since been disabled or has
exhausted its cap, bypassing the controls that `consumeFreeTier`/`reserve`
enforce. The gateway is expected to have checked earlier, but the DO does not
defend in depth.

**Fix:** Re-run `#isKeyDisabled` (and optionally the cap) inside
`enqueueFreeUsage` for the `usage.keyId`.

---

### [SEV: P3] #20 — `blockConcurrencyWhile` + `#load` throw permanently bricks the DO until eviction

`apps/gateway/src/wallet.ts:265-271` (constructor)

If `#load()` throws (storage error reading the initial multi-get), the
`blockConcurrencyWhile` promise rejects and every subsequent request
(`reserve`, `settle`, `alarm`, `getState`, …) fails permanently for the life of
this DO instance. There is no fallback to a degraded mode (e.g. read-only from
storage, or a safe-default zero balance that rejects reserves). Recovery
requires eviction + reconstruction, which may hit the same storage error.

**Impact:** Total wallet outage for the org on a storage hiccup at init.

**Fix:** Catch init errors, surface them via `getState`, and degrade to a
"reserve-disabled" mode rather than rejecting all RPCs.

---

## Summary

| SEV | count |
|---|---|
| P0 | 0 |
| P1 | 6 |
| P2 | 8 |
| P3 | 7 |
| **total** | **21** |

**Top 3 to fix before any production trust:**

1. **P1 #6 + P1 #1 — alarm orphan pipeline.** `alarm()` has no `try/finally`
   and `#load()` never re-arms; any throw during flush, any `setAlarm` failure
   after a committed settle, or any consumed-alarm-without-re-arm permanently
   orphans pending settlements for idle orgs. Fix both: re-arm in `#load`, wrap
   `alarm()` in `try/finally`. This is the silent data-loss path for usage and
   publisher earnings.

2. **P1 #4 — key enforcement fail-open (3 paths).** Missing `clerkOrgId`,
   cold-start-with-failed-sync, and unknown keyId all bypass disabled-key and
   monthly-cap checks. A security/billing control that fails open on the
   unknown case is the wrong default for a money primitive. Fail closed.

3. **P1 #5 + P1 #3 — projection/persist divergence and fractional-cost
   divergence.** `#mutate` mutates in-memory state before `#persist` with no
   rollback, enabling double-debit-on-eviction; `reserve`/`settle` accept
   fractional costs that Convex permanently rejects, diverging the working
   balance from the authoritative ledger and feeding the P1 #2 infinite-retry
   loop. Validate integers at the edge; commit in-memory state only after a
   successful persist.

**Verified prior findings (all 13):** the 2 prior P1s (alarm re-arm on `#load`,
rejected-settlement infinite retry) confirmed and expanded; the 8 prior P2s
confirmed (3 escalated to P1: fractional-cost, key fail-open, persist
divergence); the prior P3 class (dead code, staleness, missing checks)
confirmed and broadened.

**Verified absent (per the deep-dive ask):** no intra-DO TOCTOU between balance
check and deduction (the `#mutationTail` promise-chain serializes
read-modify-write correctly); no concurrent-request over-debit race within a
single DO; no replay vuln (stable `settle:{reservationId}` refs, Convex
dedupes by `refId`); storage transactions batch multi-key writes correctly
within `#persist`. The real failures are all *cross-failure* (persist-then-
alarm, persist-failure rollback, sync-replaces-balance-mid-hold) and
*fail-open* (unknown key, missing clerkOrgId) — not lock-correctness.
