# Tiger Review — `apps/web/src/components/project-earnings-panel.tsx`

Reviewed alongside `convex/earnings.ts` (`forOrg` query) and `convex/payouts.ts`
(`getPayoutState`, transfer lifecycle) for end-to-end consistency.

## Verdict

**Incorrect.** One P1 correctness defect (status-unfiltered aggregation inflates
publisher-visible earnings) plus one P2 UX placement defect. No P0. The panel
itself is small and mostly clean — the load-bearing bug lives in the Convex
query that feeds it.

## File Stats

| File | LOC | Findings |
| --- | --- | --- |
| `apps/web/src/components/project-earnings-panel.tsx` | 165 | 2 |
| `convex/earnings.ts` | 108 | 1 (shared root cause) |
| `convex/payouts.ts` | 754 | 0 (reference for the inconsistency) |

## Findings

### [SEV: P1] `earnings.forOrg` aggregates reversed / failed / pending_risk rows into publisher totals

**Location:** `convex/earnings.ts:56-75` (loop body), consumed by
`apps/web/src/components/project-earnings-panel.tsx:21-25` (`useSuspenseQuery`)
and rendered as "Net credits (you keep 95%)" at `project-earnings-panel.tsx:117-124`.

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
  // … row aggregation, also unconditional on status
}
```

**Problem.** `forOrg` selects every `publisherEarnings` row for the org via
`withIndex("by_publisher", …)` and sums `grossCredits` / `netCredits` / `calls`
with **no `status` predicate**. The schema (`convex/schema.ts:287-296`) defines
six statuses: `pending_risk`, `available`, `allocated_to_transfer`,
`transferred`, `reversed`, `failed`. `reversed` and `failed` are reachable in
production: `convex/billing.ts:842-852` maps Stripe `transfer.reversed` /
`transfer.failed` webhooks into `internal.payouts.projectStripeTransfer`,
which flips the earning row's status. The sibling query
`convex/payouts.ts:693-705` (`getPayoutState`) explicitly partitions by status
and only counts `available` (and `transferred` / `allocated_to_transfer`) toward
what the publisher can actually receive — `reversed` and `failed` go into
separate buckets.

So the earnings panel and the payout panel disagree on the same underlying
rows: a $100 consumer charge that is later refunded (Stripe reversal) still
shows up here as "95,000 net credits · you keep 95%" while `getPayoutState`
reports $0 available. The panel's own copy — "You keep 95% of gross credits
charged to consumers" — is false for reversed charges, because those credits
were un-charged.

**Impact.** Publishers see inflated all-time and month totals (both credits and
USD), inflated per-project `calls` counts (a reversed settlement still
increments `calls`), and a misleading "publisher share" USD figure. The mismatch
with the payout panel will surface as support tickets ("why does my earnings
panel say $X but my available balance is $Y?"). The single test
(`convex/earnings.test.ts:33-41`) seeds only `status: "available"`, so the bug
is uncaught by the suite.

**Fix.** Filter at the index scan or in the loop. Cleanest is to skip
non-creditable statuses before accumulating:

```ts
for (const earning of earnings) {
  if (
    earning.status === "reversed" ||
    earning.status === "failed"
  ) {
    continue;
  }
  allGross += earning.grossCredits;
  allNet += earning.netCredits;
  if (earning.createdAt >= monthStart) {
    monthCalls += 1;
    monthGross += earning.grossCredits;
    monthNet += earning.netCredits;
  }
  if (earning.projectId === undefined) continue;
  const row = rows.get(earning.projectId) ?? {
    calls: 0,
    grossCredits: 0,
    netCredits: 0,
  };
  row.calls += 1;
  row.grossCredits += earning.grossCredits;
  row.netCredits += earning.netCredits;
  rows.set(earning.projectId, row);
}
```

Decide explicitly whether `pending_risk` should appear in the "this month /
all-time" display (it is real earnings under risk hold, so probably yes) and
whether `transferred` should still be shown all-time (probably yes — it was
earned). But `reversed` and `failed` must be excluded, otherwise the statement
is not a statement of earnings. Add a test seeding one `available` + one
`reversed` row and assert `allTime.netCredits === available.netCredits`.

---

### [SEV: P2] Empty-state card rendered at the bottom, disconnected from the project section it describes

**Location:** `apps/web/src/components/project-earnings-panel.tsx:83-92`.

```tsx
{project.calls === 0 ? (
  <Card>
    <CardContent className="py-10 text-center text-sm text-muted-foreground">
      No metered calls on this project yet. Publish, go public, and
      earnings land here at 95% of consumer spend.
    </CardContent>
  </Card>
) : null}
```

**Problem.** This empty state is keyed on `project.calls` (the **project-scoped**
all-time count), but the card is the LAST child of the panel, rendered AFTER
the "Organization · this UTC month" and "Organization · all time" sections
(`project-earnings-panel.tsx:55-77`), both of which may be non-zero for an org
with other active projects. So a publisher viewing a freshly-published project
inside a busy org sees three populated stat grids and *then* a card saying
"No metered calls on this project yet" — visually detached from the "This
project · all time" section (`project-earnings-panel.tsx:44-53`) it actually
describes.

**Impact.** Confusing layout. Publishers reasonably read top-to-bottom and hit
the "no calls" card after seeing non-zero org numbers, which reads as a
contradiction. The empty state belongs inline, immediately under the project
section (replacing or supplementing the project `EarningsStatGrid` when
`project.calls === 0`), not at the bottom of the panel.

**Fix.** Move the empty state adjacent to the project-scoped section, and skip
rendering the empty `EarningsStatGrid` for the project when there is no data:

```tsx
<section className="space-y-3">
  <h2 className="text-sm font-medium text-muted-foreground">
    This project · all time
  </h2>
  {project.calls === 0 ? (
    <Card>
      <CardContent className="py-10 text-center text-sm text-muted-foreground">
        No metered calls on this project yet. Publish, go public, and
        earnings land here at 95% of consumer spend.
      </CardContent>
    </Card>
  ) : (
    <EarningsStatGrid
      calls={project.calls}
      grossCredits={project.grossCredits}
      netCredits={project.netCredits}
    />
  )}
</section>
```

## Summary

- **P0:** 0 · **P1:** 1 · **P2:** 1 · **P3:** 0 · **Total:** 2
- Top issue: `forOrg` sums across all `publisherEarnings` statuses, so reversed
  and failed rows inflate the publisher-facing earnings statement and contradict
  `getPayoutState` on the same org.
- No `isPending` misuse (panel is read-only, no mutations), no raw Tailwind
  colors (all `text-muted-foreground` / semantic tokens), no hardcoded motion
  values (`NumberTicker` sources duration from `DUR.slow`), skeleton is present
  and wired via the route's `Suspense` boundary, no obvious dead code.
  `formatCreditsAsUsd` is safe here because `publisherEarningSplit`
  (`convex/accounting.ts:24-34`) guarantees safe-integer inputs and floors the
  platform fee, so `grossCredits` / `netCredits` are integers — no float
  precision drift in the displayed USD.
