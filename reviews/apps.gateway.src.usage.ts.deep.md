# Tiger Review — `apps/gateway/src/usage.ts` (DEEP-DIVE)

## Verdict

**INCORRECT — expanded.** The prior review's central thesis holds: the live production hot path (sync `ConsoleUsageSink` via `ctx.waitUntil` in `pipeline.ts`, plus the DO-authoritative `flushToConvex` → `wallets:recordUsage` with server-side `by_ref` idempotency and alarm-driven retry) is genuinely sound — usage emit does not block the response, failed upstream calls are refunded not settled, and retries dedupe by `settleRefId`. **But the deep-dive uncovers a second, more severe billing defect the prior review missed:** the `adminKey` fallback path (`#mutationWithAdmin`) hand-rolls the Convex HTTP mutation API with the wrong request shape (`args: [args]` + `format: "json"`, where Convex expects a bare `args` object for `format: "json"`), so every deployment that configures `CONVEX_DEPLOY_KEY` without `GATEWAY_INTERNAL_SECRET` silently loses **all** usage events and permanently diverges the DO working balance from the authoritative ledger. This is live production code (the `else` branch of `wallet.#buildUsageClient`), not dead surface, and it has **zero** test coverage.

Beyond that, the deep-dive adds four more findings the prior pass missed: no batch-size cap (livelock under backlog), no retryable-vs-terminal error classification (the DO retries terminal config errors forever), a misleading `organizationId` wire field whose doc-comment lies about which org it represents, and `FakeConvexUsageSink` divergences that hollow out the test suite's ability to catch the very bugs that shipped.

Prior findings (1 P1 + 3 P2 + 3 P3) are **all verified** below; the deep-dive **expands** to 2 P1 + 5 P2 + 8 P3.

## File Stats

- **File:** `apps/gateway/src/usage.ts` (503 lines)
- **Cross-read:** `convex/usage.ts`, `convex/wallets.ts` (`recordUsage` mutation, `usageEventArg` validator), `convex/http.ts` (`/ingest-usage` httpAction), `apps/gateway/src/pipeline.ts` (`emitUsage`, settle/refund branches), `apps/gateway/src/wallet.ts` (`flushToConvex`, `#buildUsageClient`, `applySettlementResults`, `alarm`), `apps/gateway/src/index.ts` (sink construction), `apps/gateway/test/usage-client.test.ts`, `apps/gateway/test/pipeline.test.ts`, `node_modules/convex/src/browser/http_client.ts` (`mutationInner` — the official request shape), Convex HTTP API docs (`format: "json"` vs `convex_encoded_json`).
- **Production usage path:** pipeline `emitUsage` (`ctx.waitUntil` + `ConsoleUsageSink`, sync log, fire-and-forget) → DO `settle`/`enqueueFreeUsage` → alarm `flushToConvex` → `ConvexUsageClient.recordUsage` → `wallets:recordUsage` (server-side `by_ref` unique-index idempotency). Authoritative flush is correct and retried.
- **`ConvexUsageSink` / `usageEventToRecord` / `flushBatch`:** **zero production callers** (`flushBatch` has no caller anywhere; `usageEventToRecord` only called by `ConvexUsageSink.emit`; `ConvexUsageSink` only `void`-referenced in `index.ts:86`).
- **`#mutationWithAdmin` (admin-key path):** **live production fallback** — `wallet.#buildUsageClient` returns it whenever `CONVEX_DEPLOY_KEY` is set but `GATEWAY_INTERNAL_SECRET` is not. Not dead. Untested.
- **Verified-correct (no finding):** emit does not block response (`ctx.waitUntil`); failed upstream → `wallet.refund` + `outcome: "refunded"` (not charged); retry idempotency via `walletEntries.by_ref` unique index (no double `usageEvents`/`walletEntries` insert; uniqueness violation rolls back the whole mutation tx).

## Findings

### [SEV: P1] #1 — `flushBatch` drains `#pending` before the network call, losing events on failure  *(prior — VERIFIED)*

**Location:** `apps/gateway/src/usage.ts:330-346`
```ts
async flushBatch(events?: ConvexUsageRecord[]): Promise<…> {
  const batch = events ?? this.#pending.splice(0, this.#pending.length);
  if (batch.length === 0) return { results: [], settleRefIds: [] };
  const result = await this.#client.recordUsage(batch);
  return { …result, settleRefIds: batch.map((e) => e.settleRefId) };
}
```

**Problem.** No-arg form splices (empties) `#pending` *before* `recordUsage` runs. If `recordUsage` throws — network error, Convex 5xx, non-JSON, `#validateResult` mismatch — the spliced events are gone: not in `#pending`, not acked, not in any retry queue. Silent drop on every transient Convex failure. The DO authoritative path (`wallet.flushToConvex`) avoids this by calling `client.recordUsage(events)` directly and only acking via `applySettlementResults` on success; settlements stay in `#pendingSettlements` on failure and are retried by the alarm. `flushBatch` does not follow that pattern.

**Trigger.** Any caller of `flushBatch()` (no-arg) hitting a transient `recordUsage` failure. `index.ts:85-86` keeps `ConvexUsageSink` for "tests / future dual-write"; the moment that future arrives this is live and silent.

**Impact.** Lost usage events → under-billing, missing analytics, broken publisher-earnings attribution.

**Fix.** Drain only on success:
```ts
const batch = events ?? this.#pending.slice();
if (batch.length === 0) return { results: [], settleRefIds: [] };
const result = await this.#client.recordUsage(batch);
if (events === undefined) this.#pending.splice(0, batch.length);
return { …result, settleRefIds: batch.map((e) => e.settleRefId) };
```
(`emit()` is synchronous and only pushes, so events appended during the `await` land after the original batch in `#pending`; splicing `batch.length` from the front on success removes exactly the originals. Safe.)

---

### [SEV: P1] #2 — `#mutationWithAdmin` sends the wrong Convex HTTP mutation request shape → broken `adminKey` fallback → permanent usage loss  *(NEW)*

**Location:** `apps/gateway/src/usage.ts:246-285` (`#mutationWithAdmin`), called from `recordUsage` at `:183-188`; constructed live in `apps/gateway/src/wallet.ts:862-866`.
```ts
async #mutationWithAdmin(path, args, adminKey): Promise<RecordUsageResult> {
  const base = (this.#convexUrl ?? "").replace(/\/+$/, "");
  const res = await this.#fetch(`${base}/api/mutation`, {
    method: "POST",
    headers: { "Content-Type": "application/json",
               Authorization: `Convex ${adminKey}` },
    body: JSON.stringify({ path, format: "json", args: [args] }),
  });
  …
}
```

**Problem.** The Convex `/api/mutation` HTTP API has two request shapes:
- `format: "convex_encoded_json"` → `args` is a **1-element array** of the convex-encoded args object: `args: [convexToJson(args)]` (this is what the official `ConvexHttpClient.mutationInner` sends — verified in `node_modules/convex/src/browser/http_client.ts:347-352`).
- `format: "json"` → `args` is the **bare args object**, not array-wrapped: `args: { events: […] }`. The Convex HTTP API docs state this explicitly: *"send `{ "body": "Hello" }` — not `[ { "body": "Hello" } ]`."*

`#mutationWithAdmin` mixes the two: it uses `format: "json"` **but** array-wraps (`args: [args]`). Convex therefore receives `args = [{ events: […] }]` (an array) where the `recordUsage` mutation validator (`v.array(usageEventArg)` inside `v.object({ events })`) expects an object. The mutation fails argument validation on every call.

This is the **`else` branch of `wallet.#buildUsageClient`** (`wallet.ts:862-866`), reached whenever `CONVEX_URL` is set but `GATEWAY_INTERNAL_SECRET` is not (i.e. a deployment that configures `CONVEX_DEPLOY_KEY` instead of the ingest shared-secret). On such a deployment:
1. Every alarm flush POSTs a malformed body → Convex rejects (400 / validation error).
2. `#mutationWithAdmin` throws `convex mutation failed: <status> <body>`.
3. `flushToConvex` catches it, returns `{ flushed: 0, error: … }`, leaves **all** pending settlements un-acked.
4. `alarm()` re-arms in 5s → same malformed batch → same failure → forever.
5. The DO working `#balance` was already debited at `settle()` time; the authoritative ledger never gets the `walletEntries`/`usageEvents` rows. The two **permanently diverge**, `#pendingSettlements` grows unbounded, and `usageEvents` (the consumer activity feed + `billing.cycleBreakdown`) is empty for that org. Under-billing + lost analytics + lost publisher earnings attribution, all silent.

**Why the prior review missed it.** The admin-key path has **zero** tests (the test file only covers the ingest path, `mutationFn`, and empty batch — `usage-client.test.ts:43-136`). The hand-rolled request body was never exercised against a real or fake Convex `/api/mutation`. The comment at `:181-182` ("setAdminAuth is @internal and not on public ConvexHttpClient typings") explains *why* the author hand-rolled it but the hand-roll is wrong.

**Impact.** Permanent, silent, total usage loss + permanent wallet/ledger divergence on the admin-key deployment configuration. Billing-correctness + data-loss defect on live (non-dead) code. [Runtime confirmation against a real Convex deployment would be definitive, but the request-shape mismatch against both the official client source and the Convex HTTP API docs is unambiguous.]

**Fix.** Don't hand-roll the mutation HTTP. Use the official client with admin auth (it is on `ConvexHttpClient` even if typed loosely), or match the official shape exactly:
```ts
// Option A (preferred): let ConvexHttpClient do it.
const client = new ConvexHttpClient(this.#convexUrl, {
  skipConvexDeploymentUrlCheck: true, logger: false, fetch: this.#fetch,
});
// adminAuth is set via the internal setAdminAuth; or call /api/mutation yourself:
// Option B: match the official shape.
body: JSON.stringify({
  path,
  format: "convex_encoded_json",
  args: [convexToJson(args)],   // import { convexToJson } from "convex/values"
}),
```
And add a test that posts through `#mutationWithAdmin` against a stub `/api/mutation` asserting the body matches `mutationInner`'s shape.

---

### [SEV: P2] #3 — Dead code: `ConvexUsageSink` / `usageEventToRecord` / `flushBatch` are never instantiated in production  *(prior — VERIFIED)*

**Location:** `usage.ts:300-346` (class), `:348-362` (`usageEventToRecord`), `:330-346` (`flushBatch`); marker `index.ts:85-86` (`void ConvexUsageSink;`).

**Problem.** `index.ts` constructs `ConsoleUsageSink` (or `NoopUsageSink`) for the pipeline and never builds a `ConvexUsageSink`. `flushBatch` has zero callers anywhere in the repo (confirmed by repo-wide grep). `usageEventToRecord` is referenced only by `ConvexUsageSink.emit`. The `void ConvexUsageSink;` statement exists solely to suppress the unused-import lint. ~110 lines of dead surface carrying the P1 above plus the timestamp/idempotency/outcome hazards below.

**Impact.** Maintenance trap: the "future dual-write" comment invites a contributor to wire `ConvexUsageSink` into the pipeline emit path, which would (a) double-write to Convex (the DO flush already writes the same settlement via `pendingToUsageRecord`) and (b) activate `flushBatch` lost-events (P1 #1).

**Fix.** Delete `ConvexUsageSink` / `usageEventToRecord` / `flushBatch` (the DO path supersedes them), or add a load-bearing test exercising `flushBatch` failure-retry so the P1 is caught before wiring.

---

### [SEV: P2] #4 — No fetch timeout / `AbortSignal` on `#recordViaIngest` / `#mutationWithAdmin`  *(prior — VERIFIED)*

**Location:** `usage.ts:219-244` (`#recordViaIngest`), `:246-285` (`#mutationWithAdmin`).
```ts
const res = await this.#fetch(url, { method: "POST", headers: {…}, body: … });
```

**Problem.** Neither path passes an `AbortSignal`. The DO alarm's `flushToConvex` (`wallet.ts:808`) `await`s `client.recordUsage(events)`; if the Convex site endpoint or `/api/mutation` hangs (TCP stall, Convex-side pause), the alarm task blocks with no upper bound. Pending settlements pile up un-acked; the DO stays in flush-attempt; credits remain reserved from the materialized balance until the platform eventually kills the alarm. No per-batch deadline, so one slow ingest blocks every subsequent settlement in the queue.

**Trigger.** Network pause or Convex-side slowness on either endpoint.

**Impact.** Stalled flush loop → delayed acks → growing pending queue → wallet balance drifts from authoritative ledger for the duration. Not permanent (server-side idempotency protects on retry) but an availability/latency defect on the billing-critical path.

**Fix.**
```ts
signal: AbortSignal.timeout(10_000),   // workerd supports AbortSignal.timeout
```
and treat `AbortError` as retryable.

---

### [SEV: P2] #5 — `#validateResult` / `parseRecordUsageResult` accept `results: []` and never enforce result↔event correspondence; `flushBatch.settleRefIds` lies  *(prior — VERIFIED + sharpened)*

**Location:** `usage.ts:287-298` (`#validateResult`), `:386-432` (`parseRecordUsageResult`), `:341-345` (`flushBatch` return).
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

**Problem.** Validation checks (a) all events share one consumer wallet and (b) the returned checkpoint wallet matches — but never that `result.results` is non-empty, that `result.results.length === events.length`, or that every submitted `settleRefId` has a corresponding outcome. `parseRecordUsageResult` accepts `results: []` as valid. It also accepts duplicate `refId`s and `refId`s not in the submitted batch — no dedup, no membership check.

The DO path is accidentally safe — `applySettlementResults` (`wallet.ts:718-757`) only acks ids present in `results` with status `applied`/`already_applied`, so missing outcomes stay pending and retry; foreign refs are filtered by the pending-set intersection. But `flushBatch` returns `settleRefIds: batch.map((e) => e.settleRefId)` — **all** submitted ids regardless of outcome — so any `flushBatch` caller that trusts `settleRefIds` as "acked" is lied to: rejected settlements appear in `settleRefIds` and would be wrongly dropped from a retry queue.

**Impact.** Silent acceptance of incomplete/malformed results; misleading `settleRefIds`; foreign-ref passthrough to callers that don't filter.

**Fix.**
```ts
if (result.results.length !== events.length)
  throw new Error("convex result count does not match batch size");
const expected = new Set(events.map((e) => e.settleRefId));
for (const r of result.results)
  if (!expected.has(r.refId))
    throw new Error(`convex result contains unknown refId ${r.refId}`);
// plus: dedup check on expected.
```
And have `flushBatch` return only `applied`/`already_applied` refIds in `settleRefIds`.

---

### [SEV: P2] #6 — No batch-size cap / chunking: `flushToConvex` sends an unbounded POST → Convex function timeout → livelock under backlog  *(NEW)*

**Location:** `usage.ts:155-189` (`ConvexUsageClient.recordUsage` accepts an unbounded array and POSTs it as one body); consumer `apps/gateway/src/wallet.ts:759-833` (`flushToConvex` builds `events` from **all** pending-with-usage settlements and calls `client.recordUsage(events)` in one shot).

**Problem.** Neither the client nor the DO caps batch size. `flushToConvex` does:
```ts
const flushable = … this.#pendingSettlements.filter(s => s.usage !== undefined) …
const events: ConvexUsageRecord[] = [];
for (const s of flushable) events.push(pendingToUsageRecord({…}));
const usageResult = await client.recordUsage(events);   // one POST, N events
```
The server-side `wallets:recordUsage` (`convex/wallets.ts:337-440`) processes each event serially inside one mutation transaction: per-event `walletEntries.by_ref` `.unique()` query, `ctx.db.get(project)`, balance check, `usageEvents` insert, `appendWalletEntry`, `publisherEarnings` `by_settlement` lookup + insert. That is O(N) serial DB round-trips in a single transaction. Convex internal mutations have a function execution time budget; a sufficiently large batch (sustained alarm failures during a traffic spike, or a backlog accumulated while Convex was degraded) will exceed it → Convex returns 5xx → `recordUsage` throws → `flushToConvex` returns `{ flushed: 0, error }` → **nothing** acked → `alarm()` re-arms in 5s → **same** giant batch → **same** timeout → permanent livelock. The pending queue only ever grows; no event ever lands in the ledger; the activity feed and `billing.cycleBreakdown` go empty for that org.

**Trigger.** Backlog from any sustained flush failure (incl. the P1 #2 admin-key breakage, a Convex region event, or the P2 #7 retry-forever on a 401).

**Impact.** Permanent stall of the billing-critical flush path under backlog; the larger the backlog, the harder it is to recover (the batch can never shrink because nothing is acked). No circuit breaker, no chunking, no partial ack.

**Fix.** Chunk inside `recordUsage` (or `flushToConvex`): cap at e.g. 100 events per POST, loop, and ack per-chunk. The server already returns per-event outcomes so partial ack is straightforward:
```ts
const MAX = 100;
for (let i = 0; i < events.length; i += MAX) {
  await this.#client.recordUsage(events.slice(i, i + MAX));  // caller acks per chunk
}
```

---

### [SEV: P2] #7 — No retryable-vs-terminal error classification: the DO retries 401 / config errors every 5s forever  *(NEW)*

**Location:** `usage.ts:219-244` (`#recordViaIngest` throws `convex ingest failed: 401 …` on a bad/missing secret indistinguishably from a 500), `:246-285` (`#mutationWithAdmin` same); consumer `apps/gateway/src/wallet.ts:808-823`:
```ts
const usageResult = await client.recordUsage(events).then(
  (r) => ({ ok: true as const, value: r }),
  (err) => ({ ok: false as const, err }),
);
if (!usageResult.ok) {
  return { flushed: 0, acked: 0, remaining: this.#pendingSettlements.length, error: message };
}
```
and `wallet.ts:1054-1059`:
```ts
if (hasUsage) await this.flushToConvex();
if (this.#pendingSettlements.length > 0)
  await this.ctx.storage.setAlarm(Date.now() + FLUSH_ALARM_MS);
```

**Problem.** `recordUsage` throws the same `Error` shape for transient (5xx, network, the P2 #4 hang) and terminal (401 bad secret, 400 malformed body, the P1 #2 admin-key shape breakage) failures. `flushToConvex` collapses every rejection into `error: message` and re-arms the alarm unconditionally while pending is non-empty. A 401 from a misconfigured/rotated `GATEWAY_INTERNAL_SECRET` will **never** succeed on retry, yet the DO retries every 5s forever — flooding Convex with 401s, accumulating every subsequent settlement in `#pendingSettlements` indefinitely, and diverging the working balance from the ledger permanently. Same for the P1 #2 admin-key breakage: a permanent 400/5xx retried forever. No circuit breaker, no dead-letter, no backoff, no alert hook.

**Impact.** A single config mistake (rotated secret, missing `GATEWAY_INTERNAL_SECRET` with admin-key fallback broken) silently turns into permanent billing divergence with no signal. The `FlushToConvexResult.error` string is returned to the alarm caller but never logged, metric'd, or surfaced.

**Fix.** Classify status codes in the client (return a typed `{ kind: "transient" } | { kind: "terminal", status }`), and in `flushToConvex`/`alarm`: log + emit a metric on terminal failures, stop re-arming the flush alarm for terminal errors (or backoff-exponentially), and surface a monitorable `flushStalled` state. At minimum, `console.error` the `error` string in `flushToConvex` (currently swallowed).

---

### [SEV: P3] #8 — `usageEventToRecord` stamps `at: Date.now()` (flush time) not request/settle time  *(prior — VERIFIED)*

**Location:** `usage.ts:348-362`.
```ts
return { …, at: Date.now(), settleRefId: `settle:${event.reservationId}` };
```

**Problem.** `at` is the wall clock when the record is *buffered*, not when the request happened. `UsageEvent` carries `latencyMs` and the pipeline computes `started`, but neither is propagated. `pendingToUsageRecord` (the live DO path) correctly uses `settledAt`. The two builders for the same logical event produce different `at` values; under load or delayed flush, `usageEventToRecord.at` drifts seconds-to-minutes from the true request time. `usageEvents.at` backs the `by_org_at` index used by `listForOrg` (`convex/usage.ts:34-50`) and its `since`/`until` filters — drift corrupts time-windowed usage/billing queries.

**Fix.** Accept `at` (or `started`) on `UsageEvent` and propagate it; mirror `pendingToUsageRecord`.

---

### [SEV: P3] #9 — `ConvexUsageSink.emit` silently drops `refunded` / `blocked` outcomes — diverges from `ConsoleUsageSink`  *(prior — VERIFIED)*

**Location:** `usage.ts:311-315`.
```ts
emit(event: UsageEvent): void {
  if (event.outcome !== "settled" && event.outcome !== "free") return;
  this.#pending.push(usageEventToRecord(event));
}
```

**Problem.** The pipeline emits usage events for every outcome including `refunded` (upstream non-2xx after a paid reservation) and `blocked`. `ConsoleUsageSink.emit` (the production sink) logs all of them. `ConvexUsageSink.emit` silently discards `refunded`/`blocked`. If `ConvexUsageSink` is ever swapped in for `ConsoleUsageSink`, refunded/blocked calls vanish from the usage stream — no analytics, no audit trail for failed-but-billed-reservation refunds. The two sinks have incompatible contracts despite implementing the same `UsageSink` interface.

**Fix.** Record all outcomes (matching `ConsoleUsageSink`), or document the filter as intentional and make the `UsageSink` interface contract explicit about which outcomes sinks must preserve.

---

### [SEV: P3] #10 — No client-side input validation in `recordUsage` before the network call  *(prior — VERIFIED)*

**Location:** `usage.ts:155-189`.

**Problem.** `recordUsage(events)` sends `events` straight to `#mutationFn` / `#recordViaIngest` / `#mutationWithAdmin` / `client.mutation` with zero validation of `credits` (≥0, integer — note `wallets.ts.md` already flagged that `recordUsage` rejects fractional credits), `at` (finite), `status` (integer), `latencyMs` (finite), `settleRefId` (non-empty), or `consumerClerkOrgId` (non-empty). The server validates each field and returns `status: "rejected"` per-event — so invalid events aren't applied — but every invalid batch costs a full Convex round-trip plus a rejected-outcome ledger entry.

**Impact.** Wasted Convex calls on malformed batches; rejected settlements catchable locally. Proportionate-rigor gap given the file parses the response strictly elsewhere.

**Fix.** Mirror the server's per-event validation client-side and throw before any network call.

---

### [SEV: P3] #11 — `ConvexUsageRecord.organizationId` is dead weight on the wire + actively misleading doc-comment  *(NEW)*

**Location:** `usage.ts:24-26` (type + doc), `:349-350` (`usageEventToRecord`), `:370` (`pendingToUsageRecord`); server `convex/wallets.ts:317-318` (`usageEventArg` requires `organizationId: v.id("organizations")`), `:414-415` (`recordUsage` ignores it).
```ts
export type ConvexUsageRecord = {
  /** Publisher's Convex org id — kept for compatibility. */
  organizationId: string;
  /** Consumer's Clerk org id — recordUsage resolves this to the wallet debited. */
  consumerClerkOrgId: string;
  …
};
```

**Problem.** The doc-comment says `organizationId` is "the Publisher's Convex org id — kept for compatibility." But `wallets.recordUsage` (`convex/wallets.ts:337-440`) **never reads `event.organizationId`**: it resolves the consumer org from `consumerClerkOrgId` via `getOrganizationByClerkId`, then inserts `usageEvents` with `organizationId: consumerOrg._id` (the *consumer's* org). So the publisher org id the gateway sends is validated (must be a valid `Id<"organizations">` format), cast in the httpAction (`convex/http.ts:377-380`), and **silently discarded**. The field is pure dead weight on the wire, and its doc-comment actively misrepresents what `usageEvents.organizationId` means: a future developer building a "publisher-side usage" query that filters `usageEvents` by `organizationId` thinking it's the publisher's org would silently query the **consumer's** org — a cross-org attribution bug with no type error.

**Impact.** Misleading contract; latent cross-org attribution bug for future callers. No current correctness defect (field is discarded).

**Fix.** Either delete `organizationId` from `ConvexUsageRecord` + `usageEventArg` (it's unused server-side), or — if the publisher org is genuinely needed for analytics — actually store it in a distinct `publisherOrganizationId` field (the schema already uses `publisherOrganizationId` on `publisherEarnings`, `wallet.ts:445`). Fix the doc-comment regardless: it is not "kept for compatibility," it is ignored.

---

### [SEV: P3] #12 — `FakeConvexUsageSink` diverges from the real client/server, hollowing out test fidelity  *(NEW)*

**Location:** `usage.ts:451-502` (`FakeConvexUsageSink.recordUsage`); consumers `apps/gateway/test/pipeline.test.ts:583,634`.

**Problem.** The fake's contract diverges from the real `ConvexUsageClient` + `wallets.recordUsage` in two ways:
1. **Empty batch.** Real `ConvexUsageClient.recordUsage([])` throws `"recordUsage requires at least one settlement"` (`usage.ts:158-160`, tested at `usage-client.test.ts:133-135`). The fake, on `events[0]?.consumerClerkOrgId` being `undefined`, rejects with `"mixed consumer wallet batch"` (`usage.ts:474-479`) — wrong message, wrong code path. A test exercising an empty batch through the fake would not catch an empty-batch regression in the real client.
2. **Per-event validation.** Real `recordUsage` server rejects events with `!Number.isSafeInteger(credits)`, `credits < 0`, non-finite `at`/`status`/`latencyMs`, empty `settleRefId` (`convex/wallets.ts:355-365`) with `status: "rejected"`. The fake applies **no** per-event validation — it debits `checkpoint.balance -= e.credits` for any numeric `credits` and dedupes by `settleRefId` only. A test that sends a fractional or negative `credits` through the fake will see it "applied"; the real server would reject it. The wallet-DO review already flagged a fractional-credits (`0.5`) retry-forever bug against the real server — the fake would mask exactly that class of regression.

**Impact.** Tests using `FakeConvexUsageSink` (`pipeline.test.ts:583,634`) cannot catch empty-batch or invalid-event regressions in the real flush path. Test-fidelity gap that explains how P1 #2 and the fractional-credits bug shipped.

**Fix.** Mirror the real contract in the fake: throw on empty batch with the real message, and reject invalid events with `{ status: "rejected", reason: "invalid settlement" }` matching `wallets.recordUsage`.

---

### [SEV: P3] #13 — Constructor footgun: injected `client` silently shadowed when `ingestUrl` + `internalSecret` are also set  *(NEW)*

**Location:** `usage.ts:121-153` (constructor), `:165-188` (`recordUsage` dispatch).
```ts
constructor(opts) {
  this.#ingestUrl = opts.ingestUrl;       // set unconditionally
  this.#internalSecret = opts.internalSecret;
  …
  else if (opts.client) { this.#client = opts.client; this.#convexUrl = …; }
  …
}
async recordUsage(events) {
  …
  if (this.#ingestUrl && this.#internalSecret) return this.#recordViaIngest(events);  // wins
  if (this.#adminKey && this.#convexUrl) return this.#mutationWithAdmin(...);
  if (!this.#client) throw new Error("ConvexUsageClient has no client");
  const result = await this.#client.mutation(recordUsageRef, { events });
}
```

**Problem.** If a caller passes `{ client, ingestUrl, internalSecret }`, the constructor's `else if (opts.client)` branch stores the injected `client`, but `recordUsage` checks the ingest path **first** and uses it — the injected `client` is silently ignored. The dispatch order in `recordUsage` (mutationFn → ingest → admin → client) does not match the constructor's selection order (mutationFn → client → ingest → else). A test that injects a `client` expecting it to be used, while also passing ingest creds "for completeness," would see fetches hit the ingest URL with no warning. No `console.warn`, no throw.

**Impact.** Confusing test/prod config; latent "why isn't my client being used" debugging trap. No correctness defect in current callers (they pass disjoint option sets).

**Fix.** Set `#ingestUrl`/`#internalSecret` only in the branch that intends to use them, or assert mutual exclusivity in the constructor and throw on ambiguous combinations.

---

### [SEV: P3] #14 — `settleRefId` format constructed in two places — single-point-of-truth violation  *(NEW)*

**Location:** `usage.ts:358` (`usageEventToRecord`), `:364-384` (`pendingToUsageRecord`); canonical producer `apps/gateway/src/wallet.ts:147` (`settlementIdFor`).

**Problem.** `usageEventToRecord` hardcodes the `settle:` prefix: `settleRefId: \`settle:${event.reservationId}\``. `pendingToUsageRecord` trusts the caller's `settlementId` verbatim — no prefix. The canonical producer is `settlementIdFor(reservationId) = \`settle:${reservationId}\`` in `wallet.ts:147`. Three definitions of the same invariant. If a caller ever passes a raw `reservationId` (un-prefixed) to `pendingToUsageRecord`, the server's `walletEntries.by_ref` dedup query (`convex/wallets.ts:380-382`) looks up a different `refId` than the one `settle()` recorded → no match → the settlement is inserted **twice** → double debit. Today safe (the DO always passes `s.settlementId`, which is already prefixed via `settlementIdFor`), but the contract is fragile: the invariant "settleRefId must equal `settle:${reservationId}`" is enforced by convention across three files with no shared helper.

**Impact.** Latent double-charge if any future caller breaks the convention. No current defect.

**Fix.** Export `settlementIdFor` from `wallet.ts` (or a shared `usage.ts` helper) and have **both** `usageEventToRecord` and `pendingToUsageRecord` call it, taking `reservationId` as input. Delete the inline `` `settle:${…}` `` template.

---

### [SEV: P3] #15 — Test coverage gaps directly explain the shipped P1s  *(NEW)*

**Location:** `apps/gateway/test/usage-client.test.ts` (5 tests, 136 lines).

**Problem.** The client test file exercises only: the happy ingest path, 401, 500, `mutationFn` preference, and empty-batch rejection. It does **not** cover:
- `#mutationWithAdmin` (admin-key path) — **zero** tests. This is why P1 #2 (wrong request shape) shipped. The body is never asserted against the official `mutationInner` shape.
- `flushBatch` failure-retry / lost-events — no test. This is why P1 #1 shipped. No test asserts `#pending` survives a `recordUsage` throw.
- `ConvexUsageSink.emit` outcome filtering, `pending` accumulation, `enqueue` — no test.
- `parseRecordUsageResult` edge cases: `results: []`, missing `wallet`, unknown `refId`, duplicate `refId`, non-finite `balance`, negative `sequence` — no test.
- `#validateResult` wallet-mismatch throw, multi-wallet batch throw — no test.
- `usageEventToRecord` / `pendingToUsageRecord` field mapping — no test.

The only `ConvexUsageSink`-adjacent coverage is `FakeConvexUsageSink` used as a mutation stub in `pipeline.test.ts:583,634` — and per #12 that fake diverges from real behavior.

**Impact.** The two highest-severity findings (P1 #1, P1 #2) exist precisely because the paths that carry them are untested. Adding the tests called for in #2 and #1's fixes would have caught both at authoring time.

**Fix.** Add tests for each bullet above; in particular a `#mutationWithAdmin` body-shape test against a stub `/api/mutation` and a `flushBatch`-throws-`#pending`-survives test.

---

## Summary

- **P0:** 0 · **P1:** 2 · **P2:** 5 · **P3:** 8 · **Total:** 15
- Prior review (1 P1 + 3 P2 + 3 P3 = 7) **all verified**; deep-dive **expands** by 1 P1 + 2 P2 + 5 P3.

**Top 3 to fix first:**
1. **#2 — `#mutationWithAdmin` sends `args: [args]` + `format: "json"`, the wrong shape for the Convex HTTP mutation API** (P1, NEW, live production fallback path, zero tests). Permanent silent usage loss + ledger divergence for any deployment without `GATEWAY_INTERNAL_SECRET`. Use the official `ConvexHttpClient` or match `convex_encoded_json` + `args: [convexToJson(args)]`; add a body-shape test.
2. **#1 — `flushBatch` drains `#pending` before `recordUsage`** (P1, prior, dead code today). Lost usage events on any transient failure once `ConvexUsageSink` is wired. Drain-on-success fix is one line.
3. **#7 + #6 — no retryable-vs-terminal error classification + no batch-size cap** (P2, NEW). Together: a terminal config error (incl. #2's broken admin path, or a rotated secret 401) retried every 5s forever, with an unbounded batch that can never shrink because nothing is acked → permanent livelock under backlog. Add status classification + circuit breaker/backoff + chunked flush.

**Verified-correct (explicitly, no findings):** usage emit is fire-and-forget via `ctx.waitUntil` and never blocks the response; failed-upstream calls are refunded (`outcome: "refunded"`, not charged); retry idempotency is enforced server-side by the `walletEntries.by_ref` unique index (duplicate inserts throw and roll back the whole mutation transaction, so no orphan `usageEvents`/`walletEntries` rows survive a concurrent-flush race).
