# Tiger Review — `apps/gateway/src/wallet.ts`

## Verdict

**INCORRECT — do not merge.** The Wallet DO is the edge credit gate and the
single thing standing between Zevium and surprise-overage. Its core
read-modify-write serialization (`#mutate`) is sound, the reserve→settle→ack
ledger pattern is idempotent, and the Convex-side `recordUsage` mutation
provides a second guard against over-debit. But the flush-to-Convex path has
two independent operational defects that will bite in production:
**(1) pending settlements can be orphaned after a DO restart because `#load`
never re-arms the alarm**, and **(2) any settlement Convex rejects even once
retries forever every 5 s with no DLQ or max-retry**, permanently preventing
DO hibernation and generating unbounded Convex load. Several smaller
correctness gaps (fractional costs, free-tier day-rollover refund, fail-open
key enforcement, cap escape on `settle` without usage) round out the list.

## File Stats

- File: `apps/gateway/src/wallet.ts` (1102 lines)
- Cross-read: `apps/gateway/test/wallet.test.ts`, `apps/gateway/test/ledger.ts`,
  `convex/wallets.ts`
- Findings: 13 — P0: 0, P1: 2, P2: 8, P3: 3

---

## Findings

### [P1] `#load` never re-arms the flush alarm — pending settlements orphaned after DO restart

**Location:** `#load` (lines 270–313) + `alarm()` (lines 1050–1063) + `settle()`
line 561.

**Problem.** The flush alarm is scheduled only inside `settle`/`enqueueFreeUsage`
via `#scheduleFlushAlarm()` and re-armed only inside `alarm()` itself
(line 1061). Cloudflare alarms are durable across eviction *only if they have
been set and have not yet fired*. There are two concrete orphan windows:

1. **Crash between `#persist` and `setAlarm` in `settle`.** `settle` persists
   the new pending settlement (lines 544–560) and only *then* calls
   `#scheduleFlushAlarm()` (line 561). If the DO is evicted/killed in that
   gap, the pending row is durable but no alarm exists.
2. **Crash inside `alarm()` after `flushToConvex` but before the re-arm.**
   `alarm()` fires (consuming the alarm), runs `flushToConvex`, then re-arms
   only at line 1061 *if* `pending > 0`. A crash between `flushToConvex` and
   the `setAlarm` leaves a durable pending list with no scheduled alarm.

On the next DO construction, `#load` restores `#pendingSettlements` (line 300)
but **never calls `#scheduleFlushAlarm()`**. With no alarm and (in scenario 1)
no new `settle` to re-arm it, the pending settlements are never flushed to
Convex. The DO balance and the authoritative ledger diverge silently, and for
an idle org the divergence is permanent.

**Impact.** Silent ledger divergence: credits are deducted from the DO working
balance (at `settle` time) but never recorded in Convex. The next
`syncGrants` checkpoint would re-credit the user (checkpoint balance is higher
than the DO's by the orphaned pending cost, and `#acceptCheckpoint` subtracts
`sumPendingCosts`, so actually the DO keeps the deduction locally — but the
usage is never recorded, so publishers are never credited and the platform
loses the settlement row). Either way: lost usage accounting.

**Fix.** Re-arm the alarm at the end of `#load` if pending is non-empty:

```js
this.#loaded = true;
if (this.#pendingSettlements.length > 0) {
  await this.#scheduleFlushAlarm();
}
```

---

### [P1] Permanently-rejected settlements retry forever — no DLQ, no max-retry

**Location:** `applySettlementResults` (lines 718–753) + `alarm()` (1050–1063)
+ Convex `recordUsage` (`convex/wallets.ts` lines 285–340).

**Problem.** `applySettlementResults` only removes pending rows whose Convex
outcome is `"applied"` or `"already_applied"` (lines 725–729). Any outcome
with `status: "rejected"` is intentionally left pending so the alarm retries
it. The alarm then re-fires every 5 s (line 1061) and `flushToConvex`
re-sends the same events to Convex, which re-rejects them. Convex `recordUsage`
returns `"rejected"` for several **permanent** conditions:

- `"settlement reference belongs to another wallet"` (refId collision on a
  different wallet — `convex/wallets.ts` line 312) — never recoverable.
- `"project not found"` (line 320) — never recoverable.
- `"insufficient authoritative balance"` (line 327) — recoverable only if a
  grant arrives, which may never happen (e.g., a refunded/disputed payment
  that drove the wallet into debt).

For any of these, the DO enters an infinite retry loop: every 5 s it wakes,
re-sends the batch to Convex, gets the same rejection, and re-arms. The DO
can never idle/hibernate, and Convex receives unbounded mutation load per
stuck wallet.

**Impact.** Operational: permanent 5 s wake loop + Convex call churn per
stuck settlement, forever. One stuck wallet = one permanently-hot DO + one
Convex mutation every 5 s. At scale this is a denial-of-wallet-service vector
(a few poisoned refIds keep DOs hot).

**Fix.** Track retry count / last-attempt per pending settlement and either
move permanently-rejected rows to a dead-letter state (out of the flushable
set) or apply exponential backoff on the alarm. At minimum, distinguish
permanent rejections (`"belongs to another wallet"`, `"project not found"`)
from transient ones (`"insufficient authoritative balance"`) and DLQ the
permanent ones.

---

### [P2] Fractional `cost` accepted by `reserve`, permanently rejected by Convex

**Location:** `reserve` validation (lines 436–438); `settle` (line 530);
Convex `recordUsage` validation (`convex/wallets.ts` line 296:
`!Number.isSafeInteger(event.credits)`).

**Problem.** `reserve` rejects only `!(cost > 0) || !Number.isFinite(cost)` —
a fractional cost like `0.5` passes. The reservation is held, then `settle`
subtracts `0.5` from `#balance` and enqueues a pending settlement with
`cost: 0.5`. When the alarm flushes, `pendingToUsageRecord` carries `0.5`
into the `credits` field, and Convex's `recordUsage` rejects the event with
`"invalid settlement"` because `!Number.isSafeInteger(0.5)`. The settlement
is never applied; combined with the P1 above, it retries every 5 s forever.
Meanwhile the DO's local balance has been permanently reduced by `0.5`.

Credits are integers end-to-end (Convex grants require
`Number.isSafeInteger`), so a fractional cost reaching `reserve` is always a
bug in the upstream pricing path — but the DO should fail fast instead of
creating an unflushable settlement.

**Impact.** Any fractional cost emitted by the pricing layer (a future
`x-zevium-cost` parsing change, a division that doesn't round) creates a
permanently stuck pending settlement, a permanent 5 s retry loop, and a
silent local balance undercount that persists across `syncGrants` (the
checkpoint subtracts the pending cost, keeping the deduction).

**Fix.**

```js
if (!(cost > 0) || !Number.isSafeInteger(cost)) {
  return { status: "rejected", reason: "cost must be a positive integer" };
}
```

Apply the same to `grant` (line 407) and `consumeFreeTier`'s `limit`.

---

### [P2] `refundFreeTier` decrements the wrong UTC day's counter after midnight

**Location:** `refundFreeTier` (lines 643–654); `consumeFreeTier`
(lines 605–641).

**Problem.** `consumeFreeTier` increments the counter for
`utcDayKey(nowMs)` of the *consume* time. `refundFreeTier` computes the
storage key from `utcDayKey(nowMs)` of the *refund* time (line 650). If a
free-tier unit was consumed at 23:59:59 UTC and refunded at 00:00:01 UTC,
`refundFreeTier` decrements the **new** day's counter — a day on which no
unit was consumed for that reservation. If the new day already has
`used > 0` from other calls, the refund steals a free call from the new
day; if `used === 0` it no-ops (the `used > 0` guard), leaving the prior
day's counter permanently inflated.

**Impact.** Free-tier accounting drift across UTC midnight. A burst of
refunds straddling midnight can grant spurious free calls on the new day
or fail to restore the prior day's quota. Not a credit-loss bug (free tier
is 0 credits) but a quota-correctness bug that can let a key exceed its
daily free limit.

**Fix.** `refundFreeTier` must take the original consume timestamp (or the
day key) and decrement that specific counter, not "today":

```js
async refundFreeTier(
  keyId: string,
  consumedAtMs: number = Date.now(),
): Promise<void> {
  if (!keyId) return;
  await this.#mutate(async () => {
    const storageKey = freeStorageKey(keyId, utcDayKey(consumedAtMs));
    const used = (await this.ctx.storage.get<number>(storageKey)) ?? 0;
    if (used > 0) await this.ctx.storage.put(storageKey, used - 1);
  });
}
```

---

### [P2] `consumeFreeTier` has no idempotency key — replays burn multiple free units

**Location:** `consumeFreeTier` (lines 605–641).

**Problem.** Every other state-mutating RPC in this DO is idempotent by
`reservationId`/`grantId`/`settlementId` (`reserve`, `settle`, `refund`,
`grant`, `enqueueFreeUsage`). `consumeFreeTier` takes only `keyId` + `limit`
and unconditionally does `used + 1` (line 637). If the gateway retries a
request (network blip, client retry, alarm-driven re-drive) and the
pipeline calls `consumeFreeTier` again for the same logical request, the
key loses a free unit per retry. There is no way to dedupe.

**Impact.** A flaky network path or any caller that doesn't gate
`consumeFreeTier` behind its own reservation idempotency can exhaust a key's
free tier prematurely. Free tier is the acquisition funnel for the
marketplace; silently under-delivering it is a real business cost.

**Fix.** Accept a `reservationId` (or reuse the gateway's request id) and
store consumed ids per day, mirroring `#terminal`/`#appliedGrantIds`.
At minimum, return `"duplicate"` on a repeat `(keyId, reservationId, day)`.

---

### [P2] Key enforcement fails open when `clerkOrgId` omitted or settings never synced

**Location:** `#resolveKeySetting` (lines 941–951) + `reserve` (lines 466–484)
+ `consumeFreeTier` (lines 625–629).

**Problem.** `#resolveKeySetting` returns `null` immediately if
`!clerkOrgId` (line 946), skipping any sync. In `reserve`, when
`currentSetting` is `null` the entire enforcement block
(`key_disabled`, `key_cap_exceeded`) is skipped (line 469:
`if (opts.keyId && currentSetting)`). Same in `consumeFreeTier` (line 627:
`if (currentSetting && ...)`).

So a caller that supplies a `keyId` but omits `clerkOrgId` (or a wallet
whose first-ever request arrives before `syncGrants` has populated
`#keySettings`) gets **no key enforcement at all**: disabled keys pass,
cap-exceeded keys pass. The settings cache is empty at boot
(`#keySettings = new Map()`), and `#resolveKeySetting` only triggers a sync
when `clerkOrgId` is present *and* the freshness window has elapsed.

**Impact.** A disabled or cap-exhausted machine key continues to authorize
paid calls (and free-tier consumption) until settings sync, and indefinitely
if `clerkOrgId` is not threaded through every call site. The platform rule
"Never trust client identifiers when auth context supplies them" implies
the DO should fail *closed* when it cannot verify key state.

**Fix.** When `opts.keyId` is supplied but no setting is resolvable (no
`clerkOrgId`, or sync failed and cache is empty), reject with
`"key_settings_unavailable"` rather than silently allowing the call. If
fail-open is genuinely intended for the cold-start path, document it and
bound it (e.g., allow only the first N credits before a sync succeeds).

---

### [P2] `settle` without `usage` escapes the per-key monthly cap

**Location:** `settle` settledCounter increment (lines 549–559) vs `reserve`
cap check (lines 473–483).

**Problem.** The per-key monthly cap is enforced in `reserve` as
`used + reserved + cost > monthlyCapCredits`, where `used` is the
`settled:{keyId}:{month}` counter. That counter is incremented in `settle`
**only when `usage?.keyId && cost > 0`** (line 549). But `settle` is callable
without `usage` (the signature is `usage?: SettlementUsage`), and a
keyed reservation (one made with `opts.keyId`) can be settled without
passing `usage` back. In that case:

- `#balance -= cost` happens (line 530) — credits are deducted.
- `settledCounter` is **not** incremented.
- The pending settlement has no `usage`, so `flushToConvex` skips it
  (line 766 filters `settlement.usage !== undefined`) and the alarm's
  `hasUsage` check (line 1053) is false — it never flushes.

So the call is paid (balance deducted), never reaches Convex (no usage
row, no publisher earning), and never counts against the key's monthly cap.
Future reserves see a lower `used` than actually consumed.

**Impact.** Cap under-enforcement + lost usage/publisher-earning rows for
any keyed reservation settled without `usage`. Whether this is reachable
depends on the gateway pipeline, but the DO's contract allows it and
nothing guards against it.

**Fix.** Either require `usage` on `settle` for any reservation created
with a `keyId`, or derive the `keyId` for the counter from the in-flight
entry (`this.#inFlight[reservationId]?.keyId`) instead of `usage?.keyId`:

```js
const keyId = usage?.keyId ?? this.#inFlight[reservationId]?.keyId;
// ... after delete:
...(keyId && cost > 0
  ? { settledCounter: { storageKey: settledStorageKey(keyId, utcMonthKey(settledAt)), amount: cost } }
  : {}),
```

(Read `keyId` from the entry *before* `delete this.#inFlight[reservationId]`.)

---

### [P2] `syncGrants` holds the in-memory mutation lock across the Convex network fetch — head-of-line blocking

**Location:** `syncGrants` (lines 887–934), `#fetchGrantsFromConvex` call at
line 904; `#resolveKeySetting` triggers it from `reserve` (line 948).

**Problem.** `syncGrants` runs entirely inside `this.#mutate(...)`
(line 891). `#fetchGrantsFromConvex` (line 904) does a `fetch()` to the
Convex site URL while holding `#mutationTail`. Every other wallet RPC for
this org — `reserve`, `grant`, `settle`, `refund`, `consumeFreeTier` —
acquires the same lock and blocks for the full network RTT. Worse,
`#resolveKeySetting` is called *outside* `reserve`'s own `#mutate`
(line 440 in `reserve`) and invokes `#syncGrantsSingleFlight` →
`syncGrants` → `#mutate`, so a key-cache miss on the freshness window
(that is, once every 60 s per key) serializes the *next* reserve behind a
Convex HTTP round-trip.

**Impact.** Under any Convex latency (a few hundred ms, or seconds during an
incident), every gateway call for the affected org stalls behind the
sync. For a busy org this is a latency cliff and effectively serializes
the whole org's traffic at the DO. The "concurrent request race" the DO
exists to handle becomes a concurrency *bottleneck*.

**Fix.** Move the `fetch` outside `#mutate`: do the network call first, then
take the lock only to apply the result (`#acceptCheckpoint` + `#persist`).
`#syncGrantsSingleFlight` already deduplicates concurrent callers, so the
fetch can run unlocked and only the apply needs serialization. Ensure
`K_SYNC_GRANTS_AT` is written inside the locked apply, not before the
fetch (see next finding).

---

### [P2] `syncGrants` claims the rate-limit window before the fetch; a failed sync blocks retries for 60 s

**Location:** `syncGrants` lines 901–912.

**Problem.** Line 902 writes `K_SYNC_GRANTS_AT = nowMs` *before*
`#fetchGrantsFromConvex` (line 904), intentionally "so a flood of retries
is gated." If the fetch returns `null` (sync_failed, lines 905–912), the
function returns but `K_SYNC_GRANTS_AT` has already been persisted. The next
`syncGrants` call sees `nowMs - last < SYNC_GRANTS_WINDOW_MS` and returns
`rate_limited` (lines 893–899) for the full 60 s. So a single transient
Convex failure (timeout, 5xx, bad JSON) disables grant/key-settings refresh
for a full minute, and `#resolveKeySetting` will keep serving the stale
`#keySettings` for that window.

**Impact.** A disabled key or a fresh grant takes up to 60 s longer to
propagate after any transient fetch failure. Combined with the fail-open
behavior above, a sync failure mid-window means key enforcement continues
on stale data.

**Fix.** Only advance `K_SYNC_GRANTS_AT` on a *successful* sync. To still
gate retry floods, use a shorter backoff (e.g., a few seconds) for failed
syncs rather than the full 60 s window:

```js
const synced = await this.#fetchGrantsFromConvex(clerkOrgId);
if (synced === null) {
  await this.ctx.storage.put(K_SYNC_GRANTS_AT, nowMs - SYNC_GRANTS_WINDOW_MS + 5_000);
  return { status: "sync_failed", error: "...", balance: this.#balance, sequence: this.#sequence };
}
// success: claim the full window here
await this.ctx.storage.put(K_SYNC_GRANTS_AT, nowMs);
```

---

### [P2] In-memory state diverges from storage when `#persist` throws — no rollback

**Location:** `settle` (mutates `#balance`/`#inFlight`/`#terminal`/`#pendingSettlements`
at lines 528–542, then `#persist` at 544); `grant` (416–417 then 419);
`reserve` (491–495 then 496); `refund` (590–591 then 593); `enqueueFreeUsage`
(685–692 then 694); `#mutate` `finally` only releases the lock (lines 337–349).

**Problem.** Every mutating RPC first updates the in-memory fields, then
calls `#persist` (a `storage.transaction`). `#mutate`'s `finally` releases
the in-process lock but does **not** roll back the in-memory mutation if
`#persist` throws. After a storage error, the DO's in-memory `#balance`,
`#inFlight`, `#terminal`, `#pendingSettlements` reflect a write that was
never persisted. Subsequent RPCs (still in the same DO instance) read and
mutate the diverged state, so the in-memory projection can drift further
from storage with each subsequent operation until the DO is evicted and
`#load` resets everything.

Concrete example: `settle` deletes the in-flight entry and subtracts `cost`
from `#balance` (lines 528–530), then `#persist` throws on the
`settledCounter` read (line 383). The DO now believes the reservation is
settled and the balance reduced, but storage still shows it in-flight with
the old balance. A subsequent `reserve` sees inflated `available`. The next
`syncGrants` checkpoint would paper over `#balance` (via
`#acceptCheckpoint`) but `#terminal`/`#inFlight` divergence persists until
eviction.

**Impact.** After any storage write failure, the DO silently serves
incorrect balances and reservation state until eviction. Storage
transactions are atomic on the persisted side, but the in-memory projection
is not transactional with them.

**Fix.** Capture a shallow snapshot of the affected fields before the
in-memory mutation and restore it in a `catch` if `#persist` throws; or
restructure so the in-memory mutation is applied only after `#persist`
succeeds (compute the new state into locals, persist, then assign). At
minimum, re-`#load` from storage on any `#persist` rejection so the
projection is reset to the last durable state.

---

### [P3] `grant` accepts fractional / non-integer amounts

**Location:** `grant` validation, line 407.

**Problem.** `grant` checks `!(amount > 0) || !Number.isFinite(amount)` but
not `Number.isSafeInteger`. Convex's `grantPaymentCredits` requires
`Number.isSafeInteger(amount)` and throws otherwise. A fractional `grant`
RPC (test path or any direct caller) credits the DO locally with a
fractional balance that Convex would reject, creating the same local/ledger
mismatch as the fractional-cost finding.

**Impact.** Low; `grant` is primarily the test/legacy path (production
grants flow through `syncGrants`'s checkpoint). But the inconsistency is a
footgun.

**Fix.** `if (!(amount > 0) || !Number.isSafeInteger(amount))`.

---

### [P3] Free-tier and settled counters never garbage-collected

**Location:** `freeStorageKey` (line 211) + `consumeFreeTier` (line 638);
`settledStorageKey` (line 220) + `settle` (line 552).

**Problem.** The DO writes `free:{keyId}:{YYYY-MM-DD}` per key per UTC day
and `settled:{keyId}:{YYYY-MM}` per key per UTC month, forever. Nothing
ever deletes old keys. A long-lived org with N keys accumulates `~365*N`
free-tier counters and `~12*N` settled counters per year, all loaded into
DO storage. Storage reads for the current day/month are unaffected (keyed),
but storage grows without bound and `#load`'s `get([...])` doesn't include
them (good), yet a DO restart still carries them in storage indefinitely.

**Impact.** Unbounded DO storage growth proportional to `keys × time`. Not
a correctness bug; operational bloat.

**Fix.** On each `consumeFreeTier`/`settle`, opportunistically delete the
previous day's/month's counter for the key (or sweep in the alarm).

---

### [P3] `flushSeq` is write-only beyond `batchId` — dead-ish state

**Location:** `flush` (lines 701–711), `#persist` flushSeq path (line 375),
`#load` restore (line 305).

**Problem.** `#flushSeq` is incremented and persisted on every `flush()`,
restored on `#load`, and surfaced as `batchId: batch:${flushSeq}`. Nothing
ever reads it for ordering, dedup, or ack correlation — acks are matched
purely by `settlementId`. It is durable state that costs a storage write
on every flush for no observable effect.

**Impact.** None functionally; minor storage/write amplification and reader
confusion (a reader might assume batchId ordering matters for ack).

**Fix.** Drop `#flushSeq`/`K_FLUSH_SEQ` entirely, or actually use it to gate
out-of-order acks if that's intended.

---

## Summary

13 findings — **P1: 2, P2: 8, P3: 3**.

**Top 3 to fix before merge:**

1. **Re-arm the flush alarm in `#load`** (P1). Without this, any DO restart
   that lands in the crash window between persist and re-arm silently drops
   settlement flushes forever for idle orgs — lost usage accounting and
   publisher earnings.
2. **Add a DLQ / max-retry for permanently-rejected settlements** (P1).
   Today any single poisoned refId (cross-wallet collision, missing
   project, permanent insufficient balance) keeps the DO hot and Convex
   churning every 5 s indefinitely.
3. **Validate `Number.isSafeInteger(cost)` in `reserve`** (P2). Fractional
   costs pass the DO and are permanently rejected by Convex, producing a
   stuck pending settlement + the P1 retry loop + a silent local
   balance undercount.

The concurrency core (`#mutate` serialization, `available >= cost` guard,
idempotent reserve/settle/refund by `reservationId`, Convex-side
`wallet.balance - credits < 0` second guard) is correct — no over-debit
TOCTOU was found within a single DO instance. The bugs are all in the
*flush* and *settings-sync* side channels, where the DO's local projection
can desync from the authoritative ledger.
