# SPIKE REPORT: Durable Object org-wallet + ledger reconcile invariant

## Design notes

### Balance model

- `balance` = working balance. Includes applied grants and has already subtracted settled usage (whether or not that settlement has been flushed to the ledger).
- `inFlight` = temporary holds keyed by `reservationId` with `{ cost, createdAt }`.
- `available = balance - sum(inFlight.costs)`.
- `reserve(id, cost)`: requires `cost > 0` and `available >= cost`; otherwise fails. Zero balance blocks all reserves. Same id+cost is idempotent; same id different cost is a conflict. Terminal (settled/refunded) ids cannot be re-reserved.
- `settle(id)`: atomically remove from `inFlight`, `balance -= cost`, enqueue pending settlement with stable id `settle:${reservationId}`, mark terminal `settled`.
- `refund(id)`: remove from `inFlight` only (credit returns to available); mark terminal `refunded`.
- `grant(grantId, amount)`: if new `grantId`, `balance += amount` and record id; duplicates are no-ops.

### Flush protocol

1. DO keeps `pendingSettlements` until acked.
2. `flush()` returns `{ batchId, settlements }` with stable settlement ids; does **not** clear them.
3. Simulated ledger appends settlements, deduping by `settlementId`.
4. `ackFlush(settlementIds)` removes those rows from pending.
5. If ack is lost after ledger write: re-flush yields the same ids; ledger dedupe keeps a single row; subsequent ack clears DO pending.

### Crash-safety

- Constructor loads all keys under `ctx.blockConcurrencyWhile`.
- Multi-key mutations use `ctx.storage.transaction`.
- Terminal map preserves settle/refund idempotency after holds leave `inFlight`.
- Tests use `evictDurableObject` to force storage reload mid-fuzz.

### Surface

- RPC methods on `WalletDO` (preferred for tests): `grant`, `reserve`, `settle`, `refund`, `flush`, `ackFlush`, `getState`.
- HTTP router on the DO + thin Worker entry (`/wallet/:orgId/*`) for parity.

## Invariant definition

At any step:

- `balance >= 0`
- `available >= 0`
- `available === balance - inFlightTotal`

After quiescence (all open reservations settled or refunded; flush+ack until pending empty):

```
ledgerGrantsSum - ledgerSettledSum === doBalance + inFlightSum
```

and with in-flight cleared:

```
ledgerGrantsSum - ledgerSettledSum === doBalance
```

Ledger is authoritative for grants (record then DO.grant) and settlements (flush then append then ack).

## Test results

```
$ vitest run

 RUN  v4.1.10

 Test Files  1 passed (1)
      Tests  10 passed (10)
   Duration  1.12s (transform 39ms, setup 0ms, import 64ms, tests 721ms, environment 0ms)
```

Unit coverage:

- reserve fails at zero balance
- grant idempotency
- available = balance − inFlight
- reserve conflict same id different cost
- settle/refund idempotency + double-settle no-op
- flush-ack loss recovery (ledger once; re-flush; ack clears pending)
- cost must be > 0
- eviction / storage reload

Property/fuzz:

- 200 ops (seed `0xc0ffee`) with grants, reserves, settles, refunds, flushes (~30% drop ack), DO restarts
- 150 ops (seed `42`) second run
- both assert non-negative balance/available every step and ledger invariant at quiescence

## Edge cases found

1. **Terminal re-reserve**: after settle/refund, same `reservationId` must conflict rather than re-open a hold against a already-terminal lifecycle.
2. **Stable settlement ids** (`settle:${reservationId}`) are required for ledger dedupe under lost-ack; batch ids alone are not enough.
3. **Settle after refund / refund after settle** must return distinct terminal statuses (`already_refunded` / `already_settled`) without mutating balance again.
4. **Zero / non-positive cost** must reject before available checks so free holds cannot be created.
5. **Eviction mid-pending**: pending settlements and applied grant ids survive reload; duplicate grant/settle remain idempotent after `evictDurableObject`.
6. **Available accounting**: balance is debited only on settle, not reserve — refund restores availability without a ledger settlement row.

## Verdict rationale

Real workerd Durable Object via `@cloudflare/vitest-pool-workers`, transactional storage, flush/ack recovery, and seeded fuzz all green. Model is suitable for an org credit wallet with an authoritative external ledger.

VERDICT: GO
