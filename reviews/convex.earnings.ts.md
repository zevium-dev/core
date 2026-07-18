# Tiger-Style Review — `convex/earnings.ts`

## Verdict
NEEDS WORK — the query is small and reads the right source (immutable `publisherEarnings`), but it has one load-bearing scalability defect that will break the /app/earnings page for every successful publisher, plus a real correctness gap around `status` (refunded / failed / pending earnings are all summed into one number the publisher reads as "earned"), and several smaller reconciliation and determinism holes. Not safe to ship as the sole earnings surface without the P1 and P2 fixes below.

## File Stats
- **Path:** `convex/earnings.ts`
- **LOC:** 86
- **Role:** Single public query `forOrg` that produces a publisher-facing earnings statement (per-project rows + current-month + all-time buckets) from the immutable `publisherEarnings` table. Consumed by `apps/web/src/components/project-earnings-panel.tsx:24` (`useSuspenseQuery(convexQuery(api.earnings.forOrg, { orgSlug }))`) and the `/app/earnings` org dashboard.
- **Authorization:** `requireOrgMemberBySlug` (lib/auth.ts:63) binds `org._id` to the caller's Clerk `org_id` claim; the `by_publisher` index then eq-filters on `publisherOrganizationId = org._id`. Cross-org reads are rejected. No leak there.
- **Producers of `publisherEarnings`:** `convex/wallets.ts:444` (`recordUsage`, one row per settled usage event, `status: "pending_risk"`), status transitions in `convex/payouts.ts` (`releaseMatureEarnings` → `available`; `preparePublisherTransfer` → `allocated_to_transfer`; `markPublisherTransferSucceeded` → `transferred`; `markPublisherTransferFailed` → `failed`). No code path ever writes `status: "reversed"` (grep: zero matches) — refunds/disputes call `reversePaymentCredits` (wallets.ts:163) which debits only the consumer wallet and never touches `publisherEarnings`.
- **Test coverage:** `convex/earnings.test.ts` — one test, seeds one fully-populated row, asserts `allTime` and `byProject[0]`. No coverage of: multi-row accumulation, `month` window boundaries, undefined `projectId`, multi-status mixtures, scale, deleted projects, or sort determinism.

---

## Findings

### [SEV: P1] Unbounded `.collect()` over the entire org partition will throw for any successful publisher

**Location:** `convex/earnings.ts:41-46`

```ts
const earnings = await ctx.db
  .query("publisherEarnings")
  .withIndex("by_publisher", (q) =>
    q.eq("publisherOrganizationId", org._id),
  )
  .collect();
```

**Problem:** One `publisherEarnings` row is inserted per settled usage event (`wallets.ts:444`), so the row count for an org grows linearly with lifetime call volume — there is no rollup, no monthly summary, no compaction. `forOrg` calls `.collect()` with **no `createdAt` range bound** on the `by_publisher` (`["publisherOrganizationId", "createdAt"]`) index, so every invocation scans the entire org partition into memory and then iterates it in JS.

Convex caps `db.query(...).collect()` (result byte size + document count). A publisher with on the order of tens of thousands of settled calls — the realistic steady state for any marketplace publisher doing real volume — will exceed that cap and the query throws, taking down both the `/app/earnings` dashboard and every project's Earnings tab (`project-earnings-panel.tsx:24` calls this query under `useSuspenseQuery`, so a throw is a hard crash of the route, not a graceful empty state). The single test seeds exactly one row, so this fails only in production.

The `by_publisher` index already orders by `createdAt`, so the month bucket could at least be served by a bounded range scan — but `allTime` fundamentally cannot be served by scanning every row on every page load.

**Impact:** Hard outage of the earnings surface for the publishers the product exists to serve. Universal under load (no input assumption beyond "publisher is successful"), so P1.

**Fix:** Maintain a materialized `publisherEarningsMonthly` aggregate table `{publisherOrganizationId, projectId, monthStart, calls, grossCredits, netCredits, statusBucket}` updated inside `recordUsage` and the status-transition mutations, and have `forOrg` sum a small number of monthly rows instead of every event. Short-term mitigation: paginate `forOrg` (already supported by the Convex pagination pattern used in `usage.ts`) and bound the `by_publisher` scan by `createdAt >= monthStart` for the month bucket.

---

### [SEV: P2] No `status` filter — `pending_risk`, `failed`, and any future `reversed` earnings are summed into the publisher's totals

**Location:** `convex/earnings.ts:48-62`

```ts
for (const earning of earnings) {
  allGross += earning.grossCredits;
  allNet += earning.netCredits;
  if (earning.createdAt >= monthStart) {
    monthCalls += 1;
    monthGross += earning.grossCredits;
    monthNet += earning.netCredits;
  }
  if (earning.projectId === undefined) continue;
  // ... accumulate into byProject
}
```

**Problem:** The aggregation sums `grossCredits`/`netCredits` for every row regardless of `status`. The schema (`schema.ts:285-292`) defines six statuses: `pending_risk`, `available`, `allocated_to_transfer`, `transferred`, `reversed`, `failed`. Two concrete problems:

1. **`pending_risk` is conflated with realized earnings.** `pending_risk` rows are still inside the 7-day fraud/refund risk hold (`PUBLISHER_RISK_HOLD_MS`, accounting.ts:8) and are explicitly excluded from payouts — `preparePublisherTransfer` (payouts.ts:366) filters `status === "available"` only. Yet `forOrg` presents pending and matured earnings as a single `netCredits` figure with no `pending` vs `available` distinction. The publisher's statement therefore never reconciles with their withdrawable balance (computed independently in the payout flow), and the web panel (`project-earnings-panel.tsx`) renders the lump as "you keep 95%" with a `$` equivalent — overstating realizable earnings.

2. **`failed` rows are counted as earned.** `markPublisherTransferFailed` (payouts.ts:478) patches all earnings on a failed transfer to `status: "failed"`. `forOrg` still counts them. Whether a `failed` transfer is eventually retried or abandoned, the figure shown to the publisher during the failure window is incorrect relative to what is realizable.

3. **Refunds never reverse publisher earnings.** `billing.ts:786` calls `reversePaymentCredits` on refund/dispute, which debits only the *consumer* wallet — no `publisherEarnings` row is ever inserted with `status: "reversed"` or negative amounts, and no existing earning is patched. So a refunded call remains as a positive earning in `forOrg` forever. The `reversed` status exists in the schema for this purpose but is dead (grep: zero write sites). The publisher is credited for revenue that was returned to the consumer.

**Impact:** Earnings statement diverges from realizable/paid balance; refunds silently inflate publisher earnings. Cross-file in part (refund reversal belongs in the billing/wallets flow), but `forOrg` is the surface where the inconsistency becomes the publisher's source of truth.

**Fix:** At minimum exclude terminal-failure and reversal states and split pending from realized. The cleanest fix is to return separate buckets per status class:
```ts
// In the loop:
if (earning.status === "reversed") continue; // never count reversed
if (earning.status === "pending_risk") { pendingGross += earning.grossCredits; ... }
else { realizedGross += earning.grossCredits; ... }
```
And separately, close the refund hole by writing a `reversed` earning (or a negative offset row) in the refund path of `billing.ts` so the ledger actually debits the publisher.

---

### [SEV: P2] `forOrg` ignores `availableAt` entirely, so "this month" is keyed to settlement time, not maturity — and the month window is non-deterministic across the risk-hold boundary

**Location:** `convex/earnings.ts:36-39, 52-56`

```ts
const monthStart = Date.UTC(
  new Date(now).getUTCFullYear(),
  new Date(now).getUTCMonth(),
  1,
);
// ...
if (earning.createdAt >= monthStart) { monthCalls += 1; ... }
```

**Problem:** The month bucket keys on `createdAt` (settlement insert time) with `monthStart` recomputed on every query. Two issues:

1. `monthStart` is recomputed per invocation from `Date.now()`. The "month" a given earning falls into therefore depends on when the publisher opens the page, not on a stable attribute of the earning. An earning settled at `2026-07-31T23:59:59Z` is "July" on Aug 1 morning and not recoverable as "July" once August begins — there is no way to view a prior month, yet the UI labels the bucket as the current month with no qualifier. Combined with the `pending_risk` 7-day hold, an earning settled late in a month can still be in `pending_risk` (not realizable) when the month rolls over and disappears from the dashboard.

2. The maturity time `availableAt` (when the earning actually becomes withdrawable) is never used for bucketing. The product conceptually distinguishes "settled" from "available"; the statement uses neither consistently.

**Impact:** Month figures are unstable and not reconstructable; the publisher cannot reconcile a prior month's statement. Low-to-medium severity because the all-time figure is stable, but it makes the month number actively misleading.

**Fix:** Persist a `monthStart` on each earning at insert (or compute deterministically from `createdAt`) and accept an optional `monthStart` argument on `forOrg` so the UI can navigate history. Decide whether the month bucket should reflect `createdAt` or `availableAt` and document it.

---

### [SEV: P2] `allTime.calls` can disagree with the sum of `byProject.calls` (and `monthCalls`), with no test guarding the reconciliation

**Location:** `convex/earnings.ts:51-62, 78-86`

```ts
let monthCalls = 0;
// ...
for (const earning of earnings) {
  // ...
  if (earning.createdAt >= monthStart) { monthCalls += 1; ... }
  if (earning.projectId === undefined) continue;   // <-- skips the byProject accumulation
  const row = rows.get(earning.projectId) ?? { calls: 0, ... };
  row.calls += 1;
  ...
}
// ...
return {
  byProject,
  month: { calls: monthCalls, ... },                 // counts every row in window
  allTime: { calls: earnings.length, ... },          // counts every row
};
```

**Problem:** `allTime.calls` is `earnings.length` (every row) and `monthCalls` increments for every row in the window — both run *before* the `if (earning.projectId === undefined) continue;` guard. The `byProject[*].calls` accumulator runs *after* it. So whenever any earning has `projectId === undefined`, `Σ byProject.calls < allTime.calls` (and `< monthCalls` for the month), while the credit totals (`grossCredits`/`netCredits`) are still counted in `allTime`/`month`. The breakdown under-reports call counts while the credit totals include them — an unreconciling statement.

The write path (`wallets.ts:446`) always sets `projectId: project._id`, so this is latent today, but the `continue` was added defensively precisely because the schema (`schema.ts:282`) marks `projectId` optional. Any future writer, migration, or manual backfill that omits `projectId` produces a silent inconsistency the existing test (one fully-populated row) cannot catch.

**Impact:** Latent reconciliation defect; the per-project breakdown would under-report calls relative to the headline totals with no error.

**Fix:** Either drop the optional from the schema (the write path requires it) and remove the `continue`, or accumulate undefined-`projectId` rows into an explicit "unattributed" bucket so `Σ byProject.calls === allTime.calls` always holds. Add a test seeding a row without `projectId`.

---

### [SEV: P3] Non-deterministic `byProject` ordering via `localeCompare` with no locale/options

**Location:** `convex/earnings.ts:74-77`

```ts
byProject.sort(
  (left, right) =>
    left.name.localeCompare(right.name) ||
    left.slug.localeCompare(right.slug),
);
```

**Problem:** `String.prototype.localeCompare` with no locale argument uses the runtime default locale, which varies between the Convex server, the developer's machine, and CI. Project ordering in the UI is therefore non-deterministic across environments — and since `name` is editable (`projects.update`), re-sorting on every render with a locale-dependent comparator can produce visually unstable order on name edits.

**Impact:** Minor; cosmetic instability.

**Fix:**
```ts
byProject.sort(
  (left, right) =>
    left.slug.localeCompare(right.slug, "en") ||
    left.name.localeCompare(right.name, "en", { numeric: true }),
);
```

---

### [SEV: P3] N+1 `ctx.db.get` per distinct project in `byProject`

**Location:** `convex/earnings.ts:65-72`

```ts
const byProject = await Promise.all(
  [...rows.entries()].map(async ([projectId, row]) => {
    const project = await ctx.db.get(projectId);
    return { projectId, name: project?.name ?? "Unknown project", slug: project?.slug ?? "unknown", ...row };
  }),
);
```

**Problem:** One `ctx.db.get` per distinct project. Acceptable for a handful of projects, but every distinct `projectId` is a separate document read with no batching; combined with the P1 unbounded scan this multiplies per-page cost. A deleted project is silently rendered as `"Unknown project"` / `"unknown"` slug with no signal to the publisher that the project no longer exists.

**Impact:** Minor performance and UX gap; acceptable today but worth folding into the materialized-rollup fix in P1.

**Fix:** When introducing the monthly rollup (P1 fix), join project metadata once at render time from a small `projects` cache; surface deleted projects explicitly (e.g. `"Forecast (deleted)"`) rather than masking as `"Unknown project"`.

---

### [SEV: P3] `monthStart` derived from two `new Date(now)` calls; trivially fragile

**Location:** `convex/earnings.ts:37-39`

```ts
const monthStart = Date.UTC(
  new Date(now).getUTCFullYear(),
  new Date(now).getUTCMonth(),
  1,
);
```

**Problem:** `now` is captured once so the two `new Date(now)` instances resolve to the same instant, but the pattern is fragile and reads as if the author was unsure whether `now` could change. Cosmetic, but the kind of thing a reviewer flags.

**Impact:** None today; readability/fragility only.

**Fix:**
```ts
const d = new Date(now);
const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
```

---

### [SEV: P3] No validation on `orgSlug`; empty/oversized strings are indistinguishable from "missing org"

**Location:** `convex/earnings.ts:32` (`args: { orgSlug: v.string() }`)

**Problem:** `orgSlug` is `v.string()` with no length or shape constraint. An empty string, a slug with whitespace, or a megabyte-long string all flow into `getOrgBySlug` (lib/auth.ts:56) and produce the generic `"Organization not found"` — indistinguishable from a legitimate slug that doesn't exist. Not a security issue (authorization still holds), but it weakens client-side error handling.

**Impact:** Minor; UX/error-quality only.

**Fix:** Add `v.string()` length bounds or a slug regex matching the `organizations.slug` format, or accept the `Id<"organizations">` directly.

---

### [SEV: P3] `EarningsBucket`/`ProjectEarnings`/`OrgEarnings` return types are bare `number`s with no integer-credit invariant

**Location:** `convex/earnings.ts:4-22`

**Problem:** The credit fields are plain `number`. The source `publisherEarnings.grossCredits`/`netCredits` are integers (validated at write via `publisherEarningSplit`, accounting.ts:24), and the JS `+=` accumulation stays integer-valued as long as the running sum stays below `Number.MAX_SAFE_INTEGER` (≈ $900M per org at 10k credits/$1 — beyond realistic for a single org but not guarded). There is no runtime assertion that the returned aggregates are safe integers, and the web layer formats them as `$` without re-validation. This is the same class of defect flagged in `reviews/convex.accounting.ts.md` (bare `number` return types); `earnings.ts` inherits it on the read side.

**Impact:** Latent; the sums are safe at any realistic per-org volume, but there is no guard at the boundary.

**Fix:** Assert `Number.isSafeInteger` on the final aggregates before returning, or thread a branded `Credits` type (see accounting review). At minimum document the safe-integer assumption on `EarningsBucket`.

---

## Summary

**Findings by severity:** P0: 0 · P1: 1 · P2: 3 · P3: 5

**Top 3 to fix first:**
1. **P1 — Unbounded `.collect()` over the org partition.** One `publisherEarnings` row per settled call + `.collect()` with no `createdAt` bound means any successful publisher trips Convex's result-size cap and the whole earnings surface throws. Add a materialized monthly rollup (updated in `recordUsage` and the status transitions) and/or paginate + range-bound the scan.
2. **P2 — No `status` filter; pending / failed / reversed (and refunded) earnings are all summed.** `pending_risk` is conflated with realized earnings; `failed` transfer earnings are counted; refunds never write a `reversed` row at all, so refunded calls remain as publisher earnings forever. Split pending vs. realized in the return shape and close the refund-reversal hole in the billing/wallets flow.
3. **P2 — Month bucket is non-deterministic and historical months are unrecoverable.** `monthStart` recomputed from `Date.now()` per query, keyed on `createdAt` not `availableAt`, no `month` argument. Persist a `monthStart` per earning and accept a `monthStart` argument so prior months are queryable.
