# Tiger Review — `apps/web/src/routes/app/projects/index.tsx`

Scope: `index.tsx` (primary), `create.tsx`, `convex/projects.ts` read in full
for integration context. No `git diff` — files are committed; review is against
current HEAD (`c771e77`).

## Verdict

**Incorrect** — 2 correctness/UX bugs (P2) and 2 minor consistency issues (P3).
The index list itself is clean (semantic tokens, CSS-var motion, layout-stable
skeletons, list→detail view-transition morph correctly paired with
`$projectSlug.tsx`), but the create flow and the backing `list` query have
real defects the author would want fixed before merge.

## File Stats

| File | Lines | Status |
|---|---|---|
| `apps/web/src/routes/app/projects/index.tsx` | 230 | clean |
| `apps/web/src/routes/app/projects/create.tsx` | 201 | 3 findings |
| `convex/projects.ts` | 173 | 1 finding |

Cross-boundary trace: `create` mutation (convex/projects.ts) → returns
`Doc<"projects">` consumed by `create.tsx` `onSuccess` → navigates to
`$projectSlug` which subscribes to `api.projects.get`. The new `Doc` flows
through React Query + Convex realtime; no unmatched variant / silent drop on
the consuming side. `list` query consumers: `index.tsx` `useSuspenseQuery`
only — confirmed single consumer.

## Findings

### [P2] `projects.list` returns unspecified order — newest projects land at the bottom

**Location:** `convex/projects.ts:11-15`

```ts
return await ctx.db
  .query("projects")
  .withIndex("by_org", (q) => q.eq("organizationId", org._id))
  .collect();
```

**Problem:** `.collect()` is called with no `.order()`. Convex documents that
results without an explicit `.order()` have **unspecified ordering**. The
`by_org` index is `["organizationId"]` only (schema.ts:31), so within an org
rows surface in `_creationTime` **ascending** order — the newest project last.

**Impact:** After creating a project and returning to `/app/projects`, the new
project renders at the *end* of the grid. With ≥6 projects (a second row) it
lands below the fold, invisible without scrolling — users reasonably conclude
the create failed. This also contradicts the codebase convention for list
queries: `notifications.list` (`.order("desc")`), `usage.listForOrg`
(`by_org_at` + desc), `billing` payments queries all surface newest first.

**Fix:**
```ts
return await ctx.db
  .query("projects")
  .withIndex("by_org", (q) => q.eq("organizationId", org._id))
  .order("desc")
  .collect();
```

---

### [P2] `Cancel` button stays clickable while `create` is in-flight

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

**Problem:** `Button asChild` uses Radix `Slot.Root`, which forwards `disabled`
onto the rendered `<a>`. But the `:disabled` CSS pseudo-class only matches
form controls (`<button>`, `<input>`, …) — **not anchors**. So neither
`disabled:pointer-events-none` nor `disabled:opacity-50` from `buttonVariants`
(button.tsx:8) applies. The Cancel link looks normal and is fully clickable
for the entire duration of the Convex `create` mutation. The sibling submit
`<Button type="submit" disabled={isPending}>` is a real `<button>` and
correctly disables — only the asChild variant is broken.

**Impact:** Clicking Cancel mid-mutation unmounts the form. The Convex
mutation still commits server-side (project is created), but the
`useMutation` observer is torn down before `onSuccess` fires, so the user
gets neither the success toast nor the navigation to the new project's detail
page. They land back on the list with a phantom "did it work?" state.

**Fix:** Don't rely on `disabled` propagating through `asChild` to an anchor.
Gate the navigation explicitly, e.g.:

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

(or render a real `<button type="button" disabled={isPending} onClick={() => navigate({ to: "/app/projects" })}>` during pending.)

---

### [P3] `create.tsx` returns `null` while Clerk org loads — layout flash, no skeleton

**Location:** `apps/web/src/routes/app/projects/create.tsx:94-96`

```tsx
if (!isLoaded) {
  return null;
}
```

**Problem:** During the `useOrganization()` load window (SSR hydration / first
client paint), the route renders nothing, then pops in once `isLoaded`
flips. The sibling `index.tsx` returns `<ProjectsListSkeleton />` for the
identical condition (index.tsx:60-62), and the project rule states
"loading = layout-stable skeletons". The create page is the outlier.

**Impact:** Visible layout shift on cold loads; inconsistent with the rest of
the projects area.

**Fix:** Render a stable shell (page header + card outline skeleton) instead
of `null`, mirroring `index.tsx`'s `pendingComponent` approach.

---

### [P3] No `projects.list` cache invalidation after `create` — brief stale list on return

**Location:** `apps/web/src/routes/app/projects/create.tsx:51-57`

```tsx
onSuccess: (project) => {
  toast.success("Project created");
  void navigate({
    to: "/app/projects/$projectSlug",
    params: { projectSlug: project.slug },
  });
},
```

**Problem:** `onSuccess` navigates to the detail route but never touches the
`convexQuery(api.projects.list, { orgSlug })` cache. When the user later
returns to `/app/projects`, `useSuspenseQuery` serves the stale cached list
(missing the new project) until the Convex subscription re-establishes and
pushes current state. The sibling detail route (`$projectSlug.tsx`) explicitly
invalidates the list query after `setVisibility` for exactly this reason —
the create flow is inconsistent.

**Impact:** A brief flash where the just-created project is absent from the
list. Self-correcting via realtime, but confusing in the moment, and the
inconsistency with the detail route suggests an oversight rather than a
design choice.

**Fix:**
```tsx
onSuccess: async (project) => {
  toast.success("Project created");
  await queryClient.invalidateQueries({
    queryKey: convexQuery(api.projects.list, { orgSlug }).queryKey,
  });
  void navigate({
    to: "/app/projects/$projectSlug",
    params: { projectSlug: project.slug },
  });
},
```

## Summary

- **Findings:** 4 (P2: 2, P3: 2)
- **Top 3:**
  1. `projects.list` has unspecified ordering — new projects render at the
     bottom of the grid, off-screen once a second row exists. (P2)
  2. `Cancel` button (asChild Link) is not disabled during `isPending` —
     anchor ignores `:disabled`, so the in-flight mutation can be abandoned
     mid-flight. (P2)
  3. `create.tsx` returns `null` during `!isLoaded`, violating the
     layout-stable-skeleton rule the sibling list route follows. (P3)

**Non-issues explicitly checked and cleared:**
- List→detail view-transition morph: `project-title-${slug}` /
  `project-status-${slug}` correctly paired between `index.tsx:129-142` and
  `$projectSlug.tsx:202-214`. VT names are always letter-prefixed
  (`project-…`), so digit-starting slugs do not produce invalid CSS
  custom-idents.
- Raw Tailwind colors: none — all `bg-muted`, `text-muted-foreground`,
  `border-input`, `ring-ring/50`, etc.
- Hardcoded motion values: none — `duration-[var(--dur-instant)]` /
  `ease-[var(--ease)]` reference `styles.css:48-53`; `FadeIn` uses `DUR`/`EASE`
  from `motion.ts`. `prefers-reduced-motion` is globally handled
  (styles.css:213-226) including the card hover transforms.
- `isPending` usage: correct (mutation, not `isLoading`).
- Error leaking: `humanError` (human-error.ts) filters `Server Error` /
  `ConvexError` / `Uncaught` / `at handler` and caps length at 200; Convex
  `create` throws intentional user-facing messages (`Project slug already
  exists in this organization`) that pass through correctly.
- Stale list after create via Convex realtime: subscription re-establishes on
  return — see P3 above for the residual cache-serve window.
- Dead code: none — all imports used.
