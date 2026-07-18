# Tiger Deep-Dive — `convex/usage.ts` + usage-ingestion hot path

## Verdict
NEEDS WORK. The ingestion path's core idempotency primitive (`walletEntries.by_ref` lookup + `already_applied` outcome) is sound for the **same-wallet** retry case the gateway actually performs, and the consumer wallet is correctly debited with a pre-check against negative balance. But the deep read surfaces one **P1 cross-org ledger leak** in the shared `appendWalletEntry` helper (reachable from `grantPaymentCredits` / `reversePaymentCredits` / `applyAdminAdjustment`), one **P1 dead-input / org-attribution gap** in `recordUsage` (`event.organizationId` is validated and discarded — publisher earnings flow from an unverified `projectId`), and a cluster of P2/P3 issues around batch caps, unbounded `cycleBreakdown.collect()`, redundant hot-path queries, and zero-credit ledger noise. The prior review's 2 P2 (missing composite indexes) are **VERIFIED** and restated below for completeness; this deep-dive expands into the ingestion mutation itself, which the prior review explicitly punted to a separate wallets.ts review.

## File Stats
- **Primary target:** `convex/usage.ts` (103 LOC) — the consumer-facing read path (`listForOrg`).
- **Deep-dive scope (per assignment):** the usage-ingestion hot path = `recordUsage` internal mutation in `convex/wallets.ts` (lines 316–461), the `/ingest-usage` httpAction + `parseIngestUsageBody` in `convex/http.ts` (lines 266–389), the `ConvexUsageClient` / `ConvexUsageSink` in `apps/gateway/src/usage.ts`, the `usageEvents` / `walletEntries` / `wallets` / `publisherEarnings` schema in `convex/schema.ts`, and the `publisherEarningSplit` helper in `convex/accounting.ts`. Test: `convex/ingest-usage.test.ts`.
- **Hot-path character:** wallet-DO alarm flush every ~5s (`apps/gateway/src/wallet.ts:175` `FLUSH_ALARM_MS = 5_000`) batches pending settlements → `wallets:recordUsage` → ack. The mutation is the authoritative ledger debitor and the publisher-earning creator. It MUST be idempotent against gateway retries; the gateway retains rejected items and replays them with the same `settle:{reservationId}` refId.

## Findings

### [P1] `appendWalletEntry` returns a FOREIGN wallet's checkpoint when a refId already exists on a different wallet — silent cross-org ledger leak
**Location:** `convex/wallets.ts:62-87` (`appendWalletEntry`), called by `grantPaymentCredits` (109-137), `reversePaymentCredits` (140-171), `applyAdminAdjustment` (174-199).

```ts
async function appendWalletEntry(ctx, args) {
  const existing = await ctx.db
    .query("walletEntries")
    .withIndex("by_ref", (q) => q.eq("refId", args.refId))
    .unique();
  if (existing !== null) {
    const wallet = await ctx.db.get(existing.walletId);     // <-- wallet B
    if (wallet === null) throw new Error("Wallet missing for existing entry");
    return { applied: false, wallet };                        // <-- returns wallet B to a caller that passed wallet A
  }
  ...
}
```

`recordUsage` (lines 379-392) defends against this explicitly: when `existing.walletId !== wallet._id` it returns `{ status: "rejected", reason: "settlement reference belongs to another wallet" }`. **The other three callers do not.** `grantPaymentCredits` then computes its return checkpoint as:

```ts
return {
  ...checkpoint(organization.clerkOrgId, result.wallet),   // clerkOrgId=A, result.wallet=B
  applied: result.applied,                                   // false
};
```

The returned checkpoint is `{ clerkOrgId: A, balance: B.balance, sequence: B.sequence, applied: false }` — i.e. the caller's own clerkOrgId paired with a **foreign wallet's balance and sequence**. The gateway client's `#validateResult` (`apps/gateway/src/usage.ts:227-241`) only checks `result.wallet.clerkOrgId === consumerClerkOrgId`, so it does **not** catch this: clerkOrgId matches A, the numbers are B's. The caller sees `applied: false` ("already applied") and stores B's balance/sequence as org A's authoritative checkpoint.

**Impact:** (1) Cross-org data leak — org A's payment-fulfillment code learns org B's wallet balance and sequence. (2) Correctness hazard — because `applied: false` is interpreted as "credits already granted to A", org A's payment is marked granted while org A's wallet never received the credits. A refId collision (e.g. a billing refactor that reuses a `stripe:payment_intent:*` refId across two orgs, or any future caller that reuses a refId namespace) silently drops a credit grant. `recordUsage` itself is immune; the exposure is the grant/reversal/adjustment path.

**Fix:** Make `appendWalletEntry` refuse cross-wallet refId reuse the same way `recordUsage` does, or thread the expected `organizationId`/`walletId` through and throw when `existing.walletId !== args.wallet._id`:

```ts
if (existing !== null) {
  if (existing.walletId !== args.wallet._id) {
    throw new Error("refId already belongs to a different wallet");
  }
  const wallet = await ctx.db.get(existing.walletId);
  if (wallet === null) throw new Error("Wallet missing for existing entry");
  return { applied: false, wallet };
}
```
Callers that receive a thrown error should treat it as a hard failure (not `applied: false`) so the payment-fulfillment state machine does not advance.

---

### [P1] `event.organizationId` is a dead input — publisher earnings are attributed from an unverified `projectId`, with no server-side cross-check
**Location:** `convex/wallets.ts:316-330` (arg shape), `:393-455` (handler). Also `convex/http.ts:301-343` (parser accepts and forwards it).

```ts
const usageEventArg = v.object({
  organizationId: v.id("organizations"),   // <-- publisher org id, per gateway type
  projectId: v.id("projects"),
  ...
  consumerClerkOrgId: v.string(),
});

// handler:
const project = await ctx.db.get(event.projectId);          // publisher project
...
await ctx.db.insert("publisherEarnings", {
  publisherOrganizationId: project.organizationId,         // <-- from project, NOT from event.organizationId
  projectId: project._id,
  usageSettlementRefId: event.settleRefId,
  ...
});
```

`event.organizationId` is accepted, validated as `v.id("organizations")`, and **never read** in the handler. The publisher earning's `publisherOrganizationId` is taken from `project.organizationId` (the project the gateway sent). There is no check that `event.organizationId === project.organizationId`. The consumer side (`consumerClerkOrgId`) is resolved to a wallet and debited, but the publisher side is attributed entirely from `event.projectId`, which the gateway supplies with no independent verification that (a) the project is published, (b) the project belongs to the asserted publisher, or (c) the consumer's `keyId` is authorized to call that project.

**Org-scoping answer (per the brief's explicit question):** YES — usage can be recorded for the wrong org's wallet and credited to the wrong publisher. The consumer org is determined solely by `consumerClerkOrgId` (gateway-asserted). The publisher earning is determined solely by `event.projectId` (gateway-asserted). A single gateway bug or a leaked `GATEWAY_INTERNAL_SECRET` lets the attacker debit org A's wallet while crediting publisher earnings to an arbitrary project (the `keyId` is stored but never validated against either org). Publisher earnings become real money (`publisherTransfers` → Stripe Connected Account payout), so this is a money-movement integrity gap, not just a metadata issue.

**Impact:** A compromised gateway secret or a gateway attribution bug misroutes real publisher earnings with no Convex-side alarm. The dead `event.organizationId` field is the natural verification anchor and is currently pure payload waste.

**Fix:** Validate the dead field against the looked-up project, and (defense-in-depth) verify the `keyId` belongs to the consumer org via `keySettings.by_key`:

```ts
const project = await ctx.db.get(event.projectId);
if (project === null) { /* reject */ continue; }
if (event.organizationId !== project.organizationId) {
  results.push({ refId: event.settleRefId, status: "rejected",
    reason: "project organization mismatch" });
  continue;
}
```
If `event.organizationId` is genuinely redundant, remove it from `usageEventArg` and the `IngestUsageEvent` type so the contract cannot lie. Today it is the worst kind of input — accepted, type-checked, and ignored.

---

### [P2] VERIFIED — No composite index for `projectId` or `keyId` filtering within an org (prior P2 #2)
**Location:** `convex/schema.ts:107-111` (usageEvents indexes), consumed at `convex/usage.ts:34-50`.

```ts
.index("by_org", ["organizationId"])
.index("by_project", ["projectId"])
.index("by_org_at", ["organizationId", "at"])
.index("by_project_at", ["projectId", "at"])
.index("by_at", ["at"]),
```

**Verified:** No `by_org_project_at` (`[organizationId, projectId, at]`) and no `by_org_key_at` (`[organizationId, keyId, at]`) exist. `by_project_at` lacks `organizationId` so it cannot substitute without scanning every consumer org's calls to a publisher project — a latent cross-org leak vector if a future refactor naively swaps the index. Both filters fall through to post-index JS filtering.

**Impact:** The `keyId` filter — a first-class feature of the activity UI — can never be index-applied. For a high-volume consumer org this is the difference between a 25-row bounded index page and a multi-page scan that discards most rows.

**Fix:** Add `by_org_project_at` and `by_org_key_at`, then route `listForOrg` to the appropriate index based on which filter is present (keep `by_org_at` for the unfiltered path).

---

### [P2] VERIFIED — Post-index `projectId`/`keyId` filtering yields empty/undersized pages and a stale "more data" signal (prior P2 #1)
**Location:** `convex/usage.ts:64-72` (filter `continue`s), `:92-96` (`return { ...result, page }`).

```ts
for (const event of result.page) {
  if (args.projectId !== undefined && event.projectId !== args.projectId) { continue; }
  if (args.keyId !== undefined && event.keyId !== args.keyId) { continue; }
  ...
}
return { ...result, page };
```

**Verified:** `result.isDone` / `result.continueCursor` come from the unfiltered index scan. The returned `page` can be empty (or far shorter than `numItems`) while `isDone === false`. The activity UI (`ACTIVITY_PAGE_SIZE = 25`) renders "Load more" on `!isDone && continueCursor !== null`, so for a selective `keyId` filter on a high-volume org the user can click "Load more" and receive zero rows, repeatedly, until the scan lands on a matching event.

**Impact:** Activity feed appears hung for any org whose event distribution is skewed across keys/projects. Worst case O(total_events / numItems) round-trips to assemble a small filtered set. No data corruption.

**Fix:** Push `projectId`/`keyId` into the index (see prior finding). If index additions are rejected, at minimum document that `page.length < numItems` does not imply `isDone` and have the web client auto-continue through empty pages when a filter is active.

---

### [P2] `recordUsage` has no batch cap — only the httpAction caps at 500; the adminKey and injected-mutation paths bypass it
**Location:** `convex/wallets.ts:334` (`args: { events: v.array(usageEventArg) }` — unbounded), `convex/http.ts:266` (`MAX_INGEST_EVENTS = 500`), `apps/gateway/src/usage.ts:204-219` (`#mutationWithAdmin` posts raw `args` with no cap).

```ts
// wallets.ts
export const recordUsage = internalMutation({
  args: { events: v.array(usageEventArg) },           // no maxItems
  ...
});

// http.ts caps the shared-secret path at 500
const MAX_INGEST_EVENTS = 500;
```

The httpAction path caps at 500, but `ConvexUsageClient` has two other transports: `#mutationWithAdmin` (raw `POST /api/mutation` with deploy key) and an injected `mutationFn` (tests). Both send `args.events` with no cap. Convex's ~1MB arg limit bounds the raw payload, but a 50k-event batch (small events) still passes the wire and runs ~150k+ DB ops (3+ queries + 3 inserts per applied event) in a single transaction. Convex aborts oversized transactions, but the failure mode is an opaque 500 to the gateway, which then retries the whole batch — amplifying load.

**Impact:** A misconfigured flush or a test that exercises the adminKey path can trigger oversized transactions. The shared-secret path is safe; the other two are not.

**Fix:** Enforce the cap inside the mutation itself so every transport inherits it:

```ts
if (args.events.length > 500) {
  throw new Error("recordUsage batch exceeds 500 events");
}
```

---

### [P2] `cycleBreakdown` does an unbounded `.collect()` over the month's usageEvents — directly fed by `recordUsage` writes
**Location:** `convex/billing.ts:988-1010` (cross-file, but direct downstream consequence of the ingestion path).

```ts
const events = await ctx.db
  .query("usageEvents")
  .withIndex("by_org_at", (q) =>
    q.eq("organizationId", org._id).gte("at", cycleStart).lt("at", cycleEnd),
  )
  .collect();                                            // unbounded
```

Unlike `admin.platformStats` (which caps at `USAGE_STATS_CAP = 50_000` via `.take`) and `analytics.ts` (which caps at `ORG_SCAN_CAP = 5_000`), `cycleBreakdown` collects **every** event for the org in the current UTC month into a single query's memory. A high-volume consumer org with millions of calls/month will OOM the query or hit Convex's row/materialization limits. The prior `analytics.ts` comment at `:8-9` even says "a by_org_at index is the fix" — `by_org_at` now exists, but `cycleBreakdown` still collects unbounded.

**Impact:** Month-end billing breakdown fails for heavy consumers. Not a `recordUsage` bug, but the ingestion path is what grows the table; the unbounded collect is the cliff.

**Fix:** Paginate or cap (e.g., `.take(50_000)` with a `truncated` flag like `analytics.ts`), or pre-aggregate into a monthly `usageRollups` table during ingestion. At minimum, match the `USAGE_STATS_CAP` pattern.

---

### [P2] `walletEntries.refId` uniqueness is not DB-enforced — cross-wallet concurrent insert can duplicate a refId
**Location:** `convex/schema.ts:115-127` (`by_ref` is an index, not a unique constraint), `convex/wallets.ts:62-72` (lookup-then-insert).

Convex indexes are not unique constraints; `.unique()` is a query-time assertion, not a write guard. For the **same wallet**, two concurrent `recordUsage` mutations patch the same wallet doc, so Convex's OCC serializes them and the second sees the first's `walletEntries` insert → `already_applied`. Safe. But for **different wallets**, two concurrent `recordUsage` mutations with the same `settleRefId` (a gateway bug reusing a `reservationId` across consumer orgs) touch disjoint wallet docs and disjoint `walletEntries` docs. Convex's OCC is document-level, so both pass the `by_ref` lookup (find nothing) and both insert a `walletEntry` with the same refId on different wallets. The `by_ref` index then has two entries. `recordUsage`'s cross-wallet check (`existing.walletId === wallet._id`) would catch this only on a *later* retry of the same refId, not on the initial concurrent insert.

**Impact:** Requires a gateway bug (cross-org reservationId reuse) to trigger, but if triggered, the same settlement is debited from two consumer wallets and two publisher earnings are created — a double-spend with no alarm. The system relies on `settle:{reservationId}` being globally unique, enforced only by the wallet DO's per-org reservation id space.

**Fix:** Either (a) make `refId` globally unique by construction and document the invariant as load-bearing (it already is — but a Convex-side guard would be cheap), or (b) accept the risk and add a monitor query that scans `by_ref` for duplicates. A true unique constraint is not a Convex primitive today, so the realistic fix is to assert uniqueness at the application layer and alarm on `by_ref` duplicates.

---

### [P2] Redundant `walletEntries.by_ref` query per applied event on the hot path
**Location:** `convex/wallets.ts:379-382` (recordUsage pre-check) + `:65-68` (appendWalletEntry re-check).

```ts
// recordUsage loop:
const existing = await ctx.db
  .query("walletEntries")
  .withIndex("by_ref", (q) => q.eq("refId", event.settleRefId))
  .unique();                                  // query #1
if (existing !== null) { ... continue; }
...
const settled = await appendWalletEntry(ctx, {
  wallet, kind: "usage_settlement", amount: -event.credits, refId: event.settleRefId, usageEventId,
});
// inside appendWalletEntry:
const existing = await ctx.db
  .query("walletEntries")
  .withIndex("by_ref", (q) => q.eq("refId", args.refId))
  .unique();                                  // query #2 — same refId, same transaction, read-your-writes
```

Within a single Convex mutation, reads see prior writes in the same transaction. `recordUsage` already did the `by_ref` lookup; `appendWalletEntry` re-does it. For a 500-event batch that's 500 extra indexed `.unique()` queries on the hot path. The re-check is needed for `grantPaymentCredits` / `reversePaymentCredits` / `applyAdminAdjustment` (which do not pre-check), but `recordUsage` could call a leaner variant that skips it.

**Impact:** ~2× the indexed reads on the ingestion hot path. Bounded (each is an indexed `.unique()`) but wasteful at batch scale.

**Fix:** Split `appendWalletEntry` into a checked and an unchecked variant, or have `recordUsage` inline the insert (it already did the cross-wallet branch that `appendWalletEntry` lacks).

---

### [P3] `credits === 0` passes validation — zero-credit settlements consume a ledger row, a sequence number, and a publisher earning
**Location:** `convex/wallets.ts:365-366` (`event.credits < 0` only), `:426-456`.

```ts
if (
  event.settleRefId.trim() === "" ||
  !Number.isSafeInteger(event.credits) ||
  event.credits < 0 ||                        // <-- 0 passes
  ...
) { ... reject ... }
```

The gateway's `ConvexUsageSink.emit` (`apps/gateway/src/usage.ts:308-311`) buffers `outcome === "settled" || outcome === "free"`, and a "free" outcome carries `cost: 0` → `credits: 0`. A 0-credit settlement creates a `usageEvents` row, a `walletEntries` row with `amount: 0` (wallet sequence still increments), and a `publisherEarnings` row with `grossCredits: 0, platformFeeCredits: 0, netCredits: 0`. The ledger is correct but bloated with zero-value entries; the wallet `sequence` advances for no economic change, which matters because the wallet DO uses `sequence` for checkpoint reconciliation (more sequence noise to track).

**Impact:** Ledger/index bloat proportional to free-tier call volume. No correctness bug.

**Fix:** Either short-circuit 0-credit events to a usage-event-only insert (no walletEntry, no earning), or reject them as "invalid settlement" if free-tier calls should never reach settlement. Decide and document.

---

### [P3] No range validation on `at`, `status`, `latencyMs` — negative/fractional/future values are stored
**Location:** `convex/wallets.ts:367-370` (`Number.isFinite` only), `convex/http.ts:317-327` (parser also finite-only).

```ts
!Number.isFinite(event.at) ||
!Number.isFinite(event.status) ||
!Number.isFinite(event.latencyMs)
```

`at` can be negative, fractional, or far-future (stored as the `at` index key, so it pollutes the `by_org_at` / `by_project_at` / `by_at` ranges). `status` can be any finite number, not an HTTP status. `latencyMs` can be negative. The http parser and the mutation both check `Number.isFinite` but neither checks ranges. A buggy gateway (clock skew, negative latency from a timer bug) silently poisons the activity feed's time ordering.

**Impact:** Latent analytics/ordering corruption. No settlement correctness impact (these fields are not used for debit logic).

**Fix:** Add `event.at >= 0`, `event.status >= 100 && event.status < 600`, `event.latencyMs >= 0` to the rejection guard.

---

### [P3] `settleRefId` has no max-length check — stored as an indexed key
**Location:** `convex/wallets.ts:364` (only `trim() === ""` check), `convex/schema.ts:115-127` (`by_ref` indexes `refId`).

`settleRefId` is stored on `usageEvents.settleRefId` and `walletEntries.refId`, and `refId` is the leading field of the `by_ref` index. There is no length cap. A malicious or buggy gateway could send arbitrarily long refIds, bloating the index and the table.

**Impact:** Index/table bloat only. The gateway constructs `settle:${reservationId}` so this is defense-in-depth.

**Fix:** Cap `settleRefId` length (e.g., `<= 128` chars) in the rejection guard.

---

### [P3] `args.events[0]!` non-null assertion relies on the `length === 0` guard above — refactor-fragile
**Location:** `convex/wallets.ts:341`.

```ts
if (args.events.length === 0) { throw new Error("At least one settlement is required"); }
const clerkOrgId = args.events[0]!.consumerClerkOrgId;
```

The `!` is sound today only because of the guard immediately above. If the guard is moved or the array is mutated between the check and the read, the assertion silently lies to the type system.

**Fix:** Destructure after the guard: `const [first, ...rest] = args.events; const clerkOrgId = first.consumerClerkOrgId;` — no assertion needed.

---

### [P3] `existingEarning` check is defensive-only — redundant within the `recordUsage`-only flow
**Location:** `convex/wallets.ts:437-456`.

```ts
const existingEarning = await ctx.db
  .query("publisherEarnings")
  .withIndex("by_settlement", (q) => q.eq("usageSettlementRefId", event.settleRefId))
  .unique();
if (existingEarning === null) {
  await ctx.db.insert("publisherEarnings", { ... });
}
```

This is reached only after the `walletEntries.by_ref` pre-check found no existing entry (otherwise the loop `continue`d at `:383-392`). Within a single `recordUsage` transaction, no prior earning can exist for this refId unless it was created by another code path — `publisherEarnings` are only inserted here. So this lookup always returns `null` in the recordUsage-only flow. It is a third indexed query per applied event (after the `by_ref` pre-check and the `appendWalletEntry` re-check). Defensible as a guard against future out-of-band earning creation, but it is dead weight on the hot path today.

**Impact:** One extra indexed query per applied event. No correctness gain in the current architecture.

**Fix:** Either drop the check (rely on `walletEntries.by_ref` as the single idempotency gate) or document it as a load-bearing invariant guard for future earning-creation paths.

---

### [P3] `usageEvents.settleRefId` has NO index — any future "lookup event by settlement ref" is a full table scan
**Location:** `convex/schema.ts:97-111` (no `by_settle_ref` index on `usageEvents`).

`settleRefId` is the documented correlation key between the activity feed (`usageEvents._id`) and the ledger (`walletEntries.usageEventId` → `usageEvents._id`, `walletEntries.refId === usageEvents.settleRefId`). Today no query looks up `usageEvents` by `settleRefId` (`recordUsage` uses `walletEntries.by_ref`), so there is no current scan. But the field is optional ("solely for pre-ledger historical analytics rows") and unindexed, so any future support/debug query ("find the usageEvent for this settlement ref") is a full scan of a high-volume table.

**Impact:** Latent. No current scan, but the missing index is a trap for the next person who needs to correlate.

**Fix:** If correlation queries are expected, add `.index("by_settle_ref", ["settleRefId"])` (note: settleRefId is optional, so the index would include `undefined` for historical rows — acceptable). If not expected, document that `settleRefId` is display-only.

---

### [P3] `getOrCreateWallet` creates an empty wallet row as a side effect of ingesting usage for a never-paid consumer org
**Location:** `convex/wallets.ts:345` (`getOrCreateWallet(ctx, consumerOrg._id)` inside `recordUsage`), `:18-33` (the helper inserts `balance: 0, sequence: 0`).

If the gateway sends a batch with `consumerClerkOrgId` that resolves to a real org that has never had a payment grant, `recordUsage` creates a wallet row with `balance: 0, sequence: 0`. The first event in the batch will then be rejected for "insufficient authoritative balance" (unless `credits === 0`). The wallet row persists. A malicious/buggy gateway probing consumer orgs by clerkOrgId would leave behind empty wallet rows for every org it names.

**Impact:** Orphan wallet rows. No economic impact (balance 0), but it pollutes `wallets.by_organization` and `walletEntries.by_wallet` for orgs that never transacted.

**Fix:** Only create the wallet lazily when a settlement will actually apply, or accept the side effect and document it. Low priority.

---

### [P3] `Date.now()` (server) vs gateway-provided `at` — clock skew means the activity feed and the ledger can disagree on ordering
**Location:** `convex/wallets.ts:426` (`usageEventId` row uses `event.at`), `:74` (`walletEntry.createdAt = Date.now()`), `:444-453` (`publisherEarning.createdAt/updatedAt = Date.now()`).

The `usageEvents.at` field is gateway-provided and is the index key for `by_org_at` / `by_project_at` / `by_at`. The `walletEntries.createdAt` and `publisherEarnings.createdAt` use the Convex server clock. If the gateway clock is skewed (even by seconds), the activity feed (ordered by `at`) and the ledger (ordered by `sequence`/`createdAt`) can disagree on event order. For a settlement debited at gateway-time T but ledger-stamped at server-time T+2s, a concurrent event from another batch could ledger-stamp between them.

**Impact:** Cosmetic ordering inconsistency between the activity feed and the wallet ledger. No settlement correctness impact (sequence is the authoritative ledger order, not time).

**Fix:** None required; document that `at` is gateway-time and `createdAt` is server-time, and that `sequence` (not `at`) is the ledger's authoritative order.

---

### [P3] Rejected settlements leave no `usageEvents` trace — a served-but-unsettled call is invisible in the activity feed
**Location:** `convex/wallets.ts:371-410` (only the "applied" branch inserts `usageEvents` at `:412-425`).

A settlement rejected for "insufficient authoritative balance", "project not found", or "invalid settlement" inserts no `usageEvents` row. In the intended gateway flow this is correct (a "blocked" outcome should never reach `recordUsage` — `ConvexUsageSink.emit` only buffers `settled` / `free`). But if a race or a gateway bug sends a settlement that Convex rejects, the consumer's activity feed shows no record of the attempt, and there is no `usageEvents` row to correlate with the rejected `settleRefId` the gateway retained.

**Impact:** Support/debugging gap for rejected settlements. No economic impact (rejected = not debited).

**Fix:** Optionally insert a `usageEvents` row with a `rejected` status field for rejected settlements, or document that rejected settlements are tracked only in the gateway's retry queue, not in Convex.

---

### [P3] httpAction casts `string` → `Id<...>` unsoundly — malformed ids yield 500 instead of 400
**Location:** `convex/http.ts:378-381`.

```ts
events: parsed.events.map((event) => ({
  ...event,
  organizationId: event.organizationId as Id<"organizations">,
  projectId: event.projectId as Id<"projects">,
})),
```

`parseIngestUsageBody` validates that `organizationId` and `projectId` are non-empty strings, but not that they are well-formed Convex `Id`s. The cast lies to the type system; the mutation's `v.id(...)` validator catches malformed ids and throws, which the httpAction catches and returns as a generic 500. The gateway then retries (it should not, since the id is permanently malformed).

**Impact:** A malformed id yields 500 (retryable) instead of 400 (terminal). The gateway may retry forever on a permanently-bad id.

**Fix:** Validate `Id` format in the parser and return 400, or accept the 500 and rely on the gateway's dead-letter handling.

---

### [P3] Test coverage gaps — several load-bearing invariants of the ingest contract are untested
**Location:** `convex/ingest-usage.test.ts` (3 tests only).

The existing tests cover: empty-batch rejection, mixed-consumer rejection, applied/already_applied/rejected-insufficient-balance, the authoritative checkpoint, and the balance/sequence ledger invariant. **Not covered:**

1. **Cross-wallet refId reuse** — `recordUsage` returns `rejected: "settlement reference belongs to another wallet"` (lines 386-391). Untested. This is the exact branch that the P1 `appendWalletEntry` leak bypasses for the other callers; a regression test here would have caught the P1.
2. **Duplicate `settleRefId` within a single batch** — two events with the same refId in one `recordUsage` call. The second should be `already_applied` (read-your-writes within the transaction). Untested.
3. **`credits === 0`** — the free-outcome path. Untested.
4. **Negative / fractional `at`, `status`, `latencyMs`** — validation boundaries. Untested.
5. **`event.organizationId` mismatch with `project.organizationId`** — the P1 dead-input gap. Untested (and currently not even rejected).
6. **Batch > 500 via httpAction** — the `MAX_INGEST_EVENTS` cap. Untested.
7. **Publisher-earning idempotency across batches** — the `existingEarning` guard. Untested.
8. **Out-of-order delivery** — a retried batch with an older `at` arriving after newer events. Untested.
9. **`grantPaymentCredits` / `reversePaymentCredits` / `applyAdminAdjustment` with a refId that collides across wallets** — the P1 leak. Untested.

**Impact:** The contract's invariants are broader than the tests. The P1 findings would likely have been caught by tests 1 and 9.

**Fix:** Add tests for each of the above; prioritize 1, 5, and 9.

---

## Summary
**Counts:** P0: 0 · P1: 2 · P2: 6 · P3: 11

**Top 3 to fix first:**
1. **`appendWalletEntry` cross-wallet refId leak (P1)** — `grantPaymentCredits` / `reversePaymentCredits` / `applyAdminAdjustment` silently return a foreign wallet's balance/sequence when a refId already exists on another wallet. Add the same `existing.walletId !== args.wallet._id` guard that `recordUsage` already has, and throw (not `applied: false`) so payment fulfillment does not advance.
2. **`event.organizationId` dead input + unverified publisher attribution (P1)** — publisher earnings flow from an unverified `event.projectId` with no cross-check against `event.organizationId` (which is accepted and discarded). Either validate `event.organizationId === project.organizationId` and verify the `keyId`↔consumer-org linkage, or remove the field from the contract. A gateway bug or leaked secret can misroute real publisher earnings with no Convex-side alarm.
3. **Add `by_org_project_at` and `by_org_key_at` composite indexes and route `listForOrg` to them (P2, verified)** — root cause of the empty-page UX cliff on the activity feed; the read path is the only finding with visible product impact today.

**Idempotency verdict:** The core retry idempotency (`walletEntries.by_ref` + `already_applied` for same-wallet retries) is correct and survives gateway retries, including in-batch duplicates (read-your-writes within the Convex transaction). The gaps are (a) the cross-wallet refId collision path (P1 leak in `appendWalletEntry`, P2 concurrent cross-wallet duplicate insert not DB-enforced), and (b) the unverified publisher attribution (P1). Negative-balance is correctly guarded for usage settlement; refunds/disputes intentionally create debt. Batch caps exist only on the shared-secret transport, not the mutation itself.
