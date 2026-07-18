# Tiger Deep Review — `apps/web/src/routes/app/projects/index.tsx`

**Scope:** `apps/web/src/routes/app/projects/index.tsx` (primary), with cross-file
analysis of `apps/web/src/routes/app/projects/create.tsx`, `convex/projects.ts`,
`convex/schema.ts`, `apps/web/src/components/ui/button.tsx`, and
`apps/web/src/routes/app/projects/$projectSlug.tsx` (VTN contract).

## Verdict

Not shippable as-is. One real data-integrity race (P1) in the backing mutation
that this route's list reflects, plus four P2 UX/correctness issues in the
route and its sibling create page that violate stated project rules
(view-transition morph, layout-stable skeletons, disabled-during-pending).
The list itself is well-built (skeleton, semantic tokens, VTN-paired morph to
the detail page), but the create→detail path is missing its morph source, and
the Cancel `Button asChild disabled` is a no-op against the wrapped anchor.

## File Stats

- **File:** `apps/web/src/routes/app/projects/index.tsx`
- **Lines reviewed:** 1–166 (full), plus `create.tsx` (1–134), `convex/projects.ts` (1–173)
- **Findings:** 9 total — P0: 0, P1: 1, P2: 4, P3: 4

## Findings

### [SEV: P1] Slug-uniqueness TOCTOU race in `convex/projects.ts` `create`

**Location:** `convex/projects.ts:67–83`

```ts
const existing = await ctx.db
  .query("projects")
  .withIndex("by_org_slug", (q) =>
    q.eq("organizationId", org._id).eq("slug", slug),
  )
  .unique();
if (existing !== null) {
  throw new Error("Project slug already exists in this organization");
}

const projectId = await ctx.db.insert("projects", { … slug, … });
```

**Problem:** The existence check and the insert are not atomic. Convex serializes
mutations, but two concurrent `create` mutations on *different* orgs (or even
the same org under read-only concurrency) can both observe `existing === null`
before either inserts. Convex's `by_org_slug` index
(`convex/schema.ts:31-32` — `.index("by_org_slug", ["organizationId", "slug"])`)
is **not** a unique constraint — Convex has no native unique indexes; uniqueness
must be enforced in app code with a locking row, or tolerated with a reconciliation path.

**Impact:** Duplicate `(organizationId, slug)` rows in `projects`. Downstream
`get` uses `.unique()` on the same index and will *throw* on the duplicate,
making the project detail page (`$projectSlug.tsx`) 500 for that slug forever.
Gateway routing keyed on slug also bifurcates. This is silent data corruption
that surfaces only later as a 500 on a path the user just created.

**Fix:** Either (a) insert a dedicated lock document per `(orgId, slug)` in a
`projectSlugLocks` table (insert → if `D uniqueness error`-equivalent, throw),
or (b) after insert, re-query `by_org_slug` and if `count > 1`, delete the
just-inserted doc and throw "slug already exists". Option (a) is the canonical
Convex pattern for unique constraints. At minimum, document the assumption.

---

### [SEV: P2] Cancel `Button asChild disabled` does not disable the wrapped `<Link>`

**Location:** `apps/web/src/routes/app/projects/create.tsx:113–118`

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

**Problem:** shadcn's `Button` (`apps/web/src/components/ui/button.tsx:48–58`)
renders `Slot.Root` when `asChild`, spreading `disabled` onto the child `<a>`.
`disabled` is **not** a valid attribute on `<a>` — browsers ignore it, and the
`:disabled` CSS pseudo-class never matches anchors. The `disabled:opacity-50`
and `disabled:pointer-events-none` utility classes in `buttonVariants` therefore
never apply. No `data-disabled` attribute is set, no `aria-disabled`, no
`pointer-events` override. The link is fully clickable and visually unchanged
during `isPending`.

**Impact:** User can navigate away mid-mutation. The `useMutation` continues,
`onSuccess` fires `navigate(...)` to the detail page *after* the user already
left to `/app/projects`, producing a jarring mid-flight route swap and leaving
the create form's intent ambiguous. Also no visual feedback that Cancel is
disabled, breaking the "disabled during pending" UX contract.

**Fix:** Don't use `asChild` here; render the Button directly and use
`useNavigate`/`router.navigate` in an `onClick` that early-returns when
`isPending`. Or keep `asChild` but drop `disabled` and gate the click:
`onClick={(e) => { if (isPending) { e.preventDefault(); return; } }}`.
The project rule "mutations: `.mutate()` in handlers" already implies
handler-driven nav.

---

### [SEV: P2] No view-transition morph on create → detail navigation

**Location:** `apps/web/src/routes/app/projects/create.tsx` (entire component) ↔
`apps/web/src/routes/app/projects/$projectSlug.tsx:201–215`

**Problem:** The detail page sets matching VTNs for the list→detail morph:

```tsx
// $projectSlug.tsx:202-214
<Badge style={{ viewTransitionName: `project-status-${project.slug}` }}>…
<h1   style={{ viewTransitionName: `project-title-${project.slug}`   }}>…
```

The list page (`index.tsx:129–143`) sets the same VTNs — so list→detail morphs
correctly. But the **create page sets no VTN source** for either the title or
the status badge. When `onSuccess` navigates to the detail page, the detail
page's `project-title-${slug}` / `project-status-${slug}` have no morph source
on the create page, so the transition degrades to a plain cross-fade.

**Impact:** Violates the project rule: *"every list→detail nav ships
view-transition morph or written reason."* The create→detail nav is a list→detail
nav (the create page is the entry surface for a brand-new project that will
appear in the list). No written reason is present. The morph is the payoff for
the `viewTransitionName` plumbing on the detail page; it's wasted here.

**Fix:** On the create page, set `style={{ viewTransitionName: \`project-title-${slug}\` }}`
on the "Name" input's container (or the card title) and
`viewTransitionName: \`project-status-${slug}\`` on a draft "draft" Badge in the
form header, using the live `slug` state. Guard against empty slug (empty VTN
is fine — no morph). Add a short comment explaining the contract.

---

### [SEV: P2] `create.tsx` returns `null` during `!isLoaded` — blank flash, no skeleton

**Location:** `apps/web/src/routes/app/projects/create.tsx:71–73`

```tsx
if (!isLoaded) {
  return null;
}
```

**Problem:** The route has no `loader`, no `pendingComponent`, and returns `null`
while Clerk's `useOrganization` is loading. On a client-side navigation from
`/app/projects` (the "New project" button) this renders a blank page until the
org resolves — typically a frame or two, longer on slow networks. This violates
the project rule *"loading = layout-stable skeletons"* and is inconsistent with
`index.tsx`, which renders `<ProjectsListSkeleton />` for the same `!isLoaded`
condition (`index.tsx:42–44`).

**Impact:** Visible blank flash on every "New project" navigation. Layout
collapses (no header, no form shape) then pops in — exactly the instability
skeletons exist to prevent.

**Fix:** Add a `pendingComponent` (a `CreateProjectSkeleton` mirroring the
card+form shape) and either keep `return null` only for the SSR branch or
return the skeleton there too. Reuse the same skeleton pattern as
`ProjectsListSkeleton`.

---

### [SEV: P2] `projects.list` has no explicit ordering; effectively oldest-first

**Location:** `convex/projects.ts:8–14`

```ts
return await ctx.db
  .query("projects")
  .withIndex("by_org", (q) => q.eq("organizationId", org._id))
  .collect();
```

**Problem:** No `.order("asc" | "desc")`. Within `by_org` (single field
`organizationId`), Convex returns rows ordered by `_creationTime` ascending —
i.e. **oldest projects first**. For a project dashboard where users create
projects and expect to see the most recent at the top, this is backwards and
surprising. It's also implicit: a future schema change to the index, or a
Convex runtime behavior shift, could silently reorder the list.

**Impact:** New projects (the whole point of `create.tsx`) appear at the
*bottom* of the grid. After creating a project and navigating back, the user
has to scan to the end to find it. Combined with the missing
`projects.list` invalidation (see P3 below), this is the most likely
"where did my project go?" report.

**Fix:** `.order("desc")` for newest-first, or `.order("asc")` if oldest-first
is genuinely intended — make it explicit either way.

---

### [SEV: P3] `create.tsx` does not invalidate `projects.list` in `onSuccess`

**Location:** `apps/web/src/routes/app/projects/create.tsx:45–53`

```ts
onSuccess: (project) => {
  toast.success("Project created");
  void navigate({
    to: "/app/projects/$projectSlug",
    params: { projectSlug: project.slug },
  });
},
```

**Problem:** Every sibling mutation that touches project state invalidates
`projects.list`:
- `$projectSlug.tsx:163–166` (visibility update)
- `project-settings-panel.tsx:71–74, 142–145` (settings, delete)
- `spec-workspace.tsx:239–242, 261–264` (publish/unpublish)

`create.tsx` is the odd one out. `convexQuery`'s realtime subscription *usually*
covers this — if the projects index subscription is still cached (within
`gcTime`), Convex pushes the new doc and the list updates. But the subscription
is only live while the query is cached; if the user navigated create → settings
→ … and `gcTime` elapsed, the list is stale on return. The defensive
invalidation that siblings use exists precisely for this case.

**Impact:** Rare stale-list edge case; primarily an inconsistency with the
established pattern. Defensive depth is missing on the one mutation that adds a
new row to the list.

**Fix:** In `onSuccess`, before/after navigate:
```ts
await queryClient.invalidateQueries({
  queryKey: convexQuery(api.projects.list, { orgSlug }).queryKey,
});
```
Requires lifting `useQueryClient` into `CreateProjectPage`.

---

### [SEV: P3] Hardcoded arbitrary motion values on project cards

**Location:** `apps/web/src/routes/app/projects/index.tsx:122`

```tsx
<Card className="h-full transition-[transform,box-shadow,border-color]
  duration-[var(--dur-instant)] ease-[var(--ease)]
  group-hover:-translate-y-0.5 group-hover:shadow-sm
  group-active:scale-[0.98]">
```

**Problem:** The timing values correctly reference CSS vars
(`--dur-instant`, `--ease`) — good. But the transform magnitudes
`-translate-y-0.5` (= -2px) and `scale-[0.98]` are inline magic numbers, not
sourced from `src/lib/motion.ts`. The project rule states *"all animation from
`src/lib/motion.ts` / CSS vars."* These belong as exported constants or a
shared card-hover variant so the same magnitudes are reused consistently
across the catalogue cards, project cards, etc.

**Impact:** Minor drift across card surfaces; hard to tune globally.
`buttonVariants` itself hardcodes `active:scale-[0.97]` (button.tsx:9), so
there's already precedent, but the rule says motion.ts.

**Fix:** Export a `cardHover` variant from `src/lib/motion.ts` (or a CSS var
pair `--lift-y` / `--press-scale`) and apply via `cn(cardHover, …)`.

---

### [SEV: P3] Loader's outer `catch {}` silently swallows all `ensureMirrorOnServer` errors

**Location:** `apps/web/src/routes/app/projects/index.tsx:38–46`

```ts
try {
  const mirror = await ensureMirrorOnServer();
  if (!mirror.mirrored) return;
  try {
    await queryClient.ensureQueryData(queryOpts);
  } catch {
    queryClient.removeQueries({ queryKey: queryOpts.queryKey });
  }
} catch {
  // Auth redirect or missing org — component handles empty/loading UI.
}
```

**Problem:** The inner catch correctly removes the stale cache entry (with a
clear comment). The outer catch swallows *everything* from
`ensureMirrorOnServer()` with no logging, no telemetry, no distinction between
"auth redirect" and "network failure / unexpected throw". If the mirror step
starts throwing for a new reason (e.g., a Convex schema mismatch after deploy),
this loader silently degrades to "perpetual skeleton until client query
succeeds" with zero signal.

**Impact:** Obscures real backend errors during SSR. The component's
`useSuspenseQuery` will still throw into the error boundary on the client if
the query truly fails, so it's not a hard bug — but the outer catch is a
diagnostic black hole.

**Fix:** At minimum, log the swallowed error to console in dev
(`if (import.meta.env.DEV) console.error("[projects.loader]", err)`). Better:
re-throw non-auth errors so the route error boundary renders instead of an
infinite skeleton. `ensureMirrorOnServer` should expose a typed error so callers
can distinguish auth-missing from network-failed.

---

### [SEV: P3] `humanError` filter is brittle; passes through arbitrary short server messages

**Location:** `apps/web/src/lib/human-error.ts:8–24` (consumed by `create.tsx:50`)

```ts
if (
  msg.length > 0 &&
  msg.length <= 200 &&
  !msg.includes("Server Error") &&
  !msg.includes("ConvexError") &&
  !msg.startsWith("Uncaught") &&
  !msg.includes("at handler")
) {
  return msg;
}
```

**Problem:** For `create.tsx`, this is mostly fine — `convex/projects.ts`
throws intentional user-facing messages ("Name is required", "Project slug
already exists in this organization") that pass the filter and surface in the
toast. But the filter is a denylist of substrings, not an allowlist. A future
backend message that happens to be short and clean but contains internal
detail (e.g., a Convex internal error re-thrown with a terse message) would
leak verbatim to the user. The `!msg.includes("at handler")` guard in
particular is a code-smell — it suggests the filter was tuned to specific
observed error shapes rather than a principled boundary.

**Impact:** Low today (the create mutation's thrown messages are all
intentional), but the brittleness is shared infrastructure. Not actionable
in this file alone — flagged for the `humanError` owner.

**Fix:** Prefer an explicit `ConvexError`-typed allowlist: have
`convex/projects.ts` throw `new ConvexError({ code: "SLUG_TAKEN", message: "…" })`
and have `humanError` map known codes to copy, falling back to the generic
message for anything else. Removes the substring denylist entirely.

---

## Summary

**Counts:** P0: 0 · P1: 1 · P2: 4 · P3: 4 — **9 findings**

**Top 3:**
1. **P1 — Slug-uniqueness TOCTOU race** in `convex/projects.ts create`: Convex
   indexes aren't unique; concurrent creates can produce duplicate slugs that
   500 the detail page's `.unique()` forever. Enforce via a lock row.
2. **P2 — Cancel `asChild`+`disabled` is a no-op** on the wrapped anchor in
   `create.tsx`: users can navigate away mid-submit with no visual feedback.
   Gate the click in a handler or drop `asChild`.
3. **P2 — No view-transition morph on create→detail nav**: detail page plumbs
   `project-title-${slug}` / `project-status-${slug}` VTNs that have no source
   on the create page, violating the list→detail morph rule. Add matching VTNs
   on the create form.

**Cross-cutting note:** The `create.tsx` page is the weak link in this surface
— it skips the skeleton, the cache invalidation, the VTN morph, and the
disabled-link gating that the rest of the projects surface already
establishes. Bring it up to parity with `index.tsx` and `$projectSlug.tsx`.
