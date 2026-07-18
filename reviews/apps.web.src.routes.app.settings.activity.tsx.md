# Tiger Review — `apps/web/src/routes/app/settings/activity.tsx`

Scope: `apps/web/src/routes/app/settings/activity.tsx`,
`apps/web/src/lib/activity-filters.ts`, `convex/usage.ts` (consumer-side context
only; the server query is reviewed separately in `reviews/convex.usage.ts.md`).

## Verdict

**Incorrect.** The headline feature of this page — the **Project** filter —
silently renders a false "No activity yet" empty state whenever the selected
project's events do not fall within the org's 25 newest calls, with no path
for the user to reach the hidden rows. That is compounded by a one-frame
flash of stale rows (plus a wasted Convex fetch with a stale cursor) when a
filter changes after pagination, silent swallowing of query errors as "no
activity", a duplicate first-page fetch on mount, and a live-update merge
that only ever appends. No security / data-loss issues; no raw Tailwind colors
or hardcoded motion values (the page is correctly stock-shadcn + semantic
tokens + CSS-only skeletons).

## File Stats

| File | Lines | Findings |
|---|---|---|
| `apps/web/src/routes/app/settings/activity.tsx` | 411 | 7 |
| `apps/web/src/lib/activity-filters.ts` | 78 | 2 |
| `convex/usage.ts` | 95 | 0 (server-side post-filter covered in its own review) |

## Findings

### [SEV: P1] Project filter shows a false "No activity yet" when matching events exist on later pages

**Location:** `apps/web/src/routes/app/settings/activity.tsx:289-318`
(render branch); depends on `convex/usage.ts:64-72` (post-index `projectId`
filter) and `apps/web/src/lib/activity-filters.ts:78` (`ACTIVITY_PAGE_SIZE = 25`).

```tsx
{firstPagePending ? (
  <ActivityTableSkeleton />
) : rows.length === 0 ? (
  <EmptyActivity />
) : (
  <div className="flex flex-col gap-4">
    …table…
    {canLoadMore || loadMorePending ? (
      <div className="flex justify-center">
        <Button … />     // "Load more"
      </div>
    ) : null}
  </div>
)}
```

**Problem.** `api.usage.listForOrg` paginates the `by_org_at` index
(`organizationId, at`) and filters by `projectId` *after* the
`numItems`-sized page is materialized (`convex/usage.ts:64-72`). `isDone` and
`continueCursor` reflect the **unfiltered** scan, so a page can come back
empty while `isDone === false` and `continueCursor !== null`.

The client's render branch keys off `rows.length === 0` → `<EmptyActivity />`,
and `EmptyActivity` renders **no** "Load more" button. So when the selected
project's most recent call is older than the org's 25 newest calls (the common
case for any moderately busy org with a project used hourly/daily rather than
per-second), page 1 comes back empty, the UI shows "No activity yet — Usage
events land after gateway calls. Browse the catalogue, create a key, and make a
call.", and the user has **no way** to reach the rows that provably exist on
page 2+.

`canLoadMore` is computed (`!isDone && continueCursor !== null &&
!usageQuery.isPending`) but is only consumed inside the `else` branch that
never renders when `rows.length === 0`.

**Impact.** The Project filter — a first-class control promoted in the
`CardHeader` — silently returns false negatives for the exact skewed
distribution it exists to navigate. Users conclude the project has no traffic
when it does. This is the primary use case of the filter UI and it is broken
under ordinary load.

**Fix.** Decouple the empty-state from the page-1-empty case, and continue
through empty filtered pages until either a non-empty page arrives or
`isDone`:

```tsx
{firstPagePending ? (
  <ActivityTableSkeleton />
) : rows.length === 0 && isDone ? (
  <EmptyActivity />
) : (
  <div className="flex flex-col gap-4">
    …table (may be empty while loading more)…
    {canLoadMore || loadMorePending ? (
      <div className="flex justify-center">
        <Button … />
      </div>
    ) : null}
  </div>
)}
```

and auto-advance when a filter is active and the page came back empty:

```tsx
useEffect(() => {
  if (
    usageQuery.data &&
    !usageQuery.isPending &&
    (usageQuery.data.page as UsageListItem[]).length === 0 &&
    !usageQuery.data.isDone &&
    usageQuery.data.continueCursor !== null &&
    continueCursor !== usageQuery.data.continueCursor
  ) {
    setCursor(usageQuery.data.continueCursor);
  }
}, [usageQuery.data, usageQuery.isPending, continueCursor]);
```

(The root cause — post-index filtering — is flagged in
`reviews/convex.usage.ts.md`; adding `by_org_project_at` / `by_org_key_at`
indexes would make pages non-sparse. But the client must still not lie about
an empty page 1 regardless of the server fix.)

---

### [SEV: P2] Changing a filter after pagination flashes stale rows and fires a query with a stale cursor

**Location:** `apps/web/src/routes/app/settings/activity.tsx:130-135` (state),
`:155-170` (`listArgs` memo), `:172-179` (reset effect), `:186-198` (render
flags).

```tsx
const [cursor, setCursor] = useState<string | null>(null);
const [rows, setRows] = useState<UsageListItem[]>([]);
…
const listArgs = useMemo(() => {
  …
  return {
    orgSlug,
    paginationOpts: { numItems: ACTIVITY_PAGE_SIZE, cursor },   // ← stale cursor
    projectId?: …,
    since?: …,
  };
}, [orgSlug, cursor, projectId, since]);

const usageQuery = useQuery({ …convexQuery(api.usage.listForOrg, listArgs) });

// Reset accumulated pages when filters change.
useEffect(() => {
  setCursor(null);
  setRows([]);
  setIsDone(false);
  setContinueCursor(null);
  setWindowNow(Date.now());
}, [timeRange, projectId, orgSlug]);
```

**Problem.** Filter state (`timeRange`, `projectId`) lives in the URL search
params and updates synchronously when `navigate()` runs; `cursor` / `rows` /
`windowNow` live in `useState` and are only cleared by the reset
`useEffect`, which runs *after* the stale render is committed to the DOM.

Trace when the user has already clicked "Load more" once (`cursor ===
"<C1>"`, `rows` populated) and then changes the Project or Time-range filter:

1. `search` updates → re-render with new `timeRange`/`projectId`, but
   `cursor` still `"<C1>"` and `rows` still the old set.
2. `listArgs` recomputes to `{ newFilter, cursor: "<C1>" }` — a **semantically
   invalid** combination (the cursor was issued for the *old* filter's page 2).
   `convexQuery` creates a fresh query key → `usageQuery.isPending === true`,
   `usageQuery.data === undefined`.
3. `firstPagePending = usageQuery.isPending && cursor === null` → `true &&
   false` → **`false`**. `rows.length > 0` → the **old filter's rows** render
   for one frame (e.g. the previous project's calls are shown under the new
   project filter).
4. The reset `useEffect` then clears `cursor`/`rows`/`windowNow` and a second
   re-render finally shows the skeleton.

Step 2 also fires a real Convex query for `{ newFilter, cursor: "<C1>" }` —
the stale cursor is a valid Convex opaque token, so the server will happily
return *some* page (likely the wrong slice for the new filter). Its result
lands in the React Query cache orphaned, and if the merge effect's
dependencies fire before the reset effect commits (they can —
`usageQuery.data`/`usageQuery.isPending` are in the dep array alongside
`cursor`), the stale-cursor page could be merged into `rows`. The early
`usageQuery.isPending` guard makes the merge path bail in practice, but the
wasted network round-trip and the painted stale frame are both real.

`useEffect` (not `useLayoutEffect`) defers the reset past paint, so the stale
frame is visible.

**Impact.** One-frame flash of the previous filter's rows + a wasted Convex
fetch with a cursor that does not correspond to the new filter. Common
precondition: user paginates, then narrows the project or time range.

**Fix.** Reset cursor/rows synchronously in the `navigate` handler (or use
`useLayoutEffect`), so the stale `cursor` never reaches `listArgs`:

```tsx
function resetPagination() {
  setCursor(null);
  setRows([]);
  setIsDone(false);
  setContinueCursor(null);
  setWindowNow(Date.now());
}

// in both Select onValueChange handlers:
onValueChange={(value) => {
  resetPagination();
  void navigate({ to: "/app/settings/activity", search: { … } });
}}
```

and drop the now-redundant reset `useEffect` (keep only the `orgSlug` change
case, which cannot be triggered synchronously from a handler).

---

### [SEV: P2] Query errors silently render as "No activity yet"

**Location:** `apps/web/src/routes/app/settings/activity.tsx:121`
(`projectsQuery`), `:171` (`usageQuery`), `:186-198` (render branch).

```tsx
const projectsQuery = useQuery(convexQuery(api.projects.list, { orgSlug }));
…
const usageQuery = useQuery({ …convexQuery(api.usage.listForOrg, listArgs) });
…
const projects = projectsQuery.data ?? [];
const firstPagePending = usageQuery.isPending && cursor === null;
…
{firstPagePending ? <ActivityTableSkeleton /> : rows.length === 0 ? <EmptyActivity /> : …}
```

**Problem.** Neither `usageQuery.error` nor `projectsQuery.error` is ever
inspected. When `listForOrg` rejects — auth drop, Convex transient, or (the
easy case) an invalid `?project=` Id cast straight to `Id<"projects">` (see
P3 below) — `data` is `undefined`, `isPending` is `false`, so
`firstPagePending` is `false` and the render falls through to
`rows.length === 0` → `<EmptyActivity />`.

The user is told "Usage events land after gateway calls. Browse the catalogue,
create a key, and make a call." when the actual condition is a failed query.
The project `Select` silently collapses to just "All projects" when
`projectsQuery` errors (because `projects = projectsQuery.data ?? []`), so a
transient Convex blip makes every project vanish from the dropdown with no
signal.

This is the inverse of "never leak internal errors" — it never surfaces them
at all, so the user cannot distinguish "no data" from "the request failed".

**Impact.** Misleading empty state on any query failure; the Project filter
appears to contain no projects on `projects.list` error. No security leak,
but a real correctness-of-presentation defect.

**Fix.** Branch on `isError` and render a discrete error state (with a retry)
distinct from the genuine empty state:

```tsx
const projects = projectsQuery.data ?? [];
const firstPagePending = usageQuery.isPending && cursor === null;

if (usageQuery.isError || projectsQuery.isError) {
  return (
    <div className="flex flex-col gap-6">
      <ActivityHeader />
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Couldn't load activity.{" "}
          <Button variant="link" size="sm" onClick={() => void usageQuery.refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
```

---

### [SEV: P2] `windowNow` reset effect fires on mount, triggering a duplicate first-page fetch

**Location:** `apps/web/src/routes/app/settings/activity.tsx:130`, `:172-179`.

```tsx
const [windowNow, setWindowNow] = useState(() => Date.now());
…
useEffect(() => {
  setCursor(null);
  setRows([]);
  setIsDone(false);
  setContinueCursor(null);
  setWindowNow(Date.now());          // ← different from the initializer
}, [timeRange, projectId, orgSlug]);
```

**Problem.** `windowNow` is initialised to `Date.now()` via the `useState`
lazy initializer. The reset `useEffect` unconditionally runs on mount (its dep
tuple `[timeRange, projectId, orgSlug]` is "new" on first commit) and calls
`setWindowNow(Date.now())` again. A few milliseconds have elapsed, so the new
value differs from the initializer, `since = activitySinceMs(timeRange,
windowNow)` changes, `listArgs` changes, and a **second** page-1 query is
issued against Convex with a minutely different `since` bound.

For the default `"7d"` range, the two `since` values differ by a few ms but
produce distinct `paginationOpts`/`since` query keys, so both fetches execute
and both land in the cache (the orphaned one is never read). On every mount of
the route (including client-side navigation back to the tab) the page fires
2× the necessary queries.

**Impact.** Wasted control-plane work and an extra render on every mount. No
correctness impact.

**Fix.** Skip the reset on mount, or fold `windowNow` into the filter-change
path so it only updates when a filter actually changes:

```tsx
const firstRender = useRef(true);
useEffect(() => {
  if (firstRender.current) {
    firstRender.current = false;
    return;
  }
  setCursor(null);
  setRows([]);
  setIsDone(false);
  setContinueCursor(null);
  setWindowNow(Date.now());
}, [timeRange, projectId, orgSlug]);
```

(Or, per the P2 fix above, move the reset into the navigate handler entirely
and delete this effect.)

---

### [SEV: P2] Live Convex updates append without removing scrolled-off rows when cursor is non-null

**Location:** `apps/web/src/routes/app/settings/activity.tsx:181-185`; merge
helper `apps/web/src/lib/activity-filters.ts:56-72`.

```tsx
useEffect(() => {
  if (!usageQuery.data || usageQuery.isPending) {
    return;
  }
  const page = usageQuery.data.page as UsageListItem[];
  const replace = cursor === null;                 // ← false on page 2+
  setRows((prev) => mergeUsagePages(prev, page, replace));
  setIsDone(usageQuery.data.isDone);
  setContinueCursor(usageQuery.data.continueCursor);
}, [usageQuery.data, usageQuery.isPending, cursor]);
```

```ts
// activity-filters.ts
export function mergeUsagePages<T extends UsageRowId>(
  existing: readonly T[],
  incoming: readonly T[],
  replace: boolean,
): T[] {
  if (replace) return [...incoming];
  …
  const seen = new Set(existing.map((row) => row._id));   // dedupe only
  const next = [...existing];
  for (const row of incoming) {
    if (!seen.has(row._id)) { seen.add(row._id); next.push(row); }
  }
  return next;
}
```

**Problem.** `convexQuery` is a **live** subscription. `usageQuery.data`
changes identity on every Convex re-run — i.e. on every `usageEvents` insert
for the org (the gateway DO alarm flushes batches roughly every ~5s). The
merge effect re-fires on each update.

When `cursor !== null` (user has paginated to page 2+), `replace === false`,
so `mergeUsagePages` only **appends** new `_id`s (deduped). It never removes
rows. So when a live insert shifts the page-2 window forward (newer events
displace the oldest items on page 2 past `numItems`), the displaced items
**remain in `rows`** even though they are no longer in the query result for
that cursor. `rows` grows monotonically and drifts out of sync with what the
server actually returned for the current cursor.

Worse, `setIsDone` / `setContinueCursor` are re-applied from the live update,
so the "Load more" button's availability can flip as the live snapshot
changes — independently of what the user has actually loaded.

(The page-1 case, `cursor === null`, `replace === true`, is fine: live
updates correctly replace the visible window.)

**Impact.** On any active org with the activity tab paginated past page 1, the
visible list silently accumulates stale rows and can show items the server no
longer returns for the current cursor. No data corruption, but the feed's
content becomes inconsistent with the query contract.

**Fix.** Track the cursor the live page belongs to and replace (not append)
when the incoming page is for the *current* cursor; only append when it is a
genuinely new page loaded by an explicit "Load more" click:

```tsx
const lastMergedCursorRef = useRef<string | null>(null);

useEffect(() => {
  if (!usageQuery.data || usageQuery.isPending) return;
  const page = usageQuery.data.page as UsageListItem[];
  // Replace when this is the page for the cursor we currently hold
  // (covers both page-1 and live updates to any loaded page).
  const replace = lastMergedCursorRef.current === cursor;
  setRows((prev) => mergeUsagePages(prev, page, replace));
  lastMergedCursorRef.current = cursor;
  setIsDone(usageQuery.data.isDone);
  setContinueCursor(usageQuery.data.continueCursor);
}, [usageQuery.data, usageQuery.isPending, cursor]);
```

(Or simpler and more correct: drive the whole list from
`useInfiniteQuery`/Convex's `usePaginatedQuery` instead of hand-rolling
cursor + rows state, which is the actual root cause of every pagination
finding in this review.)

---

### [SEV: P3] `as Id<"projects">` cast on a weakly-validated URL string

**Location:** `apps/web/src/routes/app/settings/activity.tsx:48-67`
(`validateSearch`), `:162` (`args.projectId = projectId as Id<"projects">`).

```tsx
validateSearch: (search: Record<string, unknown>): ActivitySearch => {
  …
  const project =
    typeof search.project === "string" && search.project.length > 0
      ? search.project
      : undefined;
  return { …(project ? { project } : {}) };
},
…
if (projectId !== "all") {
  args.projectId = projectId as Id<"projects">;        // ← unchecked cast
}
```

**Problem.** `validateSearch` only asserts `typeof === "string" && length > 0`.
Any string (`?project=garbage`, `?project=1`) is cast to `Id<"projects">` and
sent to Convex, where `v.id("projects")` rejects it at runtime → the query
errors → per the P2 above, the UI silently shows "No activity yet". There is
no `parseActivityTimeRange`-equivalent for the project id, and the existing
`parseActivityTimeRange` helper (see next finding) is the model that *should*
be followed.

**Impact.** No security issue (Convex's validator is the real gate), but a
tampered or stale URL produces a misleading empty state instead of either
falling back to "All projects" or surfacing an error. Dishonest cast.

**Fix.** Either validate the Id shape in `validateSearch` (regex / length) and
drop to `undefined` on mismatch, or — simpler — let the `Id<"projects">`
narrowing happen at the point of use with an explicit guard that falls back
to "all":

```tsx
if (projectId !== "all") {
  // Id<"projects"> shape check; fall back to "all" on malformed input
  if (/^[a-z0-9]{32}$/i.test(projectId)) {
    args.projectId = projectId as Id<"projects">;
  }
}
```

---

### [SEV: P3] `parseActivityTimeRange` exported and unit-tested but unused; route duplicates the logic inline

**Location:** `apps/web/src/lib/activity-filters.ts:41-47` (export);
`apps/web/src/routes/app/settings/activity.tsx:48-53` (inline duplication);
`apps/web/src/lib/activity-filters.test.ts:26-39` (only consumer).

```ts
// activity-filters.ts — exported, tested, never imported by the route
export function parseActivityTimeRange(raw: unknown): ActivityTimeRange {
  if (raw === "24h" || raw === "7d" || raw === "30d" || raw === "all") {
    return raw;
  }
  return "all";
}
```

```tsx
// activity.tsx — re-implements the same coercion inline
const range = ACTIVITY_TIME_RANGES.includes(search.range as ActivityTimeRange)
  ? (search.range as ActivityTimeRange)
  : undefined;
```

**Problem.** The route re-implements range coercion via
`ACTIVITY_TIME_RANGES.includes(search.range as ActivityTimeRange)` instead of
calling the provided `parseActivityTimeRange` helper. The helper's only
importer is its own test file (`activity-filters.test.ts:6`), so it is
effectively dead production code. The two implementations also disagree on the
default: `parseActivityTimeRange` returns `"all"` for unknown input, while the
route's inline coercion returns `undefined` (which the component later
defaults to `"7d"` via `search.range ?? "7d"`).

**Impact.** Two sources of truth for the same coercion with divergent
defaults; the tested helper is unused; the untested inline copy is the one
that ships.

**Fix.** Use the helper, and delete the inline copy:

```tsx
import { parseActivityTimeRange, … } from "#/lib/activity-filters";
…
validateSearch: (search: Record<string, unknown>): ActivitySearch => {
  const range = parseActivityTimeRange(search.range);
  const project =
    typeof search.project === "string" && search.project.length > 0
      ? search.project
      : undefined;
  return {
    ...(range !== "7d" ? { range } : {}),
    ...(project ? { project } : {}),
  };
},
```

(and if the `"7d"` default should survive the helper, make
`parseActivityTimeRange` accept a `defaultValue` param, or keep the
`?? "7d"` fallback in the component — but pick one coercion site.)

---

### [SEV: P3] `activitySinceMs` doc-comment claims `[since, now]` (closed) but the client sends only `since` (open-ended live tail)

**Location:** `apps/web/src/lib/activity-filters.ts:18-25`.

```ts
/**
 * Lower bound for `api.usage.listForOrg` `since` arg.
 * `all` → undefined (no lower bound). Window is half-open [since, now].
 */
export function activitySinceMs(
  range: ActivityTimeRange,
  now: number = Date.now(),
): number | undefined { … }
```

**Problem.** The comment documents the window as half-open `[since, now]`,
implying an upper bound of `now`. But the route never passes `until` to
`listForOrg` (the `until` arg is declared on the query but unused by the only
client). The actual window is `[since, +∞)` — a live tail that grows as new
events arrive. `windowNow` is frozen only to stabilise the *lower* bound
(`now - 7d`); it does not cap the upper bound.

A reader who trusts the comment and later adds a `until: windowNow` call
would *change* the feed's behaviour (events newer than the filter-change time
would be excluded) — a latent footgun.

**Impact.** Documentation lies about the interval semantics; latent behaviour
change for the next editor.

**Fix.** Correct the comment to match the implementation:

```ts
/**
 * Lower bound for `api.usage.listForOrg` `since` arg.
 * `all` → undefined (no lower bound). The window is open on the upper
 * end ([since, +∞)) so the feed receives a live tail of new events;
 * `now` is captured per filter-change only to stabilise the lower bound.
 */
```

---

## Summary

**Counts:** P0: 0 · P1: 1 · P2: 4 · P3: 3

**Top 3 to fix first:**

1. **Stop lying about empty page 1** (P1) — the Project filter renders a false
   "No activity yet" whenever the selected project's events fall outside the
   org's 25 newest calls, with no Load-more path to recover. Decouple
   `EmptyActivity` from `rows.length === 0 && !isDone`, and auto-advance
   through empty filtered pages. This is the headline defect.
2. **Stop the flash + stale-cursor fetch on filter change** (P2) — reset
   `cursor`/`rows`/`windowNow` synchronously in the `navigate` handler
   (or `useLayoutEffect`), not in a deferred `useEffect`, so the stale cursor
   never reaches `listArgs`.
3. **Surface query errors instead of masking them as empty state** (P2) —
   branch on `usageQuery.isError` / `projectsQuery.isError` and render a
   retry-able error state distinct from genuine emptiness.

**Root-cause note:** four of the eight findings (flash, duplicate mount fetch,
live-append drift, false-empty) stem from hand-rolling pagination state in
`useState` + `useEffect` on top of a live Convex subscription. Migrating to
`usePaginatedQuery` (Convex) or `useInfiniteQuery` (React Query) would
eliminate the entire class; the per-finding fixes above are the surgical
path if the hand-rolled pattern is kept.

No raw Tailwind colors, no hardcoded motion values, no `isLoading` misuse
(`isPending` is used throughout per the project convention), skeletons are
present and layout-stable. The defects are all in pagination/filter/error
state-machine handling.
