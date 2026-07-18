# Tiger Review — `apps/web/src/routes/app/projects/create.tsx` + `apps/web/src/routes/app/org/create.tsx`

Scope: project + organization **create flows**. Read alongside `convex/projects.ts`
and `convex/organizations.ts` for backend contract verification. No working-tree diff
(clean tree) — review targets HEAD state of both files.

## Verdict

**incorrect** — two real UX defects (Cancel link not disabled during pending; blank
`return null` instead of a skeleton) plus several inconsistencies with the codebase's
own loading/motion/component conventions. The org create route is clean (delegates to
Clerk `CreateOrganization` with a proper skeleton + `FadeIn`); nearly all findings are
on the project create route.

## File Stats

| File | Lines | Findings |
|---|---|---|
| `apps/web/src/routes/app/projects/create.tsx` | 198 | 6 |
| `apps/web/src/routes/app/org/create.tsx` | 56 | 0 |
| `convex/projects.ts` (cross-check) | 173 | 0 |
| `convex/organizations.ts` (cross-check) | 175 | 0 |

## Findings

---

### [P2] Cancel link stays clickable during pending — `Button asChild` + `disabled` is a no-op on `<a>`

**Location:** `apps/web/src/routes/app/projects/create.tsx:184-191`

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

**Problem:** `Button asChild` renders the child `<Link>` (an `<a>`) via Radix `Slot.Root`,
which forwards the `disabled` prop as a `disabled=""` attribute on the anchor. The
button's cva guard `disabled:pointer-events-none disabled:opacity-50` relies on the
`:disabled` CSS pseudo-class, which **never matches `<a>`** — anchors are not
form-associated elements, so the attribute is non-standard and has no effect on
clickability. The Cancel link therefore remains fully clickable for the entire
`isPending` window (a Convex mutation round-trip, easily 200 ms–2 s+).

**Impact:** User clicks Cancel mid-mutation → navigates to `/app/projects`. The TanStack
Query mutation does **not** cancel on unmount, so `onSuccess` still fires
`navigate({ to: "/app/projects/$projectSlug", ... })` (line ~46), yanking the user from
`/app/projects` to the freshly-created project detail and overriding their explicit
Cancel. If the mutation then fails, the error toast lands on a page the user never
intended to be on. The submit `<Button type="submit" disabled={isPending}>` (line 192) is
a real `<button>` and disables correctly; only the `asChild` Cancel link is broken.

**Fix:** Either render a non-`asChild` button that calls `navigate` in `onClick` (so
`disabled` is honored), or keep `asChild` but gate the navigation:

```tsx
<Button
  asChild
  variant="ghost"
  type="button"
  aria-disabled={isPending}
  className={isPending ? "pointer-events-none opacity-50" : undefined}
>
  <Link to="/app/projects">Cancel</Link>
</Button>
```

---

### [P2] `if (!isLoaded) return null` renders a blank page — no skeleton, no `pendingComponent`

**Location:** `apps/web/src/routes/app/projects/create.tsx:94-96`

```tsx
if (!isLoaded) {
  return null;
}
```

**Problem:** `useOrganization()` from `@clerk/tanstack-react-start` resolves
asynchronously (typically 100–500 ms on first paint, longer on slow networks). While it
loads, the component returns `null` — a completely blank content area. The route also
declares **no `pendingComponent`**, so TanStack Router's suspense boundary offers
nothing either.

**Impact:** Layout shift / flash of empty content on every cold visit to the create
page. This directly violates the project UI rule "loading = layout-stable skeletons".
Every sibling route ships a `pendingComponent` skeleton: `org/create.tsx`
(`CreateOrgSkeleton`), `projects/index.tsx` (`ProjectsListSkeleton`),
`projects/$projectSlug.tsx` (`ProjectPageSkeleton`), `billing.tsx`, `earnings.tsx`,
`org/index.tsx`, `app/index.tsx`. The project create route is the lone outlier.

**Fix:** Mirror `org/create.tsx` — add a `pendingComponent` skeleton and render it
(inline, or via `if (!isLoaded) return <CreateProjectSkeleton />`) instead of `null`.

```tsx
export const Route = createFileRoute("/app/projects/create")({
  component: CreateProjectPage,
  pendingComponent: CreateProjectSkeleton,
  head: () => ({ meta: [{ title: "New project · Zevium" }] }),
});

// inside component:
if (!isLoaded) {
  return <CreateProjectSkeleton />;
}
```

---

### [P3] `if (!orgSlug)` early-return panel renders outside the `max-w-lg` container

**Location:** `apps/web/src/routes/app/projects/create.tsx:98-113`

```tsx
if (!orgSlug) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New project</h1>
        ...
```

**Problem:** The main create form is wrapped in
`<div className="mx-auto flex w-full max-w-lg flex-col gap-6">` (line 115), but the
no-org early-return uses a bare `flex flex-col gap-6` with no max-width or `mx-auto`. The
two states occupy different horizontal extents, so transitioning between them (e.g.,
org switch while the route is mounted) produces a visible width jump. The
no-org-state in `projects/index.tsx` (`NoOrgState`) has the same shape — but there it
matches the list page's full-width layout; here it should match the form's `max-w-lg`.

**Impact:** Minor layout inconsistency between the empty-org state and the create form.

**Fix:** Wrap the no-org panel in the same `mx-auto flex w-full max-w-lg flex-col gap-6`
container (or extract a shared shell).

---

### [P3] Raw `<textarea>` duplicates shadcn `Textarea` styles and drifts

**Location:** `apps/web/src/routes/app/projects/create.tsx:169-180`

```tsx
<textarea
  id="project-description"
  ...
  rows={4}
  className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
/>
```

**Problem:** A canonical `Textarea` component exists at
`apps/web/src/components/ui/textarea.tsx`. The hand-written className here reproduces it
but **drifts**: missing `field-sizing-content` (so this textarea won't auto-grow like
the canonical one), missing `dark:bg-input/30`, missing the
`aria-invalid:border-destructive aria-invalid:ring-destructive/20` variants, and a
different `min-h` (`min-h-24` vs `min-h-16`). Future updates to `Textarea` won't
propagate here. Note: `project-settings-panel.tsx:217` and `spec-rail.tsx:572` repeat the
same raw-`<textarea>` pattern — that's prior art, not a reason to keep drifting.

**Impact:** Style drift; no `field-sizing-content` means a long description scrolls
instead of growing. Maintainability tax.

**Fix:** Import and use the shared component:

```tsx
import { Textarea } from "#/components/ui/textarea";
...
<Textarea
  id="project-description"
  name="project-description"
  autoComplete="off"
  value={description}
  onChange={(e) => setDescription(e.target.value)}
  placeholder="Describe inputs, outputs, and ideal use cases…"
  maxLength={2000}
  disabled={isPending}
  rows={4}
  className="min-h-24"
/>
```

---

### [P3] No `FadeIn` enter animation — inconsistent with `org/create.tsx` and sibling routes

**Location:** `apps/web/src/routes/app/projects/create.tsx:114-197` (main return)

**Problem:** `org/create.tsx` wraps its content in `<FadeIn className="...">`, as do
`projects/index.tsx` (`<FadeIn>` around the list) and `projects/$projectSlug.tsx`. The
project create route renders a bare `<div className="mx-auto ...">` with no entrance
animation. `FadeIn` (from `#/components/motion/fade-in`) already handles
`prefers-reduced-motion` and the `vtState.active` skip, so adopting it is low-risk and
matches the codebase's motion convention ("all animation from src/lib/motion.ts /
CSS vars").

**Impact:** Inconsistent page-enter feel; the create form pops in where peer routes
crossfade.

**Fix:**

```tsx
import { FadeIn } from "#/components/motion/fade-in";
...
return (
  <FadeIn className="mx-auto flex w-full max-w-lg flex-col gap-6">
    ...
  </FadeIn>
);
```

---

### [P3] No view-transition morph from create → detail (no written reason either)

**Location:** `apps/web/src/routes/app/projects/create.tsx:45-50` (onSuccess navigate) and `:117` (title) / `:152` (name input)

**Problem:** After `onSuccess`, the route navigates to
`/app/projects/$projectSlug`. The detail page sets
`style={{ viewTransitionName: \`project-title-${project.slug}\` }}` and
`project-status-${project.slug}` (`projects/$projectSlug.tsx:203,213`). The list page
sets matching source VT names (`projects/index.tsx:130,141`) so the list→detail morph
works. The create form sets **no** matching `viewTransitionName` on its name input,
title, or any preview element, so the create→detail navigation snaps with no morph.

The project UI rule explicitly calls out list→detail (`"every list→detail nav ships
view-transition morph or written reason"`). Create→detail is not literally list→detail,
but it is the other producer of a project detail navigation and there is no written
reason for the asymmetry.

**Impact:** Missed morph opportunity on the create→detail handoff; the new project's
title/status badges appear with a hard cut where a morph is the established pattern.

**Fix:** Either tag a source element (e.g., the name input or a hidden preview span)
with `style={{ viewTransitionName: \`project-title-${slug}\` }}` when `slug` is non-empty
and not yet taken, or add a one-line comment explaining why the create flow opts out.

---

## Summary

**Counts:** 0 × P0 · 0 × P1 · 2 × P2 · 4 × P3 · 6 total

**Top 3 to fix before merge:**

1. **Cancel link not disabled during pending (P2)** — `Button asChild` + `disabled`
   silently fails on `<a>`; users can navigate away mid-mutation and get yanked back by
   `onSuccess`. Real, easily-triggered UX bug.
2. **`return null` instead of a skeleton (P2)** — every sibling route ships a
   `pendingComponent`; this one blanks. Violates the project's "layout-stable skeletons"
   rule and causes a visible flash on cold load.
3. **Raw `<textarea>` + missing `FadeIn` + no create→detail VT (P3 cluster)** — the
   create route diverges from the codebase's own component/motion/VT conventions in
   several small ways; each is a one-line fix toward consistency.

**Backend cross-check (no findings):** `convex/projects.ts` `create` validates name
length (≤120), slug via `isValidSlug`, description length (≤2000), and enforces org-
scoped slug uniqueness via `by_org_slug` `.unique()` + insert — so even a true
double-submit cannot create duplicate projects (the second call throws "Project slug
already exists"). `convex/organizations.ts` `ensureOrganization` verifies the Clerk
`org_id` claim matches `args.clerkOrgId`, preventing cross-tenant org invention. Both
backends are sound; the defects are entirely client-side.
