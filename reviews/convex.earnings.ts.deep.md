# Tiger Review — `convex/earnings.ts` (deep-dive)

Cross-read: `convex/accounting.ts`, `convex/usage.ts`, `convex/wallets.ts`,
`convex/schema.ts`, `convex/earnings.test.ts`, `convex/payouts.ts`.

## Verdict

**FAIL.** The 95/5 split math in `accounting.ts` is correct and the query is
auth-gated, but `earnings.forOrg` aggregates over **every** `publisherEarnings`
row regardless of status, so `reversed`/`failed`/`allocated_to_transfer`
settlements are summed into publisher-facing month and all-time totals. The
prior P1 is still live. Worse, the suite only seeds `status: "available"`, so
the bug is invisible to CI. Cross-file: consumer refunds in
`reversePaymentCredits` never reverse the corresponding `publisherEarnings`
row, so the platform absorbs refunded credits while the publisher's statement
keeps counting them. The query is also an unbounded full scan with no
aggregation index and N+1 project reads.

## File Stats

- File: `convex/earnings.ts` (108 lines)
- Index used: `by_publisher` (`publisherOrganizationId`, `createdAt`) — but
  `createdAt` is never bounded, so the entire org partition is collected.
- Split source: `accounting.publisherEarningSplit` — floored fee, remainder to
  publisher; `gross == fee + net` invariant holds.
- Tests: 1 happy-path case, `status: "available"` only.

## Findings

---

### [P1] Status filter missing in `forOrg` — reversed/failed/allocated inflate totals
**Location:** `convex/earnings.ts:60-72`
```ts
for (const earning of earnings) {
  allGross += earning.grossCredits;
  allNet += earning.netCredits;
  if (earning.createdAt >= monthStart) {
    monthCalls += 1;
    monthGross += earning.grossCredits;
    monthNet += earning.netCredits;
  }
  ...
}
```
**Problem:** The aggregation loop has no `status` guard. `publisherEarnings`
has six statuses (`pending_risk`, `available`, `allocated_to_transfer`,
`transferred`, `reversed`, `failed`). `reversed` (Stripe clawback) and `failed`
(permanently-failed transfer) rows still carry their original positive
`grossCredits`/`netCredits`, so they are summed into `allTime` and `month`.
`allTime.calls = earnings.length` (line 99) likewise counts reversed/failed
settlements as live calls.
**Impact:** Publisher statement overstates gross, net, and call count. A
publisher whose transfer was reversed by Stripe still sees those earnings as
"earned." Reconciliation against `payouts.getPayoutState` (which buckets by
status) is impossible — the two views disagree for the same org.
**Fix:** Exclude `reversed` and `failed` from `allTime`/`month`/`byProject`.
Preferably sum only `pending_risk | available | allocated_to_transfer |
transferred`, and surface a separate `reversed`/`failed` bucket in the return
type so the UI can show clawbacks distinctly. Use the `by_status_available`
index or a `filter` predicate — but better, restructure to a per-status
aggregate.

---

### [P1] Consumer refund never reverses `publisherEarnings` — platform eats refunded credits
**Location:** `convex/wallets.ts:163-189` (`reversePaymentCredits`), cross-file
with `convex/earnings.ts`.
**Problem:** `reversePaymentCredits` only appends a negative `walletEntries`
row for the consumer (`amount: -args.amount`). It does **not** locate the
`publisherEarnings` rows created by the original `recordUsage` settlements
funded by that payment and mark them `reversed` (or insert offsetting negative
earnings). `recordUsage` (wallets.ts:435-460) creates exactly one
`publisherEarnings` per settlement with `status: "pending_risk"`, keyed by
`usageSettlementRefId`. There is no inverse path on refund.
**Impact:** When a consumer payment is refunded/disputed, the consumer's
wallet is debited (correct), but the publisher's earning stays `available` and
is counted by `earnings.forOrg` forever. The platform is out the credits. This
is a money leak, and it directly inflates the numbers `forOrg` reports.
**Fix:** On `reversePaymentCredits`, locate `publisherEarnings` rows whose
underlying settlements were funded by `args.paymentId` (requires linking
`usageEvents.paymentId` → `publisherEarnings.usageSettlementRefId`) and either
flip them to `reversed` or insert a negative-offset earning with the same
`usageSettlementRefId` and `projectId` so `forOrg` nets to zero.

---

### [P1] Test suite does not cover the status filter — P1 is invisible to CI
**Location:** `convex/earnings.test.ts:32-46`
```ts
await ctx.db.insert("publisherEarnings", {
  ...
  status: "available",
  ...
});
```
**Problem:** The single test seeds one `available` earning and asserts
`allTime.netCredits === 95_001`. There are zero cases for `reversed`,
`failed`, `pending_risk`, `allocated_to_transfer`, or `transferred` exclusion;
zero cases for month bucketing across a month boundary; zero cases for
multi-project aggregation, deleted projects (`ctx.db.get → null` → "Unknown
project"), undefined `projectId`, cross-org isolation (a second org's earning
must not appear), or large-number safety.
**Impact:** The P1 above is undetectable by the suite. Any future regression
to status filtering will also be undetectable.
**Fix:** Add cases seeding mixed statuses and assert reversed/failed are
excluded from `allTime`/`month`/`byProject.calls`. Add a second org with an
earning and assert it does not leak. Add a `createdAt` before/after
`monthStart` pair. Add a deleted-project case.

---

### [P2] Unbounded full scan in `forOrg` — no `createdAt` bound, no limit, no aggregation index
**Location:** `convex/earnings.ts:41-46`
```ts
const earnings = await ctx.db
  .query("publisherEarnings")
  .withIndex("by_publisher", (q) =>
    q.eq("publisherOrganizationId", org._id),
  )
  .collect();
```
**Problem:** The `by_publisher` index is `["publisherOrganizationId",
"createdAt"]` but `createdAt` is never bounded, so `.collect()` pulls the
entire org partition into memory and aggregates in JS. There is no pagination,
no `.take()`, and no precomputed aggregate table. Every page load of the
earnings dashboard is O(N) in lifetime settlements.
**Impact:** For a high-volume publisher with millions of settlements, this
query grows without bound and will eventually time out or hit Convex's
document/read limits. The `by_status_available` index exists but is unused
here.
**Fix:** Either (a) bound the month scan with
`q.eq("publisherOrganizationId", org._id).gte("createdAt", monthStart)` for the
month bucket and maintain a running `allTime` aggregate in a denormalized
`orgEarningsSummary` table updated transactionally at settlement time; or (b)
adopt Convex's `aggregate` helper for running totals. At minimum, bound the
month range on the index.

---

### [P2] `releaseMatureEarnings` uses `.filter` instead of the `by_status_available` index
**Location:** `convex/payouts.ts:300-315`
```ts
const pending = await ctx.db
  .query("publisherEarnings")
  .withIndex("by_publisher", (q) =>
    q.eq("publisherOrganizationId", args.publisherOrganizationId),
  )
  .filter((q) => q.eq(q.field("status"), "pending_risk"))
  .collect();
```
**Problem:** The schema defines `by_status_available` =
`["status", "availableAt"]` precisely for `status="pending_risk" AND
availableAt <= now` range queries. This code instead scans the entire org
partition via `by_publisher` and filters in JS.
**Impact:** O(N) scan per cron tick per org, growing with lifetime earnings
rather than with the pending set (which is bounded by the 7-day risk window).
At scale this is wasteful and slow.
**Fix:**
```ts
.withIndex("by_status_available", (q) =>
  q.eq("status", "pending_risk").lt("availableAt", now),
)
```

---

### [P2] `creditsToUsdCents` floors per-transfer, losing fractional cents cumulatively
**Location:** `convex/accounting.ts:38-44`, consumed in
`convex/payouts.ts:386-388`.
```ts
return Math.floor((credits * 100) / CREDITS_PER_USD);
```
**Problem:** `preparePublisherTransfer` sums available `netCredits` then calls
`creditsToUsdCents` once per transfer, flooring to integer cents. Each
transfer loses up to 0.99¢ (≤99 credits). Across many small transfers a
publisher loses cumulative cents to the platform. The floor is asymmetric with
`publisherEarningSplit`'s floor (which is publisher-favorable on the fee);
here the floor is publisher-unfavorable on payout.
**Impact:** Minor but real money leak from publishers over time, especially
for high-volume/low-ticket publishers who trigger many small transfers.
**Fix:** Track a `carriedCredits` remainder on the org or transfer record and
include it in the next transfer's sum so the floor only bites once at the
boundary, not per transfer. Or document the policy explicitly and surface the
remainder in the UI.

---

### [P2] N+1 project lookups in `byProject` — no cache, no batching
**Location:** `convex/earnings.ts:74-84`
```ts
const byProject = await Promise.all(
  [...rows.entries()].map(async ([projectId, row]) => {
    const project = await ctx.db.get(projectId);
    ...
  }),
);
```
**Problem:** One `ctx.db.get` per distinct project. `usage.ts` solves the
same pattern with a `projectCache` Map (usage.ts:55-69); `earnings.ts`
re-fetches every time. For an org with many projects this is N concurrent
reads (mitigated by `Promise.all` parallelism but still N round-trips).
**Impact:** Wasteful reads; pattern inconsistency with sibling module.
**Fix:** Reuse the `projectCache` pattern from `usage.ts`, or add a
`projects.by_organization` index and batch-load all org projects in one query.

---

### [P2] `preparePublisherTransfer` retry blocks all future payouts on a permanently-failed transfer
**Location:** `convex/payouts.ts:317-330`
```ts
const retry = priorTransfers.find(
  (transfer) =>
    transfer.status === "created" ||
    transfer.status === "pending" ||
    transfer.status === "failed",
);
if (retry !== undefined) {
  return { transferId: retry._id, ... };
}
```
**Problem:** Any prior transfer in `created`/`pending`/`failed` is returned for
retry and the function never creates a new transfer. A transfer that failed
with a permanent reason (e.g., "account closed", "bank account rejected") is
retried forever; no max-retry count, no abandon-and-create-new path. The
publisher can never receive future earnings — they're stuck behind the dead
transfer.
**Impact:** Publisher payouts stall permanently after one permanent Stripe
failure. Earnings keep accumulating as `available` but are never withdrawable.
**Fix:** Add a retry counter / `nextRetryAt` backoff; after N failures or on
permanent failure codes, mark the transfer abandoned (new status or
`failureReason` gating) and exclude it from the `retry` find so a fresh
transfer can be created for the same earnings set (idempotency key is derived
from earning `_id`s, so a new set yields a new key).

---

### [P2] `byProject.calls` sum silently ≠ `allTime.calls` — unreconcilable
**Location:** `convex/earnings.ts:63-72` vs `:99`
```ts
if (earning.projectId === undefined) continue;
...
allTime: { calls: earnings.length, ... }
```
**Problem:** Earnings with `projectId === undefined` are counted in
`allTime.calls` and in `allGross`/`allNet` but skipped in `byProject`. So
`Σ byProject.calls` can be strictly less than `allTime.calls`, and the
difference is not surfaced anywhere in the return type.
**Impact:** UI showing `allTime.calls` and a project breakdown that doesn't
sum to it is confusing and looks like a bug to the publisher. Also masks
data-integrity issues (orphaned earnings with no project).
**Fix:** Either include an `unattributed` bucket in `byProject` carrying the
undefined-project rows, or assert/document the invariant and expose
`unattributedCalls`/`unattributedNet` in `OrgEarnings`.

---

### [P3] `new Date(now)` instantiated twice for year/month extraction
**Location:** `convex/earnings.ts:34-38`
```ts
const monthStart = Date.UTC(
  new Date(now).getUTCFullYear(),
  new Date(now).getUTCMonth(),
  1,
);
```
**Problem:** Two `new Date(now)` allocations where one suffices.
**Fix:** `const d = new Date(now); const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);`

---

### [P3] `localeCompare` without explicit locale — host-dependent sort
**Location:** `convex/earnings.ts:85-88`
```ts
byProject.sort(
  (left, right) =>
    left.name.localeCompare(right.name) ||
    left.slug.localeCompare(right.slug),
);
```
**Problem:** No locale argument; sort order varies by host default locale,
making the dashboard order non-deterministic across environments.
**Fix:** `localeCompare(other, "en")` or sort by `slug` alone (slugs are
already locale-stable ASCII).

---

### [P3] `availableAt` field unused in `forOrg` — month bucket keyed on `createdAt`
**Location:** `convex/earnings.ts:64`
```ts
if (earning.createdAt >= monthStart) { ... }
```
**Problem:** `availableAt` (the risk-hold release timestamp) is paid for in
the schema (`by_status_available` index) but never read by `forOrg`. The
"month" bucket reflects when the settlement was *created*, not when it
became *available*. This is defensible but the choice is undocumented and
means a settlement created on the 31st with `availableAt` on the 7th is
counted in the prior month while still being illiquid.
**Fix:** Document the choice, or offer both buckets (`createdAtMonth` vs
`availableAtMonth`).

---

### [P3] `EarningsBucket` lacks status breakdown — can't show pending vs available vs transferred
**Location:** `convex/earnings.ts:9-13`
```ts
export type EarningsBucket = {
  calls: number;
  grossCredits: number;
  netCredits: number;
};
```
**Problem:** The return type collapses all livable statuses into one
`netCredits`. `payouts.getPayoutState` separately exposes
`pendingRisk`/`available`/`allocated`/`transferred`/`reversed`/`failed`, but
`earnings.forOrg` gives no per-status view, forcing the UI to call both and
reconcile — which (per P1) it cannot, because `forOrg` includes reversed/failed.
**Fix:** Add a `byStatus: Record<SettlementStatus, EarningsBucket>` field, or
at minimum `pendingNet`/`availableNet`/`transferredNet` so the earnings page
can show withdrawable vs pending vs paid without a second query.

---

### [P3] Schema uses `v.number()` for credit fields — no integer guard at the storage layer
**Location:** `convex/schema.ts:284-286`
```ts
grossCredits: v.number(),
platformFeeCredits: v.number(),
netCredits: v.number(),
```
**Problem:** `accounting.publisherEarningSplit` validates
`Number.isSafeInteger` at write time, but the schema itself accepts floats or
non-safe integers. A future writer bypassing `publisherEarningSplit` could
store `grossCredits: 1.5` and silently corrupt the integer-cent invariant that
`creditsToUsdCents` and the aggregation loop rely on.
**Fix:** Use `v.int64()` for all credit fields so the database rejects
non-integers at insert time.

---

### [P3] No `since`/`until` filter — only the current calendar month is viewable
**Location:** `convex/earnings.ts:31-33`
```ts
args: { orgSlug: v.string() },
```
**Problem:** Unlike `usage.listForOrg` (which takes `since`/`until`), `forOrg`
hardcodes the month to the current UTC month. Publishers cannot view
historical months or arbitrary date ranges.
**Fix:** Accept optional `monthStart`/`monthEnd` args (or `since`/`until`) and
bound the `by_publisher` index range accordingly.

---

### [P3] `projectStripeTransfer` reversal sets terminal `reversed` without path back to `available`
**Location:** `convex/payouts.ts:544-560`
```ts
const earningStatus =
  args.state === "succeeded" ? "transferred" : args.state;
for (const earning of earnings) {
  await ctx.db.patch(earning._id, { status: earningStatus, ... });
}
```
**Problem:** On Stripe transfer reversal, earnings flip to terminal `reversed`
with no `availableAt` reset and no path to re-queue for a new transfer. If the
reversal is a temporary hold (e.g., review) rather than a permanent clawback,
those credits are stranded.
**Fix:** Distinguish `reversed_pending` (re-queueable) from
`reversed_terminal` (clawback), or add an explicit `requeueReversedEarnings`
mutation that flips `reversed` → `available` and clears `transferId`.

---

## Summary

- **Findings:** 16 total — P0: 0, P1: 3, P2: 6, P3: 7.
- Prior review (1 P1 + 3 P2 + 5 P3 = 9) **confirmed and expanded**. The prior
  P1 (status filter) is still live and now has a matching cross-file root
  cause (refund never reverses earnings) and a test gap.
- **Top 3:**
  1. **P1 — status filter absent:** `forOrg` sums `reversed`/`failed` into
     publisher totals; the suite doesn't catch it.
  2. **P1 — refund doesn't reverse earnings:** `reversePaymentCredits` only
     touches the consumer wallet; publisher earnings stay live forever,
     inflating `forOrg` and leaking platform credits.
  3. **P2 — unbounded full scan + retry deadlock:** `forOrg` is O(N) per load
     with no bound; `preparePublisherTransfer` blocks all future payouts
     behind any permanently-failed transfer.
