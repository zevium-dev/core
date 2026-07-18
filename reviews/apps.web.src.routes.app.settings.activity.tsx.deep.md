# Tiger Review — `apps/web/src/routes/app/settings/activity.tsx` (DEEP)

Companion files read in full: `apps/web/src/lib/activity-filters.ts`, `convex/usage.ts`, `convex/schema.ts` (usageEvents + indexes), `convex/projects.ts` (`list`), `apps/web/src/lib/activity-filters.test.ts`. Consumers of `mergeUsagePages` cross-checked against `apps/web/src/routes/admin/orgs.tsx` and `apps/web/src/routes/admin/projects.tsx` (same hand-rolled pagination pattern — the bugs below are systemic, not local).

## Verdict

**Do not ship as-is.** The route reimplements Convex pagination by hand (`cursor` / `rows` / `isDone` / `continueCursor` state) on top of a non-paginated `convexQuery` subscription, and the reimplementaton is racy across every state transition: filter change, pagination, mount, and live updates. One P1 correctness bug makes an entire class of legitimate data unreachable through the UI; six P2 races/UX faults follow from the same root cause. The backing query (`convex/usage.ts listForOrg`) filters `projectId` *after* the index scan, which is both the P1 root and a latent performance problem. No P0 (no auth bypass, no PII leak, no data loss in the data plane), but the user-facing surface is broken in common paths.

## File Stats

- File: `apps/web/src/routes/app/settings/activity.tsx` (411 lines)
- Reviewed with: `apps/web/src/lib/activity-filters.ts` (78 lines), `convex/usage.ts` (72 lines)
- Findings: 1 P1, 7 P2, 13 P3

## Findings

---

### [SEV: P1] Project filter makes real activity unreachable — false "No activity yet"

**Location:** `convex/usage.ts:38-64` (handler) + `activity.tsx:215-219` (empty branch).

```ts
// convex/usage.ts — listForOrg
const result = await ctx.db
  .query("usageEvents")
  .withIndex("by_org_at", (q) => { /* orgId + optional since/until */ })
  .order("desc")
  .paginate(args.paginationOpts);          // 25 newest ORG events

// ...
for (const event of result.page) {
  if (args.projectId !== undefined && event.projectId !== args.projectId) {
    continue;                                // post-filter, in JS
  }
  // ...
}
return { ...result, page };                  // page may now be EMPTY
```

```tsx
// activity.tsx
{firstPagePending ? (
  <ActivityTableSkeleton />
) : rows.length === 0 ? (
  <EmptyActivity />                          // "No activity yet" — terminal-looking
) : (
  /* table + Load more */
)}
```

**Problem.** `paginate(numItems: 25)` returns the 25 newest events **for the org** off `by_org_at`. The handler then drops every event whose `projectId` doesn't match, *after* the page boundary is fixed. If the selected project's most recent event is older than the org's 25 newest events, the first page comes back with `page: []` and `isDone: false` / `continueCursor` non-null. The UI sees `rows.length === 0` and renders `EmptyActivity` — and because the empty branch is taken, the "Load more" button (only rendered in the table branch) never appears. The user is told "No activity yet" for data that provably exists, with no affordance to reach it.

This is silent data loss from the user's perspective: they have to know to suspect the truth.

**Impact.** Any org with ≥1 project whose call volume is dominated by other projects, and whose events fall outside the org-wide top-25 newest, is told the project has no activity. For a marketplace where one org runs many low-volume specs, this is the common case, not the edge case.

**Fix.** Stop post-filtering. When `args.projectId` is set, query the dedicated `by_project_at` index (which already exists — `schema.ts:110`):

```ts
const q = args.projectId !== undefined
  ? ctx.db.query("usageEvents").withIndex("by_project_at", (q) => {
      const base = q.eq("projectId", args.projectId!);
      // orgId check is now structural via the project owning the org; or
      // keep a projectId→orgId check via ctx.db.get(projectId) up front.
      return args.since !== undefined ? base.gte("at", args.since) : base;
    })
  : ctx.db.query("usageEvents").withIndex("by_org_at", (q) => {
      const base = q.eq("organizationId", org._id);
      return args.since !== undefined ? base.gte("at", args.since) : base;
    });
```

For the org-wide path, push `projectId`/`keyId` into the index predicate or accept the post-filter *but* loop across pages server-side until either `numItems` matching rows are gathered or `isDone`. The current "filter in JS, paginate at index" shape is wrong by construction.

---

### [SEV: P2] Stale-cursor fetch on filter change after pagination

**Location:** `activity.tsx:140-160` (listArgs memo), `163-170` (reset effect).

```tsx
const listArgs = useMemo(() => ({ orgSlug, paginationOpts: { numItems, cursor }, projectId?, since? }),
  [orgSlug, cursor, projectId, since]);

useEffect(() => {
  setCursor(null); setRows([]); setIsDone(false); setContinueCursor(null); setWindowNow(Date.now());
}, [timeRange, projectId, orgSlug]);
```

**Problem.** When the user changes `timeRange` or `projectId` *after* paginating (so `cursor === "<page2>"`), the commit order is:

1. `search` changes → re-render. `listArgs` recomputes with the **new** `since`/`projectId` **and the old** `cursor` (the reset effect hasn't run yet — effects fire after render). `useQuery` subscribes to **page 2 of the new filter** using the previous filter's continue cursor.
2. The reset effect runs → `setCursor(null)` etc. → re-render → `listArgs` recomputes with `cursor: null` → a *second* subscription is opened for page 1 of the new filter. The first subscription is torn down (gcTime retains it briefly).

The Convex continue-cursor is an opaque token bound to the original index scan's snapshot. Reusing a cursor from filter A against filter B's `since`/`projectId` is undefined behavior at the Convex layer — at best a wasted round-trip whose result is discarded, at worst a page that doesn't correspond to any meaningful boundary.

**Impact.** One spurious Convex RPC per filter change after pagination; potential for a transiently inconsistent page if the stale subscription's snapshot resolves between commits (the merge effect would then `replace=false`-append that page into freshly-cleared `rows`, since `cursor` is momentarily non-null — see also P2 "empty flash"). The data shown right after a filter change can be the *wrong* page for a frame.

**Fix.** Reset `cursor` in the same setter call that changes the filter — i.e. don't derive `cursor` from independent state. Either (a) store a single `session = { timeRange, projectId, orgSlug, cursor }` object and replace it atomically, or (b) drive the whole thing through `usePaginatedQuery` (see P2 "manual pagination" below) which doesn't have this hazard.

---

### [SEV: P2] Empty-state flash on cached filter reselect

**Location:** `activity.tsx:163-170` (reset effect), `175-185` (merge effect), `214-219` (render branch).

```tsx
useEffect(() => { /* filter change */ setRows([]); /* ... */ }, [timeRange, projectId, orgSlug]);

useEffect(() => {
  if (!usageQuery.data || usageQuery.isPending) return;
  setRows((prev) => mergeUsagePages(prev, page, cursor === null));
  // ...
}, [usageQuery.data, usageQuery.isPending, cursor]);
```

**Problem.** On filter change the reset effect clears `rows` to `[]` synchronously during the commit. If the new filter's first page is already in the TanStack Query cache (user toggled A→B→A, or the query was warm from a sibling route), then on the post-reset render `usageQuery.isPending === false` and `usageQuery.data` is defined — so `firstPagePending` is false and `rows.length === 0` is true. The empty branch is taken for that frame. The merge effect, which would repopulate `rows` from the cached `usageQuery.data`, runs *after* paint. Result: one frame of `EmptyActivity` ("No activity yet") before the table snaps in.

This is the visual artifact the prior review called "stale-row flash"; the actual flash is *empty*-state, not stale-row, but the mechanism is the same: eager clear, deferred refill, separated across two effects.

**Impact.** Flicker of "No activity yet" on every cached filter reselect. Looks broken. Confusing for users who know the data is there.

**Fix.** Don't clear `rows` in a side effect. Either derive `rows` with `useMemo` over the accumulated page snapshots (so it's synchronous with render), or keep the previous `rows` until the new `usageQuery.data` for the new key arrives (treat `rows` as a reducer keyed on the same `listArgs` identity).

---

### [SEV: P2] Silent error swallowing renders as "No activity yet"

**Location:** `activity.tsx:175-185`, `214-219`. No reference to `usageQuery.isError` / `usageQuery.error` / `projectsQuery.isError` anywhere in the file.

```tsx
useEffect(() => {
  if (!usageQuery.data || usageQuery.isPending) return;   // error → data undefined, isPending false → return
  // ... never reaches setRows
}, [usageQuery.data, usageQuery.isPending, cursor]);
```

**Problem.** When `usageQuery` errors — Convex validation reject (bad `projectId` cast from URL, bad cursor, `requireOrgMemberBySlug` throwing on a stale slug), network drop, or a transient backend error — `data` is `undefined`, `isPending` is false, `isError` is true. The merge effect early-returns; `rows` stays `[]`; `firstPagePending` is false; the render shows `EmptyActivity` ("No activity yet"). The error is silently swallowed as a content-empty state. `projectsQuery` has the identical fault — its error leaves the Project `<Select>` populated with only "All projects", no signal.

**Impact.** Backend failures are indistinguishable from "no data." Users can't tell whether their org genuinely has no calls or the backend is down. No retry path, no toast, no error boundary. This compounds the P1: a user filtering by a project with valid-but-unreachable data and a user hitting a Convex error both see the same "No activity yet" message.

**Fix.** Branch on `usageQuery.isError` and render an error state with a retry button (`usageQuery.refetch()`); surface `projectsQuery.isError` similarly. Per project rules ("never leak internal errors"), show a generic message, but show *something* distinct from the empty state.

---

### [SEV: P2] Live-update append-only drift after pagination

**Location:** `activity.tsx:175-185` (merge effect only updates the *current* page's data into `rows`), `convex/usage.ts` (the query is a live Convex query via `convexQuery`).

**Problem.** `convexQuery(api.usage.listForOrg, listArgs)` is a *live* subscription — Convex re-emits when `usageEvents` rows matching the index range change. But the subscription is keyed on `(orgSlug, cursor, projectId, since)`. Once the user clicks "Load more", `cursor` is the page-2 cursor; the subscription is now for page 2 only. Page 1's subscription was torn down. So:

- New events written after the user paginated are not reflected in the visible list head — the "newest" row the user sees is frozen at the moment they paginated, even though new calls are landing.
- Worse: as new events arrive, the cursor boundary shifts. When the user clicks "Load more" again, `continueCursor` (refreshed by the page-2 live update) now points to a different offset in the (shifted) index. The next page may skip events that moved across the boundary. `mergeUsagePages`' `_id` dedupe cannot heal gaps — it only prevents *duplicates*; missed IDs between page boundaries are silently lost.

This is the "append-only drift" the prior review flagged. It is structural to the manual-pagination-on-a-live-query pattern.

**Impact.** A user watching their call log after paginating sees a stale view; new gateway calls don't appear; loading more may silently skip rows. For a "realtime default" product, a frozen activity feed is a correctness bug, not a perf nit.

**Fix.** Use Convex's `usePaginatedQuery` from `convex/react` (or the `@convex-dev/react-query` paginated helper), which maintains live subscriptions across *all* loaded pages and handles cursor consistency under live updates. If the manual pattern is kept for some reason, refetch page 1 on window focus and on a timer, and discard `continueCursor`s older than the latest page-1 snapshot.

---

### [SEV: P2] Duplicate first-page fetch on mount

**Location:** `activity.tsx:118` (`useState(() => Date.now())`), `163-170` (reset effect runs on mount), `135-138` (`since` memo depends on `windowNow`).

```tsx
const [windowNow, setWindowNow] = useState(() => Date.now());      // T1
const since = useMemo(() => activitySinceMs(timeRange, windowNow), [timeRange, windowNow]);

useEffect(() => {
  setCursor(null); setRows([]); setIsDone(false);
  setContinueCursor(null); setWindowNow(Date.now());               // T2 > T1
}, [timeRange, projectId, orgSlug]);                              // runs on mount too
```

**Problem.** On initial mount, `windowNow` is `T1`. The first render's `listArgs` is built with `since = T1 - 7d` (default range). The `useQuery` subscription for page 1 opens. Then the reset effect runs *on mount* (its deps are evaluated on first commit), calling `setWindowNow(Date.now())` → `T2`. `since` recomputes to `T2 - 7d`; `listArgs` changes; the subscription re-keys. The T1-keyed subscription is torn down after one round-trip. So every mount issues two page-1 fetches for the default range, differing only by milliseconds in the lower bound.

**Impact.** Wasted Convex RPC + a brief double-subscription window on every route entry. Not user-visible, but on a high-traffic settings page it's pointless load, and it's a smell that the reset effect is doing too much.

**Fix.** Don't run the reset effect on mount. Either skip the first run with a ref (`const first = useRef(true)`), or initialize `windowNow` once and never reset it (filter changes don't actually need a fresh `windowNow` — see the next finding). The `setWindowNow(Date.now())` call only exists to "freeze now per filter change," but freezing has its own bug (below).

---

### [SEV: P2] Manual pagination reinvents `usePaginatedQuery` — the root of P2 #1–#5

**Location:** `activity.tsx:115-185` (entire `cursor` / `rows` / `isDone` / `continueCursor` state machine + two effects).

**Problem.** The route hand-rolls what Convex already ships: `usePaginatedQuery(api.usage.listForOrg, args, { initialNumItems })` from `convex/react` (or the `@convex-dev/react-query` paginated helper, which this codebase already uses for non-paginated queries). The hand-rolled version is the root cause of:

- stale-cursor fetch on filter change (cursor state lags the filter state by one render),
- empty-state flash on cached reselect (eager clear + deferred refill split across effects),
- live-update append-only drift (only the current page is live),
- duplicate first-page fetch on mount (reset effect churns `windowNow`),
- `isDone` / `continueCursor` state drifting from `usageQuery.data` (two sources of truth).

The sibling routes `admin/orgs.tsx` and `admin/projects.tsx` copy the same pattern (`mergeUsagePages` + manual `cursor`), so the bug is systemic.

**Impact.** Five distinct correctness/UX bugs, all avoidable by using the framework pagination primitive, which also handles StrictMode dedupe and live-update consistency for free.

**Fix.** Replace the entire `cursor` / `rows` / `isDone` / `continueCursor` block and both effects with:

```tsx
const { results, isLoading, status, loadMore } = usePaginatedQuery(
  api.usage.listForOrg, { orgSlug, projectId?, since? }, { initialNumItems: ACTIVITY_PAGE_SIZE },
);
```

Then render `results` directly; `status` gives `"LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted"` for free, with live updates across all loaded pages. If staying on `@convex-dev/react-query`, use its paginated helper rather than the manual `useQuery` + `cursor` pattern.

---

### [SEV: P2] Live-window lower-bound drift ("last 7d" grows over time)

**Location:** `activity.tsx:118` (frozen `windowNow`), `135-138` (`since`), `convex/usage.ts:48-56` (lower-bound only, no `until`).

```tsx
const since = useMemo(() => activitySinceMs(timeRange, windowNow), [timeRange, windowNow]);
// listArgs.since = since  →  Convex: q.gte("at", since)   // no until clamp
```

**Problem.** `windowNow` is frozen at filter-change time (and, per the previous finding, churned on mount). As wall-clock advances while the user sits on the page, `since` stays anchored, so the visible window for "Last 24h"/"7d"/"30d" only ever *grows* — events newer than `windowNow` are still included (no `until`), and the lower bound never advances. After 10 minutes on "Last 24h", the user sees ~24h10m of data, not 24h. For "All time" it's moot (`since` undefined).

Worse, the "frozen now" was presumably introduced so that successive page fetches within one filter session share a consistent window. But `since` is only a *lower* bound — there's no `until`, so freezing the lower bound doesn't actually pin a window; it just freezes the floor. The freeze provides no consistency benefit and introduces drift.

**Impact.** Time-range labels lie after the page has been open a while. Minor per-instance, but on a "realtime" settings page where users leave the tab open, it's misleading.

**Fix.** Either re-anchor `windowNow` on a timer (e.g. every 60s while the tab is visible) and pass `until` to make the window a true `[since, until]`, or drop the freeze entirely and accept that `since` advances with `Date.now()` on each fetch (Convex live queries re-emit anyway, so consistency across pages is already handled by the live subscription — the freeze is solving a problem the manual pattern created).

---

### [SEV: P3] Dead `parseActivityTimeRange` — exported but unused in production

**Location:** `apps/web/src/lib/activity-filters.ts:42-48`, consumed only by `activity-filters.test.ts:26-39`. The route (`activity.tsx:44-49`) inlines the logic instead:

```tsx
// activity.tsx — validateSearch
const range = ACTIVITY_TIME_RANGES.includes(search.range as ActivityTimeRange)
  ? (search.range as ActivityTimeRange) : undefined;
```

```ts
// activity-filters.ts — never called outside its own test
export function parseActivityTimeRange(raw: unknown): ActivityTimeRange { ... }
```

**Problem.** `parseActivityTimeRange` exists, has a test, and is unused by any production code. The route reimplements the same coercion inline (and slightly differently — `parseActivityTimeRange` defaults to `"all"`, the route treats unknown as `undefined`, which then defaults to `"7d"` via `search.range ?? "7d"`, so the two implementations disagree on the default).

**Fix.** Use `parseActivityTimeRange` in `validateSearch` (and reconcile the default), or delete the function and its test.

---

### [SEV: P3] `validateSearch` accepts any string as `project` — garbage URLs error silently

**Location:** `activity.tsx:50-54`.

```tsx
const project = typeof search.project === "string" && search.project.length > 0
  ? search.project : undefined;
```

```tsx
// activity.tsx:144 — cast, no Id-shape validation
args.projectId = projectId as Id<"projects">;
```

**Problem.** No `Id<"projects">` shape validation. A URL like `/app/settings/activity?project=garbage` passes `validateSearch`, gets cast to `Id<"projects">`, and Convex's `v.id("projects")` validator rejects it → query errors → silent empty state (see P2 silent-error-swallowing). The user sees "No activity yet" for a malformed URL.

**Fix.** Validate the Id shape (regex / `isId` from the convex data model) in `validateSearch`, or branch on `usageQuery.isError` so a bad URL doesn't masquerade as "no data."

---

### [SEV: P3] Skeleton row count mismatch — 6 vs `ACTIVITY_PAGE_SIZE` 25

**Location:** `activity.tsx:386-396` (`ActivityTableSkeleton`), `activity-filters.ts:78` (`ACTIVITY_PAGE_SIZE = 25`).

```tsx
{Array.from({ length: 6 }).map((_, i) => ( /* skeleton row */ ))}
```

**Problem.** The skeleton renders 6 placeholder rows; the real first page renders up to 25. On data arrival the table height jumps ~4×. Violates the project rule "loading = layout-stable skeletons."

**Fix.** Render `ACTIVITY_PAGE_SIZE` (or a viewport-reasonable subset like 10–12) skeleton rows.

---

### [SEV: P3] `toLocaleString()` with no options — locale/timezone nondeterminism

**Location:** `activity.tsx:228`.

```tsx
{new Date(event.at).toLocaleString()}
```

**Problem.** `event.at` is a Unix-ms epoch (`v.number()`). `toLocaleString()` with no args uses the browser's default locale *and* timezone, producing wildly different formats across users (e.g. `7/4/2026, 3:14:15 PM` vs `04/07/2026, 15:14:15`). Not SSR-stable, not sortable-looking, no relative time. For a "recent calls" log, a fixed-format or relative ("2m ago") rendering is friendlier and consistent.

**Fix.** Pass explicit `{ dateStyle: "medium", timeStyle: "short" }` (or a shared formatter), or render relative time for recent events. At minimum, decide and be consistent.

---

### [SEV: P3] Reset effect runs on mount and reassigns `windowNow` (root of the duplicate-fetch P2)

**Location:** `activity.tsx:163-170`.

**Problem.** The reset effect's intent is "clear accumulated pages when filters change," but its deps `[timeRange, projectId, orgSlug]` are also evaluated on first commit, so it runs on mount and calls `setWindowNow(Date.now())` — see P2 duplicate-first-page-fetch. The mount run is a no-op for `cursor`/`rows`/`isDone`/`continueCursor` (already defaults) but *not* for `windowNow`.

**Fix.** Guard with a `useRef(true)` skip on first run, or restructure so `windowNow` isn't reset here at all.

---

### [SEV: P3] No table accessibility — missing `<caption>`, `<th scope>`

**Location:** `activity.tsx:199-212`.

```tsx
<table className="w-full text-sm">
  <thead>
    <tr className="border-b text-left text-muted-foreground">
      <th className="px-2 py-2 font-medium">Time</th>
      {/* ...no scope, no caption... */}
```

**Problem.** Screen readers can't associate header cells with data cells without `scope="col"`. No `<caption>` summarizing the table. Minor a11y gap.

**Fix.** Add `scope="col"` to each `<th>` and a visually-hidden `<caption>`.

---

### [SEV: P3] Loading region has no `aria-busy` / live-region announcement

**Location:** `activity.tsx:214-322`.

**Problem.** The table swaps between skeleton, empty, and data with no `aria-busy` on the container and no `aria-live` announcement. Assistive-tech users get no signal that more rows loaded or that a load is in flight beyond the button label.

**Fix.** `aria-busy={firstPagePending || loadMorePending}` on the table container; optionally an `aria-live="polite"` status region for "Loaded N more."

---

### [SEV: P3] `continueCursor` state duplicates `usageQuery.data.continueCursor` — two sources of truth

**Location:** `activity.tsx:117` (`continueCursor` state) vs `usageQuery.data.continueCursor` (mirrored in the merge effect, `184`).

**Problem.** `continueCursor` state is set from `usageQuery.data.continueCursor` inside the merge effect — a lagging mirror. Between a live-query re-emit and the effect running, `continueCursor` state can diverge from the query's actual cursor, causing the "Load more" button's enabled/disabled state (`canLoadMore = !isDone && continueCursor !== null && !usageQuery.isPending`) to flicker or fire with a stale cursor.

**Fix.** Read `continueCursor` directly from `usageQuery.data` in render (it's already there); don't mirror it into state. Same for `isDone`.

---

### [SEV: P3] `mergeUsagePages` allocates a new array even when incoming is empty (non-replace)

**Location:** `activity-filters.ts:60-63`.

```ts
if (incoming.length === 0) {
  return [...existing];   // needless copy when nothing changed
}
```

**Problem.** On every Convex live re-emit that produces an empty page (e.g. the boundary page after the last row), the reducer returns a fresh `[...existing]`, causing a re-render of the whole table for no data change. Minor perf.

**Fix.** `return existing;` when incoming is empty and not replacing (the caller's `setRows(prev => …)` will bail out of the state update if the reference is unchanged).

---

### [SEV: P3] `void navigate(...)` swallows navigation/validation errors

**Location:** `activity.tsx:255-262`, `273-281`.

```tsx
onValueChange={(value) =>
  void navigate({ to: "/app/settings/activity", search: { ... } })
}
```

**Problem.** `void` discards the promise; if `validateSearch` ever throws (e.g. a future validator rejects a value), the navigation silently fails with no signal. Today `validateSearch` can't throw on the inputs passed, but the pattern hides future regressions.

**Fix.** `.catch(...)` with a toast, or at least a `console.error` in dev.

---

### [SEV: P3] `StatusBadge` thresholds mislabel 1xx as destructive

**Location:** `activity.tsx:352-360`.

```tsx
if (status >= 200 && status < 400) return <Badge variant="secondary">{status}</Badge>;
if (status >= 400 && status < 500) return <Badge variant="outline">{status}</Badge>;
return <Badge variant="destructive">{status}</Badge>;   // 1xx, 3xx≥400? no — 3xx is caught above
```

**Problem.** `100 Continue` / `101 Switching Protocols` fall through to `destructive` (red). HTTP 1xx is informational, not an error. Also `0` (gateway network failure / aborted) renders red, which is arguably correct but undocumented.

**Fix.** Add an explicit 1xx branch (neutral/outline) or clamp the destructive branch to `status >= 500 || status === 0`.

---

### [SEV: P3] `validateSearch` default-omits `range: "7d"` — non-shareable default state

**Location:** `activity.tsx:44-52`.

```tsx
return {
  ...(range && range !== "7d" ? { range } : {}),     // "7d" never persisted
  ...(project ? { project } : {}),
};
```

**Problem.** The default range `"7d"` is intentionally stripped from the URL, so a URL with no `range` param and a URL with `?range=7d` are treated as identical — but the Select can never *produce* `?range=7d` either (the onValueChange also omits "7d"). This is fine as a default-omission convention, *except* `parseActivityTimeRange` (the unused helper) defaults unknown to `"all"`, not `"7d"` — so the two code paths disagree on what "no range" means. Pick one.

**Fix.** Decide whether the default is `"7d"` or `"all"` and make `validateSearch`, `parseActivityTimeRange`, and `timeRange = search.range ?? "<default>"` all agree.

---

## Summary

Counts: **1 P1, 7 P2, 13 P3.** Total 21 findings.

Top 3 to fix first:

1. **P1 — Project filter shows false "No activity yet."** `listForOrg` post-filters `projectId` against a page already bounded by the org's top-25 newest; the empty branch hides the "Load more" button, so the data is unreachable. Fix at the query: use `by_project_at` when `projectId` is set, or loop server-side until `numItems` matching rows accumulate.
2. **P2 — Manual pagination reimplements `usePaginatedQuery`.** This is the single root cause of the stale-cursor fetch, the empty-state flash on cached reselect, the live-update append-only drift, the duplicate first-page fetch on mount, and the `continueCursor`/`isDone` source-of-truth drift. Migrating to Convex's paginated primitive deletes five P2 findings at once.
3. **P2 — Silent error swallowing as "No activity yet."** `usageQuery.isError` / `projectsQuery.isError` are never inspected; any Convex/network failure renders identically to a genuine empty state, compounding the P1 (a user can't distinguish "no data" from "backend broken" from "filter reached the wrong branch"). Add explicit error branches with retry.

Notable non-findings (verified clean): no raw Tailwind colors — all classes use semantic tokens (`text-muted-foreground`, `bg-muted`, `text-primary`, `border-dashed`); no hardcoded motion values — no Motion is used; skeletons are present (though row-count-mismatched — P3); `isPending` (not `isLoading`) is used for TanStack Query state throughout, correctly — the only `isLoading` in the file is `useConvexAuth().isLoading`, which is the Convex auth SDK's own API, not a TanStack Query field.
