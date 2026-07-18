# Tiger Deep Review — `apps/web/src/routes/app/projects/create.tsx`

Scope: `create.tsx` (202 LOC, single `CreateProjectPage` route) + `convex/projects.ts` `create` mutation (lines 34–97) for backend contract verification.

## Verdict

**BLOCKERS: 0.** No data-loss-at-rest, no auth bypass, no leaked raw errors. The `humanError` + `isPending` + `slugify` guards correctly defuse the obvious failure modes.

**But the file is riddled with small correctness/UX/convention defects.** The combination of an *ineffectively disabled* Cancel link (#1) and an *unconditional* `onSuccess` navigation (#4) produces a genuine race: a user who bails mid-mutation gets yanked back to the project they just tried to abandon. Layered on top: blank-page load (#2), no unsaved-changes guard (#3), and four convention violations the sibling `org/create.tsx` already solved. This route is below the bar set by its neighbors.

## File Stats

- LOC: 202
- Imports: 11 (React, Clerk, Convex, TanStack, UI, lib)
- State hooks: 4 (`name`, `slug`, `slugEdited`, `description`)
- Mutations: 1 (`useConvexMutation(api.projects.create)` wrapped in `useMutation`)
- Forms: 1 (4 fields: name, slug, description, implicit submit)
- Animations: 0 (siblings use `FadeIn`)
- Skeletons: 0 (siblings use `Skeleton` + `pendingComponent`)

## Findings

### [SEV: P2] #1 — Cancel link is NOT actually disabled during pending; `<a disabled>` is non-standard HTML

**Location:** `create.tsx:184-193`

```tsx
<Button
  asChild
  variant="ghost"
  type="button"
  disabled={isPending}
>
  <Link to="/app/projects">Cancel</Link>
</Button>
```

**Problem:** `Button asChild` renders `Slot.Root`, which merges `disabled` onto the child `<Link>` → `<a disabled>`. Per HTML spec, the `disabled` attribute has **no effect on `<a>` elements** — the link remains fully navigable. Tailwind's `disabled:` variant compiles to the `:disabled` *pseudo-class*, which only matches disabled *form controls* (button/input/select/textarea), **not** arbitrary elements carrying a `disabled` attribute — so even `disabled:pointer-events-none` / `disabled:opacity-50` from `buttonVariants` fail to apply. The Cancel link is therefore clickable for the entire duration of `isPending`.

**Impact:** A user can navigate to `/app/projects` while the create mutation is still in flight. This is the precondition for finding #4 (the success-redirect race). It also defeats the visual contract the code pretends to have: `disabled={isPending}` reads as a guard but enforces nothing.

**Fix:** Either (a) drop `asChild` and render a real `<button type="button" disabled={isPending} onClick={() => navigate({ to: "/app/projects" })}>Cancel</button>`, or (b) gate the link's `onClick` (`if (isPending) return;`) AND swap to `pointer-events-none opacity-50` via a conditional class so the disable is visible + enforced. Prefer (a) for a real disabled state.

---

### [SEV: P2] #2 — `if (!isLoaded) return null` renders a blank page; sibling route ships a `pendingComponent` skeleton

**Location:** `create.tsx:71-73`

```tsx
if (!isLoaded) {
  return null;
}
```

**Problem:** While Clerk's `useOrganization()` resolves, the route returns `null` — the user sees an empty viewport with no signal that anything is loading. The sibling route `apps/web/src/routes/app/org/create.tsx` demonstrates the correct pattern for the *exact same* "New X" UX: it declares `pendingComponent: CreateOrgSkeleton` and renders a `<Skeleton>` shaped like the heading + form card. The project-memory rule "loading = layout-stable skeletons" is violated.

**Impact:** Layout flash from blank → full form; perceived perf hit; accessibility regression (screen-reader users hear nothing during load). Inconsistent with `org/create.tsx` for no reason.

**Fix:** Add a `pendingComponent` (or `loader`-driven pending state) that renders a skeleton mirroring the Card structure: heading `Skeleton h-8 w-56`, two `Input`-shaped `Skeleton h-9 w-full`, one `Skeleton h-24 w-full`, two button `Skeleton`s. Match the layout-stable-skeleton rule.

---

### [SEV: P2] #3 — No unsaved-changes guard; typing then Cancel / browser-back silently discards input

**Location:** entire component — no `useBlocker`, no `beforeunload` listener.

**Problem:** A user types a name, slug, and 800-char description, then clicks Cancel (#1, fully clickable), the sidebar, the browser back button, or hits Cmd+W... and loses everything. `useBlocker` from `@tanstack/react-router` exists for exactly this; the codebase does not use it anywhere (grep for `useBlocker`/`beforeunload` → no matches), but that does not excuse the route most likely to lose user typing.

**Impact:** Data loss of non-trivial user input. The longer the description, the worse the loss.

**Fix:** Track a `dirty` flag (set true on any field change). Use `useBlocker({ shouldBlockFn: () => dirty && !isPending })` to confirm before client-side navigation. For pending-state navigation (Cancel), suppress the blocker since the mutation is in flight — but per #1, Cancel should be disabled during pending anyway. Keep the blocker scoped to non-pending dirty state.

---

### [SEV: P2] #4 — `onSuccess: void navigate(...)` runs unconditionally and races user-initiated navigation

**Location:** `create.tsx:39-44`

```tsx
onSuccess: (project) => {
  toast.success("Project created");
  void navigate({
    to: "/app/projects/$projectSlug",
    params: { projectSlug: project.slug },
  });
},
```

**Problem:** If the user navigates away during the in-flight Convex mutation (made possible by #1, but also by the sidebar / browser back), the component unmounts but `useMutation` keeps its `onSuccess` callback. When the mutation resolves, `onSuccess` fires `void navigate(...)` and yanks the user from wherever they went back to the newly-created project detail page — overriding their explicit navigation. There is no `isMounted` check, no abort, no "still on this page?" gate.

**Impact:** Confusing, non-idempotent UX: user clicks Cancel → lands on `/app/projects` → suddenly gets redirected to `/app/projects/weather-api`. Hard to reproduce, easy to dismiss as "the app is haunted." Also violates the principle that user-initiated navigation should win over async side effects.

**Fix:** Gate the redirect on still being mounted (`useEffect` cleanup → `mountedRef.current = false`), OR (better) cancel the mutation on unmount (`useMutation`'s `onMutate` + `AbortController`), OR simply check `isPending`-aware: skip `navigate` if the route is no longer active. The simplest correct fix: capture a `mountedRef`, set false in `useEffect` cleanup, and `if (!mountedRef.current) return;` at the top of `onSuccess`.

---

### [SEV: P3] #5 — No-org branch renders outside the `max-w-lg` container; width jumps if org state resolves late

**Location:** `create.tsx:77-91`

```tsx
if (!orgSlug) {
  return (
    <div className="flex flex-col gap-6">
      ...
    </div>
  );
}
```

**Problem:** The primary render wraps in `<div className="mx-auto flex w-full max-w-lg flex-col gap-6">`, but the no-org fallback omits `mx-auto max-w-lg`. If `useOrganization` resolves to "no org" after the initial paint, the content snaps from centered/narrow to full-width/left-aligned.

**Impact:** Minor layout shift, inconsistent with the main branch. Also: the no-org panel only offers "Back to projects" — it dead-ends a user who needs to *create* an org (no link to `/app/org/create`, which exists).

**Fix:** Wrap both branches in the same `mx-auto max-w-lg` container, or extract a shared layout. Add a "Create organization" CTA linking to `/app/org/create`.

---

### [SEV: P3] #6 — Raw `<textarea>` with hand-rolled className duplicates the stock `Textarea` component

**Location:** `create.tsx:124-140`

```tsx
<textarea
  ...
  className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
/>
```

**Problem:** `apps/web/src/components/ui/textarea.tsx` (line 5-17) already exports a `Textarea` that renders exactly this className and adds `data-slot="textarea"`. Hand-replicating it here (a) drifts when the stock component evolves, (b) skips the `data-slot` attribute that other tooling/tests may rely on, (c) violates the "stock shadcn unmodified" UI rule by inlining a duplicate.

**Impact:** Maintenance hazard; one of two copies will rot.

**Fix:** `import { Textarea } from "#/components/ui/textarea"` and replace the raw element.

---

### [SEV: P3] #7 — Missing `FadeIn` enter animation; inconsistent with every sibling route

**Location:** entire return — no motion import, no `FadeIn`.

**Problem:** `app/org/create.tsx`, `app/org/index.tsx`, `app/projects/index.tsx`, `catalogue/index.tsx` all wrap their content in `<FadeIn className="flex flex-col gap-6">`. This route does not. The project-memory rule "all animation from `src/lib/motion.ts` / CSS vars" and the sibling convention both expect a `FadeIn` enter.

**Impact:** Inconsistent feel — the page snaps in where siblings ease in. No `prefers-reduced-motion` concern (FadeIn handles it).

**Fix:** Wrap the outer `<div>` in `<FadeIn className="mx-auto flex w-full max-w-lg flex-col gap-6">`. Same for the no-org branch.

---

### [SEV: P3] #8 — Missing create→detail view-transition morph; nav pops instead of morphing

**Location:** `onSuccess` navigate call (line 41-44); no `viewTransitionName` on any element.

**Problem:** Project-memory rule: "every list→detail nav ships view-transition morph or written reason." The create flow ends in `navigate({ to: "/app/projects/$projectSlug" })` — a pure route swap with no shared element. The Card / heading has no `style={{ viewTransitionName: ... }}` to morph into the detail page's heading. The codebase already uses `viewTransitionName` on `app.tsx` (`"main-content"`), `index.tsx` (`"catalogue-heading"`), and `app/index.tsx` (`"credit-balance"`), so the pattern is established. No written reason for omission exists in comments.

**Impact:** The transition feels cheaper than the rest of the app. Not a regression, but a missed expectation set by the routing rules.

**Fix:** Either add a `viewTransitionName: "project-card"` (or similar) to the Card and a matching name on the detail page's heading, OR add a comment `// no morph: create form has no analogue on the detail page` documenting the decision. Prefer the former if the detail page has a heading that can accept the shared name.

---

### [SEV: P3] #9 — Form lacks `aria-busy` during pending; submit button text is the only pending signal

**Location:** `create.tsx:115` (`<form ... onSubmit={onSubmit}>`) and `create.tsx:194` (`<Button type="submit" disabled={isPending}>`)

**Problem:** During `isPending`, the only a11y signal is the button label change to "Creating…". The form, the Card, and the inputs get `disabled` but no `aria-busy="true"` is set on the container, so assistive tech has no programmatic "submit in progress" state.

**Impact:** Screen-reader users get no aggregated pending state; they must infer it from the button label.

**Fix:** Add `aria-busy={isPending}` to the `<form>` (or the Card). Cheap, correct, and matches the disabled visuals.

---

## Summary

| Severity | Count |
|----------|-------|
| P0       | 0     |
| P1       | 0     |
| P2       | 4     |
| P3       | 5     |
| **Total**| **9** |

**Top 3 to fix first:**

1. **#1 + #4 (Cancel-not-disabled + unconditional `onSuccess` navigate).** These two compose into a real correctness race. Fix together: disable Cancel properly (real `<button>`) *and* gate the success-navigation on still-mounted state. Either alone leaves the race half-open.
2. **#2 (blank `return null` during Clerk load).** Copy the `pendingComponent` + `Skeleton` pattern from `org/create.tsx` verbatim — it already exists for this exact page shape.
3. **#3 (no unsaved-changes guard).** A description field with `maxLength={2000}` is the kind of input users will rage-quit over. Add `useBlocker` before any more routes copy this omission as precedent.

**Non-findings (explicitly verified safe):**
- **Double-submit:** guarded by both `if (!orgSlug || isPending) return;` in `onSubmit` (line 56) AND `disabled={isPending}` on the real `<button type="submit">` (line 194). Native button disable + closure guard is sufficient; rapid Enter presses each trigger a re-render before the next handler runs.
- **`isPending` misuse:** correct v5 usage; no `isLoading`.
- **Leaked errors:** `onError` routes through `humanError(err, "Could not create project")` — no raw `err.message` leak.
- **Raw Tailwind colors:** none — all classes are semantic tokens (`bg-transparent`, `border-input`, `text-muted-foreground`, `ring-ring`, etc.).
- **Hardcoded motion values:** N/A — no motion present (the problem is *missing* motion, #7).
- **Dead code:** none observed.
- **Client-side slug validation:** effectively enforced via `slugify` (strips to `[a-z0-9-]`, trims, ≤64 chars), matching `isValidSlug` in `@zevium/shared`. Backend re-validates. No gap.
- **Field length limits:** name 120, slug 64, description 2000 all match the backend `create` handler in `convex/projects.ts:41-60`.
