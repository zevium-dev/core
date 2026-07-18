# Tiger Deep Review — `apps/web/src/routes/catalogue/index.tsx`

**Scope:** `apps/web/src/routes/catalogue/index.tsx` (593 lines) + cross-read of
`apps/web/src/lib/catalogue-card.ts`, `apps/web/src/lib/catalogue-search.ts`,
`convex/catalogue.ts`, `convex/search.ts`, and the detail route
`apps/web/src/routes/catalogue/$orgSlug.$projectSlug.tsx` (to verify the
view-transition morph contract).

The prior shallow review flagged 1 P1 + 3 P2 + 3 P3. This deep pass **confirms
all of them** and expands to **2 P1 + 9 P2 + 4 P3**. No praise below.

---

## Verdict

**FAIL — do not ship as-is.** Two P1 correctness defects are user-visible in
the common path:

1. The semantic-search mutation's `onSuccess` unconditionally commits results
   with no request-token guard, and `exitSemanticMode` is a **no-op while a
   search is pending** — so the "Back to browse" button is inert during
   pending, and any in-flight action drags the user back into semantic mode
   with stale results after they explicitly exited or edited the query.
2. The tag-filter chip set is derived only from `data.items` (the current
   24-item page), so tags that exist only on later pages are invisible — the
   filter is silently biased and incomplete, and because pagination is not
   wired those items are permanently unreachable.

Both are cheap to fix and high-impact. The remaining P2/P3 are quality and
contract gaps (half-wired view transitions, slug-collision morph keys, double
backend scan, skeleton flashing on every filter toggle, no URL state, no
`prefers-reduced-motion` guard, etc.).

---

## File Stats

| metric | value |
| --- | --- |
| file | `apps/web/src/routes/catalogue/index.tsx` |
| lines | 593 |
| components | `CataloguePage`, `BrowsePanel`, `SemanticResults`, `CatalogueList`, `CatalogueCard`, `CatalogueEmpty`, `CatalogueGridSkeleton`, `CatalogueSkeleton` |
| queries | `api.catalogue.listPublic` (suspense), `api.search.searchCatalogue` (action via `useAction`) |
| mutations | 1 `useMutation` wrapping the Convex action (semantic search) |
| view transitions | `catalogue-heading`, `api-title-${slug}`, `api-price-${slug}` |

---

## Findings

### [P1] Stale-results race + inert "Back to browse" while pending (CONFIRMED + EXPANDED)

**Location:** `index.tsx:71-91` (mutation), `index.tsx:122` (`exitSemanticMode`),
`index.tsx:113-116` (`handleSearchInput`).

```ts
const { mutate: runSemanticSearch, isPending: semanticPending } = useMutation({
  mutationFn: (query: string) => runSemanticAction({ query, limit: 20 }),
  onSuccess: (res) => {
    setSemanticItems(res.degraded ? null : res.items); // unconditional
  },
  onError: () => setSemanticItems(null),
});

const inSemanticMode = semanticItems !== null || semanticPending;
const exitSemanticMode = () => setSemanticItems(null);
```

**Problem.** Three interleaved defects:

1. **`exitSemanticMode` is a no-op while pending.** After submit, `semanticItems`
   is still `null` and `semanticPending=true`. `inSemanticMode = (null !==
   null) || true = true` → the user is parked on the pending skeleton. Clicking
   "Back to browse" calls `setSemanticItems(null)` — but it was already `null`,
   so React does not re-render out of `SemanticResults`, and `semanticPending`
   is still `true`. The button is rendered but inert. The user is **trapped on
   the skeleton** until the action resolves.

2. **Stale drag-back after explicit exit.** If the user does manage to exit
   (only possible once results have loaded, so `semanticItems` is non-null),
   then submits a new search and clicks "Back to browse" while that second
   search is pending, `exitSemanticMode` sets `semanticItems=null` but
   `semanticPending` is still `true` → still in `SemanticResults`. When the
   slow action resolves, `onSuccess` unconditionally runs
   `setSemanticItems(res.items)` → `inSemanticMode` flips back to `true` and the
   user is **dragged back into semantic mode with results they explicitly
   dismissed**.

3. **No request-token / no cancellation.** React Query mutations do not cancel
   each other. If the user submits query A, then query B before A resolves,
   both `onSuccess` handlers fire in arrival order: B commits, then A
   overwrites with stale results. `isPending` is also a single boolean for the
   whole mutation, so it cannot distinguish which request is in flight.

4. **`handleSearchInput` re-triggers the trap.** Editing the query clears
   `semanticItems` to `null` but not `semanticPending`. If a search is pending
   when the user types, `inSemanticMode` stays `true` (skeleton) and the
   pending `onSuccess` will drag the user back into semantic mode for the old
   query — the exact "editing the query drags back into semantic mode with
   stale results" finding from the prior review, now fully traced.

**Impact.** The primary search affordance on the catalogue page is
unpredictable: clicking the prominently-placed "Semantic" button can leave the
user stuck on a skeleton they cannot dismiss, and can re-enter a mode they
explicitly left. This is the single most visible interaction on the page.

**Fix.**
- Add a monotonic request token: `const reqId = useRef(0)`, increment on each
  `submitSemanticSearch`, capture `const myId = ++reqId.current` in the
  closure, and in `onSuccess` / `onError` bail unless `reqId.current === myId`.
- Track user intent to exit: a `const exitedRef = useRef(false)` set in
  `exitSemanticMode` and `handleSearchInput`, reset on `submitSemanticSearch`;
  bail out of `onSuccess` if `exitedRef.current`.
- Clear `semanticPending` semantically by allowing `exitSemanticMode` to
  actually leave the mode: that requires either cancelling the action or
  ignoring its result, which the two guards above achieve.
- Optional: `mutationKey: ['catalogue-semantic']` plus `scope: { id: 'catalogue-semantic' }`
  so React Query's `useMutation` can be used with `context` cancellation, but
  the token pattern alone is sufficient and framework-agnostic.

---

### [P1] Tag-filter chip set is derived only from the first 24 items (page-biased)

**Location:** `index.tsx` `CatalogueList`, `useMemo` over `data.items`
(approx. lines 374-381).

```ts
const tags = useMemo(() => {
  const set = new Set<string>();
  for (const item of data.items) {
    for (const tag of item.tags) set.add(tag);
  }
  if (activeTag) set.add(activeTag);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}, [data.items, activeTag]);
```

**Problem.** `data.items` is the current page only (`PAGE_SIZE = 24` in
`convex/catalogue.ts:6`). The tag chips — the entire filter affordance — are
built from those 24 rows. Any tag that appears only on items 25+ is never shown
as a chip, so the user cannot select it. The `if (activeTag) set.add(activeTag)`
line is a band-aid that only keeps the *currently active* tag visible; it does
not surface tags from later pages the user has never selected.

This compounds with the missing pagination (see P2 below): since the UI never
loads items 25+, the tag set is permanently capped at the first 24 items' tags.

**Impact.** The tag filter is silently incomplete and biased toward whichever
24 items happen to sort first. A user looking for a "payments"-tagged API that
sits at position 30 will never see the `payments` chip and cannot filter for it.
This is a correctness defect in the primary browse affordance, not just a UX
gap.

**Fix.** Either (a) expose a dedicated `listTags` query in `convex/catalogue.ts`
that returns the distinct tag set across *all* public+published projects (one
index scan, cheap, reusable), or (b) fold the tag aggregation into `listPublic`'s
response (return `tags: {tag, count}[]` alongside `items`) so the chip strip is
page-independent. Option (a) is cleaner — the tag set is independent of paging
and sort.

---

### [P2] Half-wired view transition: `api-price-${slug}` has no target on the detail route (CONFIRMED)

**Location:** `index.tsx:488-494` (card source) vs
`apps/web/src/routes/catalogue/$orgSlug.$projectSlug.tsx:263-269` (detail
target — only `api-title-${slug}` is set).

```ts
// index.tsx — card
{priceLabel ? (
  <Badge variant="outline" className="font-mono"
    style={{ viewTransitionName: `api-price-${item.slug}` }}>
    {priceLabel}
  </Badge>
) : null}
```

**Problem.** The card sets both `api-title-${slug}` and `api-price-${slug}`.
The detail route sets only `api-title-${data.project.slug}` — confirmed by
grepping the detail file (`$orgSlug.$projectSlug.tsx:265-267`). There is no
matching `api-price-${slug}` target on the detail page. Per the View Transitions
API, a source name with no target still consumes the transition budget and
produces nothing (or, in some browsers, a console warning). The price badge
"morph" is half-wired: it animates out from the card with no destination.

**Impact.** Either a no-op transition or a broken morph depending on browser;
either way the rule in `PROJECT.md` ("every list→detail nav ships view-transition
morph or written reason") is violated for the price badge. Either add the
matching target on the detail route's price span, or drop the
`viewTransitionName` from the card's price badge.

**Fix.** On the detail route, the price is rendered inline as `{priceRange}`
inside a `<span className="tabular-nums text-foreground">`. Add
`style={{ viewTransitionName: \`api-price-${data.project.slug}\` }}` to that
span so the morph resolves — and gate it on `priceRange` being truthy to mirror
the source's conditional render.

---

### [P2] `viewTransitionName` uses bare `item.slug` — collides across orgs sharing a project slug (CONFIRMED)

**Location:** `index.tsx:454-456` (`api-title-${item.slug}`),
`index.tsx:490-492` (`api-price-${item.slug}`); detail route
`$orgSlug.$projectSlug.tsx:265-267` (same bare-slug pattern).

**Problem.** Project `slug` is unique within an org, **not globally unique**
(`convex/schema.ts` `by_org_slug` index is `(organizationId, slug)` — confirmed
in `getPublicDetail`'s lookup at `convex/catalogue.ts`). Two orgs can each
publish a project with slug `weather`. On the catalogue index grid both cards
would render `viewTransitionName: "api-title-weather"` simultaneously. The View
Transitions API requires transition names to be **unique per document**;
duplicates cause the browser to skip the named morph (or warn). Worse, the
detail route also uses the bare slug, so navigating from one card could morph
against the wrong-named element if both were on screen.

**Impact.** Broken or no morph whenever two orgs share a project slug — which
is a supported state. Latent today only because the catalogue is small, but the
defect is structural, not data-dependent.

**Fix.** Namespace by org: `api-title-${item.orgSlug}-${item.slug}` and
`api-price-${item.orgSlug}-${item.slug}` on the card; mirror exactly on the
detail route using `data.org.slug` and `data.project.slug` (both already loaded
there). This also keeps the names stable if a project is ever moved between
orgs (it cannot be, but the invariant is clearer).

---

### [P2] No pagination wired — `nextCursor` dead, catalogue silently caps at 24 items (CONFIRMED)

**Location:** `index.tsx` `CatalogueList` (consumes only `data.items`,
ignores `data.nextCursor`); `convex/catalogue.ts:8` `PAGE_SIZE = 24`,
`convex/catalogue.ts:227-230` builds `nextCursor` from the offset.

**Problem.** `listPublic` is a proper cursor-paginated query: it slices
`filtered.slice(start, start + PAGE_SIZE)` and returns
`nextCursor: string | null`. The route's `CatalogueList` reads `data.items`
only and never renders a "Load more" control, an infinite sentinel, or any
other consumer of `nextCursor`. So once the catalogue exceeds 24 published
public projects, items 25+ are silently unreachable from the UI — in any sort
order and regardless of filters. The empty-state copy ("No public APIs yet")
will also mislead once there *are* APIs, just past page 1 with the current
filter.

This defect is the root cause of the P1 tag-bias issue: the tag `useMemo`
cannot see beyond the first 24 items because the route never asks for them.

**Impact.** Hard cap at 24 visible APIs. Browse-only users (the majority of
catalogue traffic) will conclude the marketplace is smaller than it is. As soon
as the catalogue grows past 24 items this becomes a commercial defect, not a
nit.

**Fix.** Wire `nextCursor` into either (a) a "Load more" `<Button>` that calls a
`useSuspenseQuery`/`fetchNextPage`-style helper (`@convex-dev/react-query`
exposes pagination via `paginationOpts` — see the memory note that
`paginationOpts: { numItems, cursor }` has no `id` field), or (b) an
`IntersectionObserver` sentinel at the grid tail that auto-loads the next page.
Given the existing `cursor` semantics (an integer offset string), either is
mechanical.

---

### [P2] `data.total` returned but unused; backend runs a redundant second 1000-doc scan per refetch (CONFIRMED)

**Location:** `convex/catalogue.ts:62-72` (second `.take(1000)` scan),
`convex/catalogue.ts:54-60` (first `.collect()`), `index.tsx` (the route never
reads `data.total`).

```ts
// convex/catalogue.ts
const candidates = await ctx.db
  .query("projects")
  .withIndex("by_visibility_status", (q) =>
    q.eq("visibility", "public").eq("status", "published"),
  )
  .collect();

const totalDocs = await ctx.db
  .query("projects")
  .withIndex("by_visibility_status", (q) =>
    q.eq("visibility", "public").eq("status", "published"),
  )
  .take(1000);
const total = totalDocs.length;
```

**Problem.** The handler scans the same index **twice** on every invocation:
once with `.collect()` (all matching docs, unbounded) into `candidates`, and
again with `.take(1000)` into `totalDocs` purely to compute `total`. The `total`
field is returned to the client, but `CatalogueList` only ever reads
`data.items` — `total` is never consumed by any component in this route (grep
confirms no `data.total` reference in `apps/web/src/routes/catalogue/`).
So every catalogue refetch — which happens on every debounced search keystroke,
every tag toggle, every sort flip, every max-cost change — pays for a second
full index scan whose result is discarded. The comment on `total` ("the landing
'APIs listed' stat wants the whole catalogue size") suggests it was intended for
the landing page, but the landing page is not this route; if the landing page
needs it, it should call a separate `countPublic` query, not piggyback on
`listPublic`.

Note also `candidates.length` already equals the uncapped public+published
count, so `totalDocs` is both redundant *and* less accurate (caps at 1000).

**Impact.** Wasted Convex read budget on every filter interaction. Inflates
query latency and cost; the waste scales with catalogue size.

**Fix.** Drop the `totalDocs` scan and the `total` return field from
`listPublic` entirely — the route does not use it. If the landing stat needs a
total, add a dedicated `countPublic` query (a `.take(1000)` count or a true
aggregate when Convex ships one) and call it from the landing route only.

---

### [P2] Relevance chip shows "0% match" for genuine hits; low-score hits look broken (CONFIRMED)

**Location:** `apps/web/src/lib/catalogue-search.ts:11-21`, `index.tsx:440-443`
+ `index.tsx:476-481`.

```ts
// catalogue-search.ts
export function relevanceFraction(score: number): number {
  if (Number.isNaN(score)) return 0;
  return Math.max(0, Math.min(1, score));
}
export function formatRelevance(score: number): string {
  const pct = Math.round(relevanceFraction(score) * 100);
  return `${pct}% match`;
}
```

```tsx
// index.tsx
const relevance = item.score === undefined ? null : formatRelevance(item.score);
…
{relevance ? (<Badge variant="outline" className="font-mono text-muted-foreground">{relevance}</Badge>) : null}
```

**Problem.** Gemini `gemini-embedding-001` cosine similarity for
`RETRIEVAL_QUERY` vs `RETRIEVAL_DOCUMENT` is frequently a small positive number
(0.0–0.4 is common for genuine matches) and can be ≤ 0 for adjacent-topic
documents. `formatRelevance` rounds to a percentage, so:
- `score = 0.004` → "0% match" (rounds down) on a genuine top-20 hit.
- `score ≤ 0` → "0% match" on a genuine hit that simply had a non-positive
  cosine.

The card then renders a "0% match" chip on a real search result, which reads as
"this is a zero-relevance result" to the user. The truthy-string guard
`{relevance ? … : null}` does not help — `"0% match"` is truthy, so the chip
always renders when `score` is defined.

**Impact.** A catalogue search returning genuine matches presents them with a
"0% match" label. This actively undermines trust in the semantic search
feature the route is showcasing.

**Fix.** Either (a) hide the chip below a threshold (e.g. `score < 0.05` →
`null`), (b) drop the percentage and show a qualitative label ("Match",
"Strong match" for `score > 0.5`), or (c) rescale using the min/max score in the
result set so the worst hit isn't pinned to 0%. Option (a) is the smallest
change and removes the misleading case outright.

---

### [P2] Hardcoded hover/press transforms bypass `motion.ts`; no `prefers-reduced-motion` guard (CONFIRMED)

**Location:** `index.tsx:448` (card), `index.tsx:178-186` and
`index.tsx:201-209` (tag buttons).

```tsx
<Card className="h-full transition-[transform,box-shadow,border-color]
  duration-[var(--dur-instant)] ease-[var(--ease)]
  group-hover:-translate-y-0.5 group-hover:shadow-sm group-active:scale-[0.98]">
```

**Problem.** The duration and easing correctly reference CSS vars
(`--dur-instant`, `--ease`) sourced from `apps/web/src/lib/motion.ts`. But the
transform *magnitudes* (`-translate-y-0.5` = 2px, `scale-[0.98]` = −2%) are
hardcoded magic numbers, not derived from `motion.ts`'s `DIST = 16` (px
translate) constant. The project rule is explicit: "all animation from
`src/lib/motion.ts` / CSS vars". Half of this animation (timing) is sourced
from the single source of truth; the other half (transform distance) is not.

More importantly, there is **no `prefers-reduced-motion` guard**. The transforms
apply verbatim to users with reduced-motion preference. `PROJECT.md` lists
`prefers-reduced-motion` as a hard rule. The tag buttons have the same gap
(`hover:bg-accent`, `hover:bg-accent/40` are color-only and acceptable, but the
card's `group-hover:-translate-y-0.5` and `group-active:scale-[0.98]` are motion
and must be suppressed for reduced-motion users).

**Impact.** Accessibility regression for reduced-motion users on the primary
browse affordance; violates the documented animation single-source-of-truth.

**Fix.** Wrap the transform utilities in `motion-safe:` (or the inverse
`motion-reduce:` override) so they are suppressed when the user prefers reduced
motion. For the magnitude, either accept the small 2px lift as a deliberate
card-hover micro-interaction and document it, or drive it from a CSS var added
to `motion.ts` (e.g. `--lift-card: 2px`) so the value is centralized.

---

### [P2] `useSuspenseQuery` re-suspends on every filter change → skeleton flash on every sort/tag/price toggle

**Location:** `index.tsx` `CatalogueList`, `useSuspenseQuery(convexQuery(...))`
with arg object rebuilt per render (approx. lines 360-371).

```tsx
const { data } = useSuspenseQuery(
  convexQuery(api.catalogue.listPublic, {
    ...(trimmed.length > 0 ? { search: trimmed } : {}),
    ...(activeTag ? { tag: activeTag } : {}),
    sort,
    ...(freeOnly ? { hasFreeTier: true } : {}),
    ...(maxCost !== null ? { maxCost } : {}),
  }),
);
```

**Problem.** Every filter change (sort, tag, free-only, max-cost, debounced
search) produces a new args object → new `convexQuery` key → `useSuspenseQuery`
re-suspends → the `<Suspense fallback={<CatalogueGridSkeleton />}>` in
`BrowsePanel` replaces the live grid with a 6-card skeleton on **every single
interaction**. There is no `placeholderData: keepPreviousData` (TanStack Query
v5 idiom; the project memory notes `keepPreviousData` is gone in v5) to smooth
this. Each click of "Name" sort, each tag chip, each max-cost debounced update
flashes the grid away and back.

**Impact.** The browse filter UX feels sluggish and janky — the user's scrolled
position is lost on every filter change, and the skeleton communicates "loading"
for a result that is, in practice, sub-100ms. It is the opposite of the
"layout-stable skeletons" rule for *loading* states — here the skeleton is
flashing for already-cached-adjacent data.

**Fix.** Add `placeholderData: keepPreviousData` (import from
`@tanstack/react-query`) to the `convexQuery` options so prior-page data stays
mounted while the new filter resolves. The memory note confirms this is the v5
migration path. Combined with the existing skeleton this gives a stable grid
that updates in place.

---

### [P2] Degraded semantic search silently bounces to browse with stale `debouncedSearch` and no feedback

**Location:** `index.tsx:78-82` (`onSuccess` degraded branch), `index.tsx:113-116`
(`handleSearchInput` clears semantic mode but not the debounce), `index.tsx:91`
(`inSemanticMode`).

**Problem.** When Gemini is down or unconfigured, `searchCatalogue` returns
`{ items: [], degraded: true }` (confirmed in `convex/search.ts:336-343`).
`onSuccess` then runs `setSemanticItems(null)` → `inSemanticMode=false` →
`BrowsePanel` mounts. The comment claims a "silent substring fallback", but
**no substring fallback is actually wired**: `BrowsePanel` filters by
`debouncedSearch`, which lags `searchInput` by up to `SEARCH_DEBOUNCE_MS`
(250 ms). So the user, who just typed a query and clicked "Semantic", sees:

1. A pending skeleton for ~the action's duration.
2. A silent bounce to browse showing results filtered by the *previously
   debounced* search string (possibly empty if they typed and clicked within
   250 ms — unfiltered browse flash).
3. 0–250 ms later, `debouncedSearch` catches up and the grid re-filters.

There is also no toast, no inline "Semantic search unavailable, showing browse
results" notice — the failure is fully invisible. `onError` has the same
behavior (`setSemanticItems(null)`).

**Impact.** On any Gemini outage the catalogue's headline search feature fails
silently and presents a confusing double-flash (browse with stale filter →
browse with correct filter). The user has no way to know semantic search is
broken versus just returning no matches.

**Fix.** On degraded, force `setDebouncedSearch(searchInput)` (or read
`searchInput` directly) so the browse fallback reflects what the user actually
typed, and surface a muted inline notice ("Semantic search unavailable —
showing text matches.") in the `BrowsePanel` header. Same for `onError`.

---

### [P2] No `errorComponent` on the route; `listPublic` failure hits the default error boundary

**Location:** `index.tsx:38-54` (Route definition has `loader`, `component`,
`head`, `pendingComponent` — no `errorComponent`).

**Problem.** The route declares `pendingComponent: CatalogueSkeleton` but no
`errorComponent`. `CatalogueList` uses `useSuspenseQuery`, so any thrown error
(Convex query failure, transient network error, schema mismatch during deploy)
propagates to the nearest error boundary — which for this layout is the root
TanStack Router boundary, rendering a generic full-page error and losing the
`PublicHeader` + search affordance context. The user cannot retry from context;
they must hard-refresh.

**Impact.** Any transient `listPublic` failure produces a jarring full-app
error page instead of an inline "Couldn't load catalogue — Retry" card.

**Fix.** Add an `errorComponent` that renders `PublicHeader` + a `Card` with
the error message and a "Retry" button wired to `routeContext.queryClient`
`.invalidateQueries` for the listPublic key. Match the visual structure of
`CatalogueEmpty` so the failure feels in-context.

---

### [P3] Tag buttons missing `aria-pressed`; active state is visual-only

**Location:** `index.tsx:192-211` ("All" + tag chips).

```tsx
<button type="button" onClick={() => onTagChange(null)}
  className={cn("…", activeTag === null ? "border-primary bg-primary …" : "…")}>
  All
</button>
```

**Problem.** The active tag is conveyed only via className (`border-primary
bg-primary text-primary-foreground`). Screen readers announce these as generic
buttons with no pressed/selected state. `aria-pressed={activeTag === tag}` (and
`aria-pressed={activeTag === null}` for "All") is the correct affordance for a
single-select toggle.

**Impact.** Minor accessibility gap; AT users cannot tell which tag is active.

**Fix.** Add `aria-pressed={...}` to all three button variants (All, tag,
freeOnly is a checkbox and already exposes checked state).

---

### [P3] "0 cr/call" label for fully-free APIs is confusing

**Location:** `apps/web/src/lib/catalogue-card.ts:11-19` +
`convex/catalogue.ts:43-47` (where `minCost=0, maxCost=0` when all endpoints
free).

```ts
if (pricing.minCost === pricing.maxCost) {
  return `${pricing.minCost} cr/call`;
}
```

**Problem.** A published spec where every endpoint costs 0 credits yields
`minCost=0, maxCost=0` → `formatCataloguePriceRange` returns `"0 cr/call"`,
rendered as a chip alongside the separate "Free tier" badge. "0 cr/call" reads
as a data error ("why is the price zero?") rather than an intentional free API.

**Impact.** Minor copy confusion on free APIs, which are exactly the ones the
catalogue wants to highlight.

**Fix.** Special-case `minCost === 0 && maxCost === 0` to return `"Free"` (or
return `null` and let the "Free tier" badge carry it alone).

---

### [P3] Loader prefetch args (`{}`) do not match component's initial args (`{sort:"newest"}`)

**Location:** `index.tsx:42` (`convexQuery(api.catalogue.listPublic, {})`) vs
`index.tsx` `CatalogueList` initial call (`{sort, ...}` with `sort="newest"`).

**Problem.** The loader prefetches `listPublic` with an empty args object. The
component's first `useSuspenseQuery` call passes `{sort: "newest", ...}` —
different args, different `convexQuery` cache key. The backend treats undefined
`sort` and `"newest"` identically (`parseSort` defaults to `"newest"`), but
React Query's cache key is args-shaped, so the prefetched entry is never hit
and the component re-fetches on mount.

**Impact.** Wasted prefetch round-trip on every catalogue navigation; the
prefetch provides no latency benefit for the initial render.

**Fix.** Make the loader prefetch match the component's initial args exactly:
`convexQuery(api.catalogue.listPublic, { sort: "newest" })`, or have the
component call with `{}` when filters are default. The former is simpler.

---

### [P3] `sort` cast to `CatalogueSort` without validation

**Location:** `index.tsx:166` (`onValueChange={(value) => setSort(value as CatalogueSort)}`).

**Problem.** `setSort(value as CatalogueSort)` is an unchecked cast. The
`<SelectItem>` values are constrained to the three literals so this is safe
today, but it is a `as` cast that bypasses the type system if the Select ever
returns an unexpected value (e.g. an empty string on clear).

**Impact.** Latent type-safety hole; no current bug.

**Fix.** Use the existing `parseSort` pattern (or a local `isCatalogueSort`
type guard): `setSort(isCatalogueSort(value) ? value : "newest")`.

---

## Summary

**Counts:** P0: 0 · P1: 2 · P2: 9 · P3: 4 — **15 findings total.**

**Top 3 to fix first:**

1. **P1 — Stale-results race + inert "Back to browse".** Add a request token
   and an `exited` ref to the semantic `useMutation` so stale `onSuccess`
   callbacks cannot drag the user back into semantic mode, and so
   `exitSemanticMode` actually exits while pending. This is the route's primary
   interaction and it is currently unpredictable.
2. **P1 — Page-biased tag filter.** Derive the tag chip set from a
   page-independent source (dedicated `listTags` query, or fold tag aggregation
   into `listPublic`'s response) so tags on items 25+ are filterable. This is
   the root correctness defect in the browse affordance.
3. **P2 — No pagination wired.** Consume `data.nextCursor` with a "Load more"
   button or `IntersectionObserver` sentinel. Without this, the catalogue is
   hard-capped at 24 visible items, which makes #2 unsolvable in practice and
   will become a commercial defect as soon as the catalogue grows past one
   page.

**Confirmed prior-review findings:** all 7 reproduced and expanded
(stale-results race, half-wired price morph, slug collision, dead pagination,
unused `total` + double scan, "0% match" chip, hardcoded transforms).
