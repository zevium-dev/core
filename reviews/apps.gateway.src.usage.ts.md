# Tiger Review — `apps/gateway/src/usage.ts`

## Verdict

**INCORRECT.** The production hot path (sync `ConsoleUsageSink` + `ctx.waitUntil` in `pipeline.ts`) does not block the response and the authoritative DO flush loop is idempotent and retried — that part is sound. But the `ConvexUsageSink` / `flushBatch` / `usageEventToRecord` surface in *this file* is dead in production (only `void ConvexUsageSink` in `index.ts`) yet carries real billing-correctness bugs (lost events on send failure, no fetch timeout, unvalidated result completeness) that will bite the moment the "future dual-write" hinted at in `index.ts` is wired in. Several latent defects also exist in the live `ConvexUsageClient`.

## File Stats

- File: `apps/gateway/src/usage.ts` (503 lines)
- Cross-read: `convex/usage.ts`, `apps/gateway/test/usage-client.test.ts`, `apps/gateway/src/pipeline.ts`, `apps/gateway/src/wallet.ts`, `apps/gateway/src/index.ts`, `convex/wallets.ts`, `convex/http.ts`
- Production usage path: pipeline `emitUsage` → `ConsoleUsageSink` (sync log) + DO `settle` → alarm `flushToConvex` → `ConvexUsageClient.recordUsage` → `wallets:recordUsage` (server-side `by_ref` idempotency). Authoritative flush is correct and retried.
- `ConvexUsageSink`, `usageEventToRecord`, `flushBatch`: **zero production callers** (`flushBatch` has no caller at all outside this file; `usageEventToRecord` is only called by `ConvexUsageSink.emit`).

## Findings

### [P1] `flushBatch` drains `#pending` before the network call, losing events on failure

**Location:** `apps/gateway/src/usage.ts:338-346`
```ts
async flushBatch(
  events?: ConvexUsageRecord[],
): Promise< ... > {
  const batch = events ?? this.#pending.splice(0, this.#pending.length);
  if (batch.length === 0) {
    return { results: [], settleRefIds: [] };
  }
  const result = await this.#client.recordUsage(batch);
  return {
    ...result,
    settleRefIds: batch.map((e) => e.settleRefId),
  };
}
```

**Problem.** When called with no argument, `#pending` is spliced (emptied) *before* `recordUsage` runs. If `recordUsage` throws — network error, Convex 500, non-JSON response, `#validateResult` mismatch — the spliced events are gone: not in `#pending`, not acked, not in any retry queue. They are silently dropped. This is direct under-billing plus lost usage analytics for every transient Convex failure.

The DO authoritative path (`wallet.ts:flushToConvex`) avoids this by calling `client.recordUsage(events)` directly and only acking via `applySettlementResults` on success — settlements stay in `#pendingSettlements` on failure and are retried by the alarm. `flushBatch` does not follow that pattern.

**Trigger.** Any caller of `flushBatch()` (no-arg form) that hits a transient `recordUsage` failure. `index.ts:85-86` keeps `ConvexUsageSink` around explicitly for "tests / future dual-write"; the moment that future arrives, this bug is live and silent.

**Impact.** Lost usage events → under-billing, missing analytics, broken publisher-earnings attribution. Billing-correctness defect.

**Fix.** Drain only on success, or re-enqueue on failure:
```ts
async flushBatch(
  events?: ConvexUsageRecord[],
): Promise< ... > {
  const batch = events ?? this.#pending.slice();
  if (batch.length === 0) {
    return { results: [], settleRefIds: [] };
  }
  try {
    const result = await this.#client.recordUsage(batch);
    if (events === undefined) {
      this.#pending.splice(0, batch.length);
    }
    return { ...result, settleRefIds: batch.map((e) => e.settleRefId) };
  } catch (err) {
    // leave #pending intact so the next flush retries
    throw err;
  }
}
```

---

### [P2] Dead code: `ConvexUsageSink`, `usageEventToRecord`, `flushBatch` are never instantiated in production

**Location:** `apps/gateway/src/usage.ts:300-346` (class), `348-362` (`usageEventToRecord`), `330-346` (`flushBatch`); marker `apps/gateway/src/index.ts:85-86` (`void ConvexUsageSink;`).

**Problem.** `index.ts` constructs `ConsoleUsageSink` (or `NoopUsageSink`) for the pipeline and never builds a `ConvexUsageSink`. `flushBatch` has zero callers anywhere in the repo. `usageEventToRecord` is referenced only by `ConvexUsageSink.emit`. The `void ConvexUsageSink;` statement exists solely to suppress the unused-import lint and keep the class constructable. ~110 lines of dead surface area carrying the P1 billing bug above (plus the timestamp and idempotency hazards below).

**Impact.** Maintenance trap: the "future dual-write" comment invites a future contributor to wire `ConvexUsageSink` into the pipeline emit path, which would (a) double-write to Convex (the DO authoritative flush already writes the same settlement via `pendingToUsageRecord`), and (b) activate the `flushBatch` lost-events bug.

**Fix.** Either delete `ConvexUsageSink` / `usageEventToRecord` / `flushBatch` (the DO path supersedes them), or add a load-bearing test that exercises `flushBatch` failure-retry so the P1 bug is caught before wiring.

---

### [P2] No fetch timeout on `#recordViaIngest` / `#mutationWithAdmin` — a hung Convex stalls the DO alarm flush indefinitely

**Location:** `apps/gateway/src/usage.ts:219-244` (`#recordViaIngest`), `246-285` (`#mutationWithAdmin`).
```ts
const res = await this.#fetch(url, { method: "POST", headers: {...}, body: ... });
```

**Problem.** Neither path passes an `AbortSignal`. The DO alarm's `flushToConvex` (`wallet.ts`) `await`s `client.recordUsage(events)`; if the Convex site endpoint or `/api/mutation` hangs (TCP stall, Convex-side pause), the alarm task blocks with no upper bound. Pending settlements pile up un-acked, the DO stays in flush-attempt, and credits remain reserved from the materialized balance until the alarm eventually times out at the platform level. There is also no per-batch deadline, so a single slow ingest blocks every subsequent settlement in the queue.

**Trigger.** Network pause or Convex-side slowness on either the ingest httpAction or the admin-key mutation endpoint.

**Impact.** Stalled flush loop → delayed settlement acks → growing pending queue → wallet balance drifts from authoritative ledger for the duration. Not a permanent billing loss (server-side idempotency protects on retry), but an availability/latency defect on the billing-critical path.

**Fix.** Pass an `AbortSignal.timeout(...)` (workerd supports `AbortSignal.timeout`) and treat `AbortError` as retryable:
```ts
const res = await this.#fetch(url, {
  method: "POST",
  headers: { ... },
  body: JSON.stringify({ events }),
  signal: AbortSignal.timeout(10_000),
});
```

---

### [P2] `#validateResult` / `parseRecordUsageResult` accept `results: []` and never enforce result-vs-event correspondence

**Location:** `apps/gateway/src/usage.ts:287-298` (`#validateResult`), `386-432` (`parseRecordUsageResult`).
```ts
#validateResult(result, events) {
  const consumerClerkOrgId = events[0]!.consumerClerkOrgId;
  if (!events.every((e) => e.consumerClerkOrgId === consumerClerkOrgId))
    throw new Error("usage batch contains multiple consumer wallets");
  if (result.wallet.clerkOrgId !== consumerClerkOrgId)
    throw new Error("convex checkpoint wallet does not match usage batch");
  return result;
}
```

**Problem.** Validation checks (a) all events share one consumer wallet and (b) the returned checkpoint wallet matches — but never that `result.results` is non-empty, that `result.results.length === events.length`, or that every submitted `settleRefId` has a corresponding outcome. `parseRecordUsageResult` accepts `results: []` as valid. A malformed/truncated Convex response (e.g. the httpAction returning `{ results: [], wallet: {...} }` after a partial internal error) would be silently accepted.

The DO path is accidentally safe — `applySettlementResults` only acks ids present in `results`, so missing outcomes stay pending and retry. But `flushBatch` returns `settleRefIds: batch.map((e) => e.settleRefId)` (all submitted ids) regardless of `result.results`, so any `flushBatch` caller that trusts `settleRefIds` as "acked" is lied to.

Additionally, `result.results` may contain `refId`s not in the submitted batch — neither function checks that either; the DO filters by pending-settlement id so it is harmless there, but the client happily passes through foreign refs.

**Trigger.** Truncated or malformed Convex response on either ingest or admin path.

**Impact.** Silent acceptance of incomplete results; misleading `settleRefIds` from `flushBatch`; potential for an outcome for an unrelated settlement to be returned to a caller that doesn't filter.

**Fix.** Enforce correspondence:
```ts
if (result.results.length !== events.length) {
  throw new Error("convex result count does not match batch size");
}
const expected = new Set(events.map((e) => e.settleRefId));
for (const r of result.results) {
  if (!expected.has(r.refId)) {
    throw new Error(`convex result contains unknown refId ${r.refId}`);
  }
}
```

---

### [P3] `usageEventToRecord` stamps `at: Date.now()` (emit/flush time) instead of request/settle time

**Location:** `apps/gateway/src/usage.ts:348-362`.
```ts
export function usageEventToRecord(event: UsageEvent): ConvexUsageRecord {
  return {
    ...
    at: Date.now(),
    settleRefId: `settle:${event.reservationId}`,
  };
}
```

**Problem.** `at` is the wall clock when the record is *buffered*, not when the request actually happened. `UsageEvent` already carries `latencyMs` and the pipeline computes `started` — but neither is passed through. `pendingToUsageRecord` (the live DO path) correctly uses `settledAt`. The two record builders for the same logical event produce different `at` values: under load or with delayed flush, `usageEventToRecord.at` can drift seconds-to-minutes from the true request time. Since `usageEvents.at` backs the `by_org_at` index used by `listForOrg` (`convex/usage.ts`), this drift corrupts time-windowed usage queries and `since`/`until` filters.

**Trigger.** Any use of `usageEventToRecord` (currently dead, but see the "future dual-write" hook).

**Impact.** Skewed usage timestamps, wrong ordering in `by_org_at` scans, inaccurate time-bounded billing/analytics queries.

**Fix.** Accept `at` (or `started`) on `UsageEvent` and propagate it; mirror `pendingToUsageRecord`:
```ts
export function usageEventToRecord(event: UsageEvent): ConvexUsageRecord {
  return { ..., at: event.at, settleRefId: `settle:${event.reservationId}` };
}
```

---

### [P3] `ConvexUsageSink.emit` silently drops `refunded` and `blocked` outcomes — diverges from `ConsoleUsageSink` semantics

**Location:** `apps/gateway/src/usage.ts:311-315`.
```ts
emit(event: UsageEvent): void {
  if (event.outcome !== "settled" && event.outcome !== "free") return;
  this.#pending.push(usageEventToRecord(event));
}
```

**Problem.** The pipeline emits usage events for every outcome including `refunded` (upstream non-2xx after a paid reservation) and `blocked`. `ConsoleUsageSink.emit` (the production sink) logs all of them. `ConvexUsageSink.emit` silently discards `refunded` and `blocked`. If `ConvexUsageSink` is ever swapped in for `ConsoleUsageSink`, refunded/blocked calls vanish from the usage stream entirely — no analytics, no audit trail for failed-but-billed-reservation refunds. The two sinks have incompatible contracts despite implementing the same interface.

**Impact.** Silent analytics loss on outcome swap; interface contract violation (sinks should not unilaterally decide which outcomes to record).

**Fix.** Either record all outcomes (matching `ConsoleUsageSink`) or document the filter as intentional and make the `UsageSink` interface contract explicit about which outcomes sinks must preserve.

---

### [P3] No client-side input validation in `recordUsage` before sending to Convex

**Location:** `apps/gateway/src/usage.ts:155-180`.

**Problem.** `recordUsage(events)` sends `events` straight to `#mutationFn` / `#recordViaIngest` / `#mutationWithAdmin` / `client.mutation` with zero validation of `credits` (≥0, integer), `at` (finite), `status` (integer), `latencyMs` (finite), `settleRefId` (non-empty), or `consumerClerkOrgId` (non-empty). The server (`wallets:recordUsage` in `convex/wallets.ts`) validates each field and returns `status: "rejected"` per-event — so invalid events are not applied (no billing corruption), but every invalid batch costs a full Convex round-trip plus a rejected-outcome entry on the ledger. The client also has no fast-fail for the empty-batch case other than the one `events.length === 0` check.

**Impact.** Wasted Convex calls on malformed batches; rejected settlements that could have been caught locally. Not a billing bug (server is the authority) but a proportionate-rigor gap given the rest of the file parses the response strictly.

**Fix.** Mirror the server's per-event validation client-side and throw before any network call.

## Summary

- **P0:** 0 · **P1:** 1 · **P2:** 3 · **P3:** 3 · **Total:** 7
- Top 3:
  1. `flushBatch` splices `#pending` before `recordUsage` — lost usage events / under-billing on any transient Convex failure (P1, currently dead code but staged for "future dual-write").
  2. `ConvexUsageSink` + `usageEventToRecord` + `flushBatch` are dead in production yet carry the billing bug above; `void ConvexUsageSink;` is a maintenance trap (P2).
  3. `#recordViaIngest` / `#mutationWithAdmin` have no fetch timeout — a hung Convex stalls the DO alarm flush indefinitely (P2).

The live production path (sync `ConsoleUsageSink` + DO-authoritative `flushToConvex` with server-side `by_ref` idempotency and alarm-driven retry) is correct: usage emit does not block the response, failed upstream calls are refunded (not settled), and the server dedupes by `settleRefId`. The defects cluster in the unused `ConvexUsageSink` surface and the shared `ConvexUsageClient` validation/timeout gaps.
