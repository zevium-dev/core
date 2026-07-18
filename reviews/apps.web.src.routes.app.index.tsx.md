# Tiger Review — `apps/web/src/routes/app/index.tsx` + `apps/web/src/routes/app/projects.tsx`

Scope: `apps/web/src/routes/app/index.tsx` (dashboard), `apps/web/src/routes/app/projects.tsx`
(projects layout). Cross-referenced: `apps/web/src/routes/app/billing.tsx`,
`apps/web/src/routes/app/settings/keys.tsx`, `apps/web/src/lib/api-keys.ts`,
`apps/web/src/lib/onboarding.ts`, `apps/web/src/components/motion/number-ticker.tsx`,
`convex/analytics.ts`, `convex/wallets.ts`, `apps/web/src/routes/app.tsx`.

## Verdict

**Incorrect.** One real correctness defect: the dashboard's API-key count
query is keyed without `orgSlug`, so after an org switch the onboarding
checklist and key-count-derived flags serve the previous org's data for up to
30 seconds (`staleTime: 30_000`). The `projects.tsx` layout is a clean
pass-through with no issues. No blockers, no security issues, no hydration
mismatches.

## File Stats

| File | Lines | Findings |
|---|---|---|
| `apps/web/src/routes/app/index.tsx` | 410 | 3 |
| `apps/web/src/routes/app/projects.tsx` | 6 | 0 |

## Findings

### [SEV: P2] Stale org context: `keysQuery` keyed without `orgSlug`

**Location:** `apps/web/src/routes/app/index.tsx:82-90`.

```tsx
const keysQuery = useQuery({
  queryKey: ["settings", "api-keys", "count"] as const,
  queryFn: () => listKeys(),
  staleTime: 30_000,
});

const keyCount = keysQuery.data?.length ?? 0;
const keysLoaded = !keysQuery.isPending;
const flags = deriveOnboardingFlags({
  keyCount,
  callsCycle: overview.callsCycle,
  balance: wallet.balance,
});
const showOnboarding = shouldShowOnboarding({ keysLoaded, flags });
```

**Problem.** `listKeys()` (`apps/web/src/lib/api-keys.ts:70`) reads
`session.orgId` server-side — it returns keys for the *active* Clerk org. But
the `queryKey` is the static literal `["settings", "api-keys", "count"]` with
no `orgSlug` dimension. When the user switches orgs via the Clerk org
switcher, `useOrganization()` returns the new `organization`, the component
re-renders with the new `orgSlug`, and the two Convex suspense queries
(`orgOverview`, `getMyWallet`) re-fire with the new slug — but `keysQuery`
sees an unchanged key and returns the **cached** result from the previous
org. With `staleTime: 30_000`, React Query treats that cache as fresh for 30
seconds: no background refetch, no `isPending` flip.

`deriveOnboardingFlags` then mixes stale and fresh data: `hasKey` reflects the
*old* org's keys while `hasCall` and `hasTopUp` reflect the *new* org. After
`isPending` goes `false` on the first successful fetch (which never resets
without a key change), `shouldShowOnboarding` always returns `true` with the
stale `hasKey` — so the checklist's "Get an API key" step shows "Done" (with a
green checkmark) for an org that has no key, or conversely shows "Create key"
for an org that does have one, for up to 30 seconds.

**Impact.** Misleading onboarding state after every org switch — the primary
dashboard CTAs ("Create key" vs "Done" badge) lie for half a minute. The
`keyCount` itself is also wrong, though it isn't directly rendered (only the
boolean `hasKey` is surfaced).

**Fix.** Add `orgSlug` to the query key so an org switch produces a cache
miss and refetch:

```tsx
const keysQuery = useQuery({
  queryKey: ["settings", "api-keys", "count", orgSlug] as const,
  queryFn: () => listKeys(),
  staleTime: 30_000,
});
```

(Note: `settings/keys.tsx:50` has the same org-less key
`["settings", "api-keys"]` — same class of bug, but its default `staleTime: 0`
means it refetches on the next focus/mount, narrowing the stale window. The
dashboard's 30-second `staleTime` makes the window much worse.)

---

### [SEV: P3] `credit-balance` view-transition name has no morph target

**Location:** `apps/web/src/routes/app/index.tsx:134-137`; missing counterpart
in `apps/web/src/routes/app/billing.tsx:123-127`.

```tsx
<CardTitle
  className="text-3xl tabular-nums"
  style={{ viewTransitionName: "credit-balance" }}
>
  <NumberTicker value={overview.balance} />
```

**Problem.** The dashboard sets `viewTransitionName: "credit-balance"` on the
wallet-balance `CardTitle`. The billing page renders the same datum
(`billing.wallet.balance`) in a `<p>` with no `viewTransitionName`. A
view-transition morph requires the same `view-transition-name` on an element
in both the old and new snapshots; with no matching element on the billing
page, the name is set but never morphs — the balance element simply
disappears during the `main-content` swap. A grep of the entire `apps/web/src`
tree confirms `credit-balance` appears only on this one element.

**Impact.** Dead VT config. The project convention is "every list→detail nav
ships view-transition morph or written reason." Dashboard→billing isn't
list→detail, but the same wallet-balance number is the shared anchor between
the two pages and the VT name is already half-wired — the billing side just
doesn't carry it.

**Fix.** Either add `style={{ viewTransitionName: "credit-balance" }}` to the
billing page's balance `<p>` (`apps/web/src/routes/app/billing.tsx:123`) to
complete the morph, or remove the `style` prop from the dashboard's
`CardTitle` if no morph is intended.

---

### [SEV: P3] Dead `pendingComponent` — route has no `loader`

**Location:** `apps/web/src/routes/app/index.tsx:30-36`.

```tsx
export const Route = createFileRoute("/app/")({
  component: DashboardPage,
  head: () => ({
    meta: [{ title: "Dashboard · Zevium" }],
  }),
  pendingComponent: DashboardSkeleton,
});
```

**Problem.** `pendingComponent` is shown by TanStack Router only while a
route `loader` (or a parent's deferred promise) is pending. This route has no
`loader`. The `DashboardSkeleton` is still used — but only as a manual return
value inside `DashboardPage` for the auth-loading and unauthenticated states,
not via the router's pending mechanism. The `pendingComponent` declaration on
the route object is never exercised.

Compare `projects/index.tsx:24-58` which pairs a `loader` with its
`pendingComponent: ProjectsListSkeleton` — that pairing is live; this one is
dangling.

**Impact.** No runtime effect today. Future maintainer may assume the router
shows a skeleton during data loading and be surprised that the dashboard
never prefetches `orgOverview` / `getMyWallet` during navigation (it relies
on `useSuspenseQuery` post-mount, unlike `projects/index.tsx` which
prefetches via its loader).

**Fix.** Either remove `pendingComponent` (the manual skeleton inside the
component covers it) or add a `loader` that prefetches the Convex queries to
match the `projects/index.tsx` pattern and actually use the pending skeleton.

---

## Summary

3 findings — 0 × P0, 0 × P1, 1 × P2, 2 × P3.

Top issues:

1. **P2 — Stale org context on `keysQuery`**: `queryKey` lacks `orgSlug`;
   after an org switch the onboarding checklist shows the previous org's
   key state for up to 30 s. Fix: add `orgSlug` to the query key.
2. **P3 — `credit-balance` VT name has no morph target**: set on the
   dashboard's balance `CardTitle` but absent from the billing page's balance
   element; the morph never fires.
3. **P3 — Dead `pendingComponent`**: route has `pendingComponent` but no
   `loader`, so the router never shows it.

`projects.tsx` is a clean 6-line pass-through layout (`<Outlet />`), consistent
with `org.tsx`. No issues there.
