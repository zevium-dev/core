# Tiger Review — `apps/web/src/routes/catalogue/index.tsx`

## Verdict

**Incorrect.** One real correctness/UX race (P1) plus two broken view-transition wirings (P2) and a missing-pagination gap (P2). No XSS (all spec-derived strings render as React children, never `dangerouslySetInnerHTML`), no raw Tailwind colors (all classes are semantic tokens), no missing skeletons (`CatalogueSkeleton`, `CatalogueGridSkeleton`, and the in-panel `SemanticResults` pending skeleton are all present and layout-stable). `isPending` is used correctly throughout (never `isLoading`).

## File Stats

- File: `apps/web/src/routes/catalogue/index.tsx` (593 lines)
- Sibling libs reviewed: `apps/web/src/lib/catalogue-card.ts`, `apps/web/src/lib/catalogue-search.ts`
- Backend reviewed for contract fidelity: `convex/catalogue.ts` (`listPublic`, `getPublicDetail`), `convex/search.ts` (`searchCatalogue`, `fetchSearchListings`)
- Detail route cross-checked for view-transition morph targets: `apps/web/src/routes/catalogue/$orgSlug.$projectSlug.tsx`
- Findings: 7 (P0: 0 · P1: 1 · P2: 3 · P3: 3)

## Findings

---

### [P1] Stale semantic-search result overwrites UI after user exits semantic mode

**Location** — `CataloguePage` mutation wiring, lines ~62–72 and `inSemanticMode` derivation line ~74:

```ts
const { mutate: runSemanticSearch, isPending: semanticPending } = useMutation({
  mutationFn: (query: string) => runSemanticAction({ query, limit: 20 }),
  onSuccess: (res) => {
    setSemanticItems(res.degraded ? null : res.items);
  },
  onError: () => setSemanticItems(null),
});

const inSemanticMode = semanticItems !== null || semanticPending;
```

**Problem.** `onSuccess` unconditionally commits `res.items` to state, and `inSemanticMode` is OR-ed with `semanticPending`. Two race paths:

1. User submits a semantic search (`semanticPending = true` → `inSemanticMode = true`, skeleton shown). While the Gemini action is still in flight, the user clicks **"Back to browse"** (`exitSemanticMode` → `setSemanticItems(null)`). But `semanticPending` is still `true`, so `inSemanticMode` stays `true` and the click has **zero visible effect** — the user is trapped on the skeleton. When the late action resolves, `onSuccess` sets `semanticItems` to the now-stale ranking, snapping the user back into `SemanticResults` despite having explicitly left it.
2. Same trap if the user edits the search input while pending: `handleSearchInput` calls `setSemanticItems(null)`, but `semanticPending` keeps `inSemanticMode = true` and the late `onSuccess` drags them back into semantic mode.

There is no request-token / latest-wins guard, and `useMutation` does not cancel the in-flight Convex action (Convex actions aren't client-cancelable). The submit button is disabled while pending, but the "Back to browse" button and the text input are not, so both race paths are live.

**Impact.** A slow semantic search makes the "Back to browse" control appear broken and then forcibly re-enters semantic mode with stale results. This is the canonical "late return overwrites new" race.

**Fix.** Track the latest request and ignore stale resolutions; also clear pending intent on exit:

```ts
const semanticReqId = useRef(0);

const { mutate: runSemanticSearch, isPending: semanticPending } = useMutation({
  mutationFn: (query: string) => {
    const id = ++semanticReqId.current;
    return runSemanticAction({ query, limit: 20 }).then((res) => ({ id, res }));
  },
  onSuccess: ({ id, res }) => {
    if (id !== semanticReqId.current) return; // stale — user moved on
    setSemanticItems(res.degraded ? null : res.items);
  },
  onError: () => setSemanticItems(null),
});

const exitSemanticMode = () => {
  semanticReqId.current++; // invalidate any in-flight resolution
  setSemanticItems(null);
};
```

`handleSearchInput` should also bump `semanticReqId.current` before nulling `semanticItems`.

---

### [P2] `api-price-${item.slug}` view-transition name has no matching target on the detail route

**Location** — `CatalogueCard` price badge, lines ~490–493:

```tsx
<Badge variant="outline" className="font-mono"
  style={{ viewTransitionName: `api-price-${item.slug}` }}>
  {priceLabel}
</Badge>
```

**Problem.** The card assigns `viewTransitionName: api-price-<slug>` to its price badge, but the detail route `apps/web/src/routes/catalogue/$orgSlug.$projectSlug.tsx` only sets `api-title-${data.project.slug}` on the `<h1>` (line 266). The detail page renders its price inline as `{priceRange}` inside a plain `<span>` with no `viewTransitionName`. The View Transition API pairs elements by name across the old/new snapshots; with a source name and no destination name, the price "morph" is one-sided — it fades out from the card with no target to morph into, producing a broken/half animation rather than the list→detail morph the project rule requires ("every list→detail nav ships view-transition morph or written reason").

**Impact.** Card→detail navigation animates the title cleanly but the price chip either vanishes abruptly or triggers a console warning depending on UA. Users see an inconsistent transition.

**Fix.** Either give the detail-route price `<span>` a matching `viewTransitionName: api-price-${data.project.slug}`, or drop the name from the card and document the reason (title-only morph is the deliberate choice).

---

### [P2] Duplicate `viewTransitionName` when two orgs publish the same project slug

**Location** — `CatalogueCard` title (line 454) and price badge (line 491):

```tsx
style={{ viewTransitionName: `api-title-${item.slug}` }}
...
style={{ viewTransitionName: `api-price-${item.slug}` }}
```

**Problem.** Project slugs are scoped per-org — the route is `/catalogue/$orgSlug/$projectSlug`, and `listPublic` returns `orgSlug` alongside `slug` precisely because `slug` is not globally unique. The view-transition names use only `item.slug`, so if org A and org B both publish a project with slug `stripe` (or `payments`, or `users`), the catalogue grid renders two cards in the same DOM snapshot with **identical** `view-transition-name` values. The View Transition API requires names to be unique within a snapshot; duplicates cause the UA to drop the transition for all but one element and emit a console warning. The same collision flows into the detail route's `api-title-${data.project.slug}` when navigating, but at least there only one element is rendered at a time.

**Impact.** On any catalogue containing name-colliding slugs across orgs (a realistic, supported configuration), the card→detail morph silently degrades/breaks for the colliding cards.

**Fix.** Namespace by org:

```tsx
style={{ viewTransitionName: `api-title-${item.orgSlug}-${item.slug}` }}
...
style={{ viewTransitionName: `api-price-${item.orgSlug}-${item.slug}` }}
```

…and mirror the same namespaced form on the detail route (`$orgSlug.$projectSlug.tsx` line 266) so source and target match.

---

### [P2] No pagination wired — `nextCursor` is dead, catalogue is silently capped at 24 items

**Location** — `CatalogueList` query consumer, lines ~359–366:

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

**Problem.** `listPublic` (`convex/catalogue.ts`) is cursor-paginated: it accepts a `cursor` (offset string), slices `filtered.slice(start, start + PAGE_SIZE)` with `PAGE_SIZE = 24`, and returns `{ items, nextCursor, total }`. The route destructures only `data` and reads only `data.items`; `data.nextCursor` is never consumed and no "Load more" / infinite-scroll / `usePaginatedQuery` is wired. The `args.cursor` input is never supplied by the client. Result: as the catalogue grows past 24 published APIs, everything beyond the first page is invisible to users with no indication it exists — the empty state never appears either (the first page is full), so users simply see a truncated list.

**Impact.** Silent data loss in the primary browse surface once the catalogue exceeds one page; `nextCursor` and the entire cursor branch of the backend are dead code from this consumer's perspective.

**Fix.** Either consume `nextCursor` via a "Load more" button or `usePaginatedQuery`/convex paginationOpts, or — if pagination is intentionally deferred — surface the total count (`data.total`) as "Showing 24 of N" so truncation is visible, and remove the unused `nextCursor` from the consumed contract until wired.

---

### [P3] `total` field returned by `listPublic` is unused in this route

**Location** — `CatalogueList` consumes only `data.items`; `data.total` is never read (grep of `apps/web/src` confirms `listPublic` callers read `.items` only; the landing `routes/index.tsx` likewise uses `catalogueQuery.data?.items`).

**Problem.** The backend computes `total` by issuing a second `.take(1000)` scan of `by_visibility_status` (lines ~120–127 of `convex/catalogue.ts`) on **every** `listPublic` call — including this route's filtered browse queries and every debounce-triggered refetch. That second full scan is pure overhead for a value the catalogue page never displays.

**Impact.** Wasted Convex read budget per catalogue query; the field is dead in this consumer.

**Fix.** Either render `data.total` (e.g. in the "Showing X of N" affordance from the P2 above) so the second scan earns its cost, or drop `total` from `listPublic` and compute it in a dedicated lightweight stat query only where it's actually shown.

---

### [P3] Relevance chip renders "0% match" for genuine semantic hits

**Location** — `CatalogueCard` relevance derivation, lines ~433–434, plus `fetchSearchListings` score default `convex/search.ts` line ~343 (`score: args.scores[i] ?? 0`):

```tsx
const relevance =
  item.score === undefined ? null : formatRelevance(item.score);
```

```ts
// convex/search.ts
score: args.scores[i] ?? 0,
```

**Problem.** `formatRelevance` clamps any score (including 0 and negatives) to a non-`null` `"0% match"` string, and the card renders the chip whenever `item.score !== undefined`. For a semantic hit whose cosine similarity is 0 (orthogonal embedding — rare but possible) or whose score defaulted to 0 via `?? 0` (defensive fallback), the card prominently shows "0% match" on a result that **did** match the query (vectorSearch returned it). That label is misleading — it reads as "no match" while the card is present precisely because it matched.

**Impact.** Confusing/misleading UX on edge-case semantic results; "0% match" attached to a surfaced hit undermines trust in the relevance signal.

**Fix.** Suppress the chip below a small threshold, or treat 0 as "no score":

```tsx
const relevance =
  item.score === undefined || item.score <= 0
    ? null
    : formatRelevance(item.score);
```

---

### [P3] Hardcoded hover/press transform values bypass `motion.ts`

**Location** — `CatalogueCard` `<Card>` className, line ~447:

```tsx
className="... group-hover:-translate-y-0.5 group-hover:shadow-sm group-active:scale-[0.98]"
```

**Problem.** The project motion rule states "all animation from `src/lib/motion.ts` / CSS vars." `motion.ts` defines `EASE`, `DUR`, and `DIST = 16` (px translate for enters) as the single source of truth, and the card already correctly sources timing/easing via `duration-[var(--dur-instant)] ease-[var(--ease)]`. But the hover lift `-translate-y-0.5` (2px) and press `scale-[0.98]` are arbitrary literal transforms not present in or derived from `motion.ts` — they introduce a second, ad-hoc motion vocabulary alongside the sanctioned one. The `2px` lift doesn't match `DIST` and the `0.98` scale has no token.

**Impact.** Motion values drift from the single-source design system; future cards/components reinvent their own lift amounts. Cosmetic/correctness is fine.

**Fix.** Add a hover-lift token (e.g. `LIFT = 2` in `motion.ts`, or a `--lift` CSS var) and reference it, or move the hover/press feedback into a shared `motion.ts`-driven variant so the literals live in one place.

---

## Summary

- **7 findings** — P0: 0 · P1: 1 · P2: 3 · P3: 3
- **Top 3:**
  1. **[P1] Stale semantic results race** — `onSuccess` commits unconditionally and `inSemanticMode` ORs `semanticPending`, so a slow semantic search traps the user on the skeleton and then drags them back into semantic mode after they've clicked "Back to browse" or edited the query. Needs a request-token guard.
  2. **[P2] `api-price-` view-transition name is half-wired** — the card sets it but the detail route never sets a matching target, so the price morph is one-sided/broken.
  3. **[P2] No pagination wired** — `nextCursor` is dead and the catalogue silently caps at 24 items with no "Load more" or total-count affordance.

**Notable absences (explicitly checked, not bugs):** no XSS (all spec-derived strings render as React children), no raw Tailwind colors (every color class is a semantic token — `bg-background`, `text-muted-foreground`, `border-primary`, `bg-accent`, etc.), no missing skeletons (`CatalogueSkeleton` route pending component, `CatalogueGridSkeleton` Suspense fallback, and `SemanticResults` pending skeleton all present and layout-stable), correct `isPending` usage throughout, errors not leaked (`onError` silently resets to browse mode rather than surfacing internal details).
