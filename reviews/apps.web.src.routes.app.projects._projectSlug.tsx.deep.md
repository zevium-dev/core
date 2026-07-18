# Tiger Deep Review — `apps/web/src/routes/app/projects/$projectSlug.tsx`

**Scope:** full read of `apps/web/src/routes/app/projects/$projectSlug.tsx` (655 lines) AND its settings tab component `apps/web/src/components/project-settings-panel.tsx` (640 lines). Cross-checked against `convex/projects.ts`, `convex/analytics.ts`, `convex/webhooks.ts`, `apps/web/src/components/motion/number-ticker.tsx`, `apps/web/src/components/ui/textarea.tsx`, `apps/web/src/lib/project-helpers.ts`.

**Prior review claimed:** 1 P1 + 2 P2 + 4 P3. After verification: **2 findings REFUTED, 1 finding EXPANDED into a second P1, 4 new findings surfaced.** Net: 2 P1 + 3 P2 + 7 P3.

---

## Verdict

**NEEDS CHANGES.** Two independent realtime-sync `useEffect`s silently destroy in-progress user edits — the settings-detail form and the webhook-endpoint form both clobber local state whenever the underlying Convex doc changes. That is real, reproducible data loss in a realtime-default codebase, and it is the load-bearing defect here. Everything else is polish.

---

## File Stats

| File | Lines | Locality |
|---|---|---|
| `apps/web/src/routes/app/projects/$projectSlug.tsx` | 655 | route + layout + overview + analytics |
| `apps/web/src/components/project-settings-panel.tsx` | 640 | settings tab + webhooks card |

---

## Findings

### [P1] Realtime `useEffect` in `ProjectSettingsPanel` overwrites in-progress edits → data loss
**Location:** `project-settings-panel.tsx:46-52`
```ts
// Keep local form in sync when realtime project doc changes (e.g. header visibility).
useEffect(() => {
  setName(project.name);
  setDescription(project.description ?? "");
  setTagsText(project.tags.join(", "));
}, [project.name, project.description, project.tags, project._id]);
```
**Problem:** The effect's dependency array includes `project.name`, `project.description`, and `project.tags` — the exact fields the user is editing. Any realtime mutation to those fields (collaborator in another tab, another admin, an automated spec-publish flow that rewrites tags, or even a Convex round-trip that re-emits the doc with a normalized description) fires this effect and unconditionally replaces the user's local edits with the server snapshot. There is no dirty check, no "you have unsaved changes" guard, no ref tracking whether the user has touched the field. The `_id` dependency is correct (handles project switching when the same component instance is reused across `$projectSlug` params) but the field-level deps are the data-loss vector.

The comment "e.g. header visibility" is misleading: the header visibility toggle invalidates `projects.get` but does not touch name/description/tags, so that case does NOT refire the effect — the real trigger is any external edit to the three tracked fields, which the author did not enumerate.

**Impact:** Silent loss of typed-but-unsaved work. In a multi-user org (this is an org-scoped marketplace), a second admin opening the project and saving a tag change wipes the first admin's in-flight description edit with no toast, no warning, no recovery. This is the canonical "realtime default" footgun.

**Fix:** Only sync from the server on project identity change, not on field change. Track local dirtiness and skip the sync while dirty:
```ts
const dirtyRef = useRef(false);
// mark dirty in every onChange handler
useEffect(() => {
  if (dirtyRef.current) return;          // don't clobber in-progress edits
  setName(project.name);
  setDescription(project.description ?? "");
  setTagsText(project.tags.join(", "));
}, [project._id, project.name, project.description, project.tags]);
// reset dirtyRef on successful save
```
Or gate the sync on `project._id` only and accept that a manual refresh is required to pull external edits.

---

### [P1] Realtime `useEffect` in `WebhooksCard` overwrites in-progress URL/active edits → data loss
**Location:** `project-settings-panel.tsx:153-159`
```ts
// Sync local form from the realtime endpoint doc once it loads.
useEffect(() => {
  if (endpoint !== null) {
    setUrl(endpoint.url);
    setActive(endpoint.active);
  }
}, [endpoint?._id, endpoint?.url, endpoint?.active]);
```
**Problem:** Same defect as above, scoped to the webhook endpoint. Dependencies on `endpoint?.url` and `endpoint?.active` mean any realtime change to the endpoint doc — e.g. another admin editing the URL, or a server-side rotation of the endpoint (which Convex would re-emit) — overwrites whatever the current user is typing into the URL field or toggling in the active switch.

Additionally, the guard `if (endpoint !== null)` is the only thing preventing this from firing during load. Since `endpoint = endpointQuery.data ?? null`, during the initial fetch `endpoint` is `null` and the guard correctly skips — but the moment the doc arrives, the effect fires and forces `url`/`active` to the server values regardless of whether the user has already started typing into the empty form (see P2 "missing skeleton" — the form is interactive during load, so the user CAN have local state before the effect runs).

**Impact:** Same as the settings P1 — typed URL lost without warning. Worse here because the user cannot even see that a doc is loading (see P2): the form looks ready, the user types, then the realtime sync clobbers.

**Fix:** Track dirtiness; sync only on `endpoint?._id` change (new endpoint loaded / endpoint created / endpoint deleted→recreated). Same pattern as the settings-panel fix.

---

### [P2] `WebhooksCard` shows an interactive empty "Create endpoint" form during load — layout not stable, wrong empty state
**Location:** `project-settings-panel.tsx:131-136, 156, 166, 222-226, 311-313`
```ts
const endpointQuery = useQuery(
  convexQuery(api.webhooks.getEndpoint, { projectId: project._id }),
);
const deliveriesQuery = useQuery(
  convexQuery(api.webhooks.listDeliveries, { ... }),
);
const endpoint = endpointQuery.data ?? null;
const deliveries = deliveriesQuery.data?.page ?? [];
```
**Problem:** `useQuery` (not `useSuspenseQuery`) returns `data === undefined` during the first fetch, which `?? null` collapses to `null`. The entire card then treats `endpoint === null` as "no endpoint exists":
- The signing-secret block renders "Save an endpoint to generate a signing secret." (`:311-313`)
- The deliveries section renders "Create an endpoint to start receiving deliveries." (`:227` branch via `endpoint === null`)
- The save button label becomes "Create endpoint" (`:224` branch)
- `dirty` (`:163-167`) computes `trimmedUrl.length > 0` — so if the user types a URL during load, the button enables

There is no skeleton, no `isLoading` branch, no disabled state. The user sees a fully-interactive "create" form for a project that may already have an endpoint. When the query resolves, the `useEffect` (P1) repopulates `url`/`active`, the secret field appears, the deliveries list fills — a layout-shifting flash of wrong empty state. This violates the project rule: loading = layout-stable skeletons.

**Impact:** Confusing UX flash; user can submit a "create" against an endpoint that already exists (server upserts, so no data corruption, but the toast "Webhook endpoint saved" is misleading). The deliveries count badge also shows `0` during load.

**Fix:** Use `useSuspenseQuery` (wrap `WebhooksCard` body in `<Suspense fallback={<WebhooksSkeleton/>}>`), or branch on `endpointQuery.isLoading` / `endpoint === undefined` (not null-collapsed) to render a `Skeleton` matching the card's eventual layout. Distinguish "loading" from "no endpoint" explicitly.

---

### [P2] Analytics bar chart animates `height` with no `prefers-reduced-motion` guard
**Location:** `$projectSlug.tsx:478-481`
```tsx
<div
  className="w-full rounded-sm bg-primary/80 transition-[height] duration-[var(--dur-fast)] ease-[var(--ease)]"
  style={{ height: `${heightPct}%` }}
/>
```
**Problem:** The CSS `transition-[height]` runs on every value change (day rollover refetch, tab re-entry, window refocus refetch) with no `motion-safe:` / `motion-reduce:` variant and no JS guard. The project rule is explicit: all animation from `src/lib/motion.ts` / CSS vars AND `prefers-reduced-motion` respected. The sibling `NumberTicker` component correctly calls `prefersReducedMotion()` and short-circuits; this bar chart does not.

**Impact:** Vestibular discomfort for motion-sensitive users on every analytics refetch.

**Fix:** Add `motion-safe:transition-[height] motion-safe:duration-[var(--dur-fast)] motion-safe:ease-[var(--ease)]` and drop the unconditional transition classes, or gate via the `DUR`/`ease` CSS vars behind a `motion-reduce:hidden` variant on the transition.

---

### [P2] `dirty` treats loading as "no endpoint", enabling misleading submit state during the load window
**Location:** `project-settings-panel.tsx:162-167`
```ts
const dirty =
  endpoint === null
    ? trimmedUrl.length > 0
    : trimmedUrl !== endpoint.url || active !== endpoint.active;
```
**Problem:** Directly downstream of P2 (missing skeleton). During load `endpoint === null`, so `dirty = trimmedUrl.length > 0`. If the user types a URL in that window, `dirty` becomes true, the submit button enables, and the user can fire `upsertEndpoint` against a project whose real endpoint state is unknown. If an endpoint actually exists server-side, the upsert still succeeds (it is idempotent by `projectId`) but the user believed they were creating a new endpoint.

**Impact:** Misleading affordance; can trigger a surprise secret rotation if the server's `upsertEndpoint` regenerates the secret on URL change (verify in `convex/webhooks.ts:upsertEndpoint` — it currently only generates a secret on insert, not on update, so no secret rotation here, but the UX is still wrong).

**Fix:** Resolved implicitly by fixing P2 (don't render an interactive form during load).

---

### [P3] Raw `<textarea>` reinvents stock shadcn `Textarea` component
**Location:** `project-settings-panel.tsx:204-213`
```tsx
<textarea
  id="settings-description"
  value={description}
  onChange={(e) => setDescription(e.target.value)}
  maxLength={2000}
  disabled={savePending}
  rows={4}
  className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
/>
```
**Problem:** The repo ships `apps/web/src/components/ui/textarea.tsx` — a stock shadcn `Textarea` using `React.ComponentProps<"textarea">` with `field-sizing-content`, `min-h-16`, `aria-invalid` variants, dark-mode `bg-input/30`, and `data-slot="textarea"`. The hand-rolled version here duplicates ~80% of that class string, drops `field-sizing-content` (so the textarea won't auto-grow with content — worse UX), drops `aria-invalid` support, drops the dark-mode bg, and uses `min-h-24` instead of the stock `min-h-16`. Project rule: stock shadcn unmodified.

**Impact:** Drift from the design system; the description field behaves differently from every other textarea in the app; accessibility (aria-invalid) unavailable when validation lands.

**Fix:** `import { Textarea } from "#/components/ui/textarea";` and `<Textarea id="settings-description" value={description} onChange={...} maxLength={2000} disabled={savePending} rows={4} />`. Drop the inline className.

---

### [P3] `copySecret` `setTimeout(1500)` — no unmount cleanup, no clear-on-reclick
**Location:** `project-settings-panel.tsx:184-192`
```ts
async function copySecret() {
  if (!endpoint?.secret) return;
  try {
    await navigator.clipboard.writeText(endpoint.secret);
    setCopiedSecret(true);
    setTimeout(() => setCopiedSecret(false), 1500);
  } catch {
    toast.error("Could not copy secret");
  }
}
```
**Problem:** The 1500ms reset timer is not stored in a ref, so (a) if the component unmounts before 1500ms elapses, `setCopiedSecret` fires on an unmounted component (React 18 no longer warns, but it is a state-after-unmount smell and a latent bug if the function closure captures stale data), and (b) if the user clicks Copy twice in quick succession, the first timer still fires 1500ms after the FIRST click, resetting the checkmark even though the second copy just happened — the checkmark flickers off prematurely. The 1500ms constant is also hardcoded rather than sourced from `src/lib/motion.ts` (project rule: animation timing from motion lib / CSS vars).

**Impact:** Minor UX jank on double-click; latent unmount bug.

**Fix:** Store the timer in a `useRef<number | null>`, clear it before setting a new one, and clear it in a `useEffect` cleanup on unmount. Or better, lift the "copied" affordance into a small `useCopied(timeoutMs)` hook since this pattern repeats.

---

### [P3] `formatMs(0)` returns `"0.0ms"` — inconsistent decimal formatting at the sub-10ms boundary
**Location:** `$projectSlug.tsx:413-416`
```ts
function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}
```
**Problem:** For `ms === 0` the function returns `"0.0ms"` (one decimal); for `ms === 10` it returns `"10ms"` (no decimal). There is a discontinuity at 10ms: `9.9ms` → `"9.9ms"`, `10ms` → `"10ms"`. Zero is a whole number but is shown with a decimal, which reads as a placeholder/edge value. Note: the no-traffic case is NOT affected here — `convex/analytics.ts:percentile` returns `null` for an empty `allLatencies` array (`analytics.ts:99-101`), so a no-traffic project shows `"—"` for p50/p95/p99, consistent with the success-rate card's `"—"` guard. The `0` only surfaces if a real `event.latencyMs === 0` is recorded (sub-millisecond rounded down), which is an edge case.

**Impact:** Cosmetic. Reads oddly when a percentile genuinely resolves to 0.

**Fix:** Either `if (ms === 0) return "0ms";` or drop the decimal branch and use `Math.round` uniformly with a `< 10` floor of `"<10ms"`. Pick one and document the threshold.

---

### [P3] Bar chart renders a 4%-height bar for zero-count days — misleading traffic signal
**Location:** `$projectSlug.tsx:475-477`
```ts
const heightPct = Math.max(4, (count / maxDay) * 100);
```
**Problem:** For days with zero calls, the bar still renders at 4% height. A 7-day window with calls only on day 3 shows six tiny bars that look like low traffic rather than zero traffic. The `title` attribute says "0 calls" but the visual lies.

**Impact:** Misleading at-a-glance chart; user misreads dead days as low-traffic days.

**Fix:** `const heightPct = count === 0 ? 0 : Math.max(4, (count / maxDay) * 100);` and either skip rendering the bar or render a 1px baseline.

---

### [P3] `head` meta title uses `params.projectSlug` (slug), not the project name
**Location:** `$projectSlug.tsx:65-67`
```ts
head: ({ params }) => ({
  meta: [{ title: `${params.projectSlug} · Projects · Zevium` }],
}),
```
**Problem:** The browser tab / bookmark shows the URL slug (e.g. `my-payments-api`) rather than the human-readable project name (e.g. `Payments API`). The loader does not await the project on client nav (fire-and-forget prefetch), so the name is not available in `head` without making the loader blocking — but on SSR it IS available via `ensureQueryData` and could be used.

**Impact:** Tab titles are less recognizable than they could be.

**Fix:** Await the project in the loader (it already does on SSR), pass the name into `head` via the loader context, and fall back to the slug if the project is missing.

---

### [P3] Duplicate `useConvexMutation(api.projects.update)` + duplicate visibility Dialog between route header and settings panel
**Location:** `$projectSlug.tsx:109-137` (header `setVisibility` + Dialog at `:191-225`) AND `project-settings-panel.tsx:101-130` (panel `setVisibility` + Dialog at `:288-322`).

**Problem:** Both the route's `ProjectShell` and the `ProjectSettingsPanel` mount their own `useConvexMutation(api.projects.update)` instance, their own `useMutation` for visibility, their own `visibilityOpen` state, and a near-identical `<Dialog>` with the same trigger label, same description copy, same toast strings, same invalidation. When the settings tab is active, both hook instances are live and both invalidate `projects.get` + `projects.list` on success (redundant double-invalidation per visibility toggle).

**Impact:** Dead code, drift risk (the two copies have already diverged slightly — the header version checks `if (!project) throw` defensively while the panel version does not), and double invalidation.

**Fix:** Delete the visibility Dialog from the route header entirely — the settings panel already owns it. Or extract a shared `<VisibilityToggle project />` component used in exactly one place.

---

### [P3] `analytics.callsByDay` bars use index keys + no day labels; `rangeDays: 7` hardcoded
**Location:** `$projectSlug.tsx:470-485` and `:453` (`rangeDays: 7`)
```tsx
{analytics.callsByDay.map((count, i) => {
  ...
  return (
    <div key={i} ...>
      <div ... title={`${count} calls`} ... />
    </div>
  );
})}
```
**Problem:** (a) `key={i}` — index keys are acceptable for a stable 7-element list, but if `rangeDays` ever becomes variable (the server supports up to 90, `analytics.ts:240-243`), React will mis-diff on length change. (b) No x-axis labels (day-of-week or date) — the bars float with only a `title` tooltip on hover, so the user cannot tell which day a bar represents without hovering. (c) `rangeDays: 7` is hardcoded with no UI to change the window, despite the backend supporting 1-90.

**Impact:** Reduced chart legibility; latent key bug if range becomes dynamic.

**Fix:** Use a stable key derived from the day's start timestamp (available from `analytics.rangeStart + i * 86_400_000`); render a minimal x-axis label under each bar (e.g. day initials); consider a range selector (7/30/90) since the server already accepts it.

---

## Refuted prior findings (verified false)

### REFUTED — "NumberTicker credits unformatted"
`apps/web/src/components/motion/number-ticker.tsx:18-22` defines `defaultFormat` as `n.toLocaleString(undefined, { maximumFractionDigits, minimumFractionDigits })`, and `NumberTicker` calls it when no `format` prop is passed (`:84-85`). The analytics cards render `<NumberTicker value={analytics.credits} />` with `decimals` defaulting to `0`, so credits ARE locale-grouped (e.g. `12,345`). The prior finding is incorrect. If the intent was "credits should be shown as USD via `formatCreditsAsUsd`", that is a product decision, not a formatting bug — the card label is "Credits earned", so showing the credit count is correct.

### REFUTED — "Type-unsafe optimistic update"
`project-settings-panel.tsx:104-108`:
```ts
description: patch.description ?? undefined,
```
`patch.description` is typed `string | null` (mutationFn signature, `:95-99`). The Convex `projects` schema declares `description` as `v.optional(v.string())` (`convex/projects.ts:39`), so `Doc<"projects">["description"]` is `string | undefined`. The server-side `update` handler explicitly maps `null` → `undefined` (`convex/projects.ts:137-148`). The cache write `patch.description ?? undefined` therefore correctly mirrors the server's null-to-undefined conversion: `null → undefined`, `string → string`. This is type-correct and behaviorally correct. No issue.

---

## Summary

**Counts:** P0: 0 · P1: 2 · P2: 3 · P3: 7 · **Refuted: 2**

**Top 3:**
1. **[P1]** `ProjectSettingsPanel` realtime `useEffect` clobbers in-progress name/description/tags edits on any external doc change — silent data loss in a multi-user org.
2. **[P1]** `WebhooksCard` realtime `useEffect` clobbers in-progress URL/active edits on any external endpoint doc change — same defect, second surface.
3. **[P2]** `WebhooksCard` uses `useQuery` with no loading state, so the entire card renders an interactive "Create endpoint" empty form during the initial fetch — layout-unstable, wrong empty state, enables premature submit.

**Theme:** Both P1s are the same bug class — "sync local form from realtime doc on every field change" — and admit the same fix (sync on identity change only, gate on a dirty ref). The codebase is realtime-default by project rule, so every form-over-a-Convex-doc needs this treatment, not just these two. The rest is design-system drift (raw textarea), motion-policy drift (bar chart no reduced-motion guard), and polish.
