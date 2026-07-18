# Tiger Deep Review — `apps/web/src/routes/app/settings.tsx` + `apps/web/src/routes/app/settings/index.tsx`

Scope: `apps/web/src/routes/app/settings.tsx` (layout, 59 lines) and
`apps/web/src/routes/app/settings/index.tsx` (index, 56 lines), read in full.
Cross-referenced `apps/web/src/router.tsx`, `apps/web/src/styles.css`,
`apps/web/src/lib/motion.ts`, `apps/web/src/lib/vt.ts`,
`apps/web/src/components/admin-header.tsx`, and
`apps/web/src/routes/app/org/index.tsx` (the sibling Clerk-profile route whose
pattern this pair should mirror). `convex/organizations.ts` and
`convex/wallets.ts` were inspected for the "stale org context after switch"
angle — see Finding 6 for why it is N/A here.

This review **verifies and expands** the prior
`reviews/apps.web.src.routes.app.settings.tsx.md` (1 P2 + 1 P3) and the CLS
note carried over from the settings/index pass.

## Verdict

**Incorrect.** The layout tab bar still diverges accessible state from visual
state on the Overview tab (P2, verified), and the index route embeds Clerk's
`<UserProfile>` with zero reserved height or skeleton — a real CLS defect
that the sibling `org/index.tsx` route already mitigates with `min-h-[28rem]`
(P2, verified + expanded). Two further P3s: a dead trailing-slash branch
(verified) and a tab indicator that hard-pops instead of animating, breaking
the project's motion-first convention. No P0/P1, no raw Tailwind colors, no
hardcoded motion values, no `isPending` misuse, no leaked errors. Stale-org
context is N/A for this pair (neither file reads org-scoped data).

## File Stats

| File | Lines | Findings |
|---|---|---|
| `apps/web/src/routes/app/settings.tsx` | 59 | 3 (1 P2, 2 P3) |
| `apps/web/src/routes/app/settings/index.tsx` | 56 | 2 (1 P2, 1 P3) |
| **Total** | **115** | **5** |

## Findings

### [SEV: P2] Overview tab leaks `aria-current="page"` onto every settings sub-route (verified)

**Location** — `apps/web/src/routes/app/settings.tsx:30-46`

```tsx
{tabs.map((tab) => {
  const active = tab.exact
    ? pathname === tab.to || pathname === `${tab.to}/`
    : pathname === tab.to || pathname.startsWith(`${tab.to}/`);
  return (
    <Link
      key={tab.to}
      to={tab.to}
      className={cn(
        "relative rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-[var(--dur-instant)] ease-[var(--ease)]",
        active
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
```

**Problem.** Verified. The visual `active` flag is hand-computed with
`tab.exact`, so the Overview tab (`to: "/app/settings"`, `exact: true`) is
underlined only on `/app/settings`. But `<Link>` is TanStack Router's
`Link`, which spreads `STATIC_ACTIVE_PROPS = { "data-status": "active",
"aria-current": "page", className: "active" }` whenever its *own* `isActive`
is true — and `isActive` defaults to `activeOptions.exact === false` because
no `activeOptions` is passed. The router has no `trailingSlash` option
(`apps/web/src/router.tsx`), so the default `'never'` canonicalizes
`location.pathname` and the Overview link resolves to the index route.

Consequence: on `/app/settings/keys` and `/app/settings/activity`, TanStack
considers the Overview link active (both are descendants of `/app/settings`),
so it emits `aria-current="page"` and `data-status="active"`, while the
manual `active` branch styles it as inactive (muted, no underline). Screen
readers announce "current page: Overview" when the user is on API keys or
Activity. Visual and accessible state disagree — WCAG 4.1.2/4.1.3.

This is the canonical anti-pattern the codebase already solved elsewhere:
`apps/web/src/components/admin-header.tsx:33-35` drives styling off
`data-[status=active]:text-foreground` with `activeProps={{ "data-status":
"active" }}` and lets TanStack own active detection. The settings layout
re-implements detection by hand and gets the a11y contract wrong.

The "API keys" and "Activity" tabs are unaffected because both the manual
check and TanStack's default use `exact: false`, so they agree.

**Impact.** Wrong current-page announcement to assistive tech on two of the
three tabs; also appends a stray `active` class (no-op under Tailwind v4 — no
`.active` rule exists in `styles.css`) to the Overview link on every
sub-route.

**Fix.** Stop hand-computing `active` and let TanStack own it, matching
`admin-header.tsx`:

```tsx
const tabs = [
  { title: "Overview", to: "/app/settings", exact: true },
  { title: "API keys", to: "/app/settings/keys", exact: false },
  { title: "Activity", to: "/app/settings/activity", exact: false },
] as const;

function SettingsLayout() {
  return (
    <div className="flex flex-col gap-6">
      <nav className="flex flex-wrap gap-1 border-b pb-px" aria-label="Settings sections">
        {tabs.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            activeOptions={{ exact: tab.exact }}
            activeProps={{ "data-status": "active" }}
            className={cn(
              "relative rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-[var(--dur-instant)] ease-[var(--ease)]",
              "text-muted-foreground hover:text-foreground data-[status=active]:text-foreground",
            )}
          >
            {tab.title}
            <span
              className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-primary data-[status=inactive]:opacity-0"
              data-status="inactive"
              aria-hidden
            />
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
```

This deletes the manual `pathname` selector (`useRouterState` import goes
too), deletes the `active` ternary, and aligns `aria-current`/`data-status`
with the visual state. The minimal one-line fix (`activeOptions={{ exact:
tab.exact }}` added to the existing `<Link>`) also resolves the a11y leak but
leaves the duplicated detection logic — prefer the full cutover above.

---

### [SEV: P2] `settings/index.tsx` embeds `<UserProfile>` with no reserved height or skeleton → CLS (verified + expanded)

**Location** — `apps/web/src/routes/app/settings/index.tsx:31-50`

```tsx
<Card className="overflow-hidden">
  <CardHeader>
    <CardTitle>Account</CardTitle>
    <CardDescription>
      Profile, security, and connected accounts via Clerk.
    </CardDescription>
  </CardHeader>
  <CardContent className="p-0 sm:p-2">
    <div className="w-full overflow-x-auto">
      <UserProfile
        routing="hash"
        appearance={{
          theme: shadcn,
          elements: {
            rootBox: "w-full mx-auto",
            cardBox: "w-full shadow-none",
            card: "w-full shadow-none",
            navbar: "border-border",
            scrollBox: "w-full",
          },
        }}
      />
    </div>
  </CardContent>
</Card>
```

**Problem.** Verified. `<UserProfile />` is a heavy Clerk component: it
lazy-loads its JS bundle, then renders its own internal skeleton, then
fetches user data and fills in the avatar/name/sections. The wrapper chain
here — `Card` (`overflow-hidden`, no height) → `CardContent` (`p-0 sm:p-2`)
→ `div` (`w-full overflow-x-auto`, no height) — reserves **zero** vertical
space. The card's height collapses to `CardHeader` (~56px) while the bundle
loads, snaps to the Clerk skeleton height (~400px) once it mounts, then
re-flows again when the real profile paints. Three distinct heights across
the load = cumulative layout shift on every visit to `/app/settings`.

The codebase already knows this pattern and mitigates it elsewhere. The
sibling Clerk-profile route `apps/web/src/routes/app/org/index.tsx:93-98`
wraps `<OrganizationProfile>` in:

```tsx
<div className="min-h-[28rem] w-full overflow-hidden rounded-xl border bg-card">
  <OrganizationProfile routing="hash" appearance={{ theme: shadcn }} … />
</div>
```

— `min-h-[28rem]` (448px) reserves the slot before the bundle lands. The
settings index omits this entirely, despite using the same Clerk component
family and the same `routing="hash"` + `shadcn` theme. It is an oversight,
not a deliberate divergence.

Two aggravating factors unique to the settings index:

1. **No `pendingComponent` on the route.** `org/index.tsx:25` declares
   `pendingComponent: OrgHomeSkeleton`. `settings/index.tsx` declares none,
   so there is no route-level skeleton to bridge the async gap. (Note: a
   `pendingComponent` alone would *not* fix the CLS, because `<UserProfile>`
   loads *after* the route renders — the fix must reserve height on the
   wrapper itself. But the absence of both layers compounds the shift.)

2. **`p-0 sm:p-2` on `CardContent`.** On mobile (`p-0`) the UserProfile
   touches the card border with zero inset, and the `overflow-x-auto` div
   introduces a horizontal scrollbar the moment UserProfile's internal navbar
   exceeds the viewport — which it routinely does on narrow screens before
   the responsive navbar collapses. The org route avoids both by using a bare
   `rounded-xl border bg-card` container (no Card chrome, no `overflow-x-auto`).

**Impact.** Measurable CLS on every cold visit to `/app/settings` and on
every return navigation where the Clerk bundle has been evicted. Fails the
project's own "loading = layout-stable skeletons" rule
(`apps/web/src/lib/motion.ts` + `styles.css` `.skeleton-crossfade` pattern).
The vertical re-flow also displaces any content below the card (there is
none today, but the moment a second card or footer is added it will jump).

**Fix.** Reserve the slot with `min-h` and match the org route's container
discipline, dropping the redundant `overflow-x-auto` (Clerk's UserProfile
handles its own responsive navbar):

```tsx
<Card className="overflow-hidden">
  <CardHeader>
    <CardTitle>Account</CardTitle>
    <CardDescription>
      Profile, security, and connected accounts via Clerk.
    </CardDescription>
  </CardHeader>
  <CardContent className="p-0 sm:p-2">
    <div className="min-h-[28rem] w-full overflow-hidden rounded-lg">
      <UserProfile
        routing="hash"
        appearance={{
          theme: shadcn,
          elements: {
            rootBox: "w-full mx-auto",
            cardBox: "w-full shadow-none h-full",
            card: "w-full shadow-none h-full",
            navbar: "border-border",
            scrollBox: "w-full",
          },
        }}
      />
    </div>
  </CardContent>
</Card>
```

`min-h-[28rem]` mirrors `org/index.tsx`; tune the value to UserProfile's
loaded height. The `h-full` appearance keys stretch Clerk's card to fill the
reserved slot so the skeleton and the loaded state share a frame.

---

### [SEV: P3] Active tab underline indicator hard-pops with no enter/exit transition

**Location** — `apps/web/src/routes/app/settings.tsx:42-52`

```tsx
<Link
  key={tab.to}
  to={tab.to}
  className={cn(
    "relative rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-[var(--dur-instant)] ease-[var(--ease)]",
    active
      ? "text-foreground"
      : "text-muted-foreground hover:text-foreground",
  )}
>
  {tab.title}
  {active ? (
    <span
      className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-primary"
      aria-hidden
    />
  ) : null}
</Link>
```

**Problem.** The text color transitions smoothly via
`transition-colors duration-[var(--dur-instant)] ease-[var(--ease)]`, but
the underline indicator itself is conditionally mounted/unmounted
(`{active ? <span … /> : null}`) with **no** transition class. It pops in and
out instantly on tab change. This is inconsistent with the project's
motion-first convention: `apps/web/src/lib/motion.ts` exports `DUR.fast`
explicitly for "tab switches, list item enter", `apps/web/src/styles.css`
defines `--dur-fast` for the same purpose, and the router applies a
`nav-swap` view-transition (`--dur-fast`) to the outlet content. The tab
indicator is the one piece of chrome that doesn't honor the convention.

The canonical fix is a shared-element morph: a single indicator that
animates between tabs via `view-transition-name` (CSS) or Motion's
`layoutId` (the project already loads `LazyMotion` + `domAnimation` in
`router.tsx:80-84`). Even a cheap CSS approach — keep the span always
mounted and animate `opacity`/`scale-x` — would match the `--dur-fast`
cadence.

**Impact.** Cosmetic; the indicator's pop is jarring against the otherwise
smooth `--dur-fast` nav-swap of the outlet. No functional defect.

**Fix.** Always mount the indicator and drive its visibility off the
`data-status` attribute (pairs with the P2 fix above):

```tsx
<span
  className="absolute inset-x-1 -bottom-px h-0.5 origin-left rounded-full bg-primary opacity-0 transition-opacity duration-[var(--dur-fast)] ease-[var(--ease)] data-[status=active]:opacity-100"
  data-status={active ? "active" : "inactive"}
  aria-hidden
/>
```

Or, for a true morph, give the active indicator a stable
`view-transition-name` (e.g. `settings-tab-indicator`) and let the View
Transitions API animate it between tabs — the router already invokes
`markViewTransitionActive()` for nav-swap, so the snapshot is free.

---

### [SEV: P3] Unreachable trailing-slash branch in active detection (verified)

**Location** — `apps/web/src/routes/app/settings.tsx:32`

```tsx
const active = tab.exact
  ? pathname === tab.to || pathname === `${tab.to}/`
  : pathname === tab.to || pathname.startsWith(`${tab.to}/`);
```

**Problem.** Verified. The router sets no `trailingSlash` option
(`apps/web/src/router.tsx`), so TanStack's default `'never'` canonicalizes
`location.pathname` without a trailing slash. `pathname === \`${tab.to}/\``
therefore never matches; the `||` operand is dead. The
`pathname.startsWith(\`${tab.to}/\`)` arm in the non-exact branch already
covers every descendant, so the exact tab is correctly identified by
`pathname === tab.to` alone.

**Impact.** None functionally — defensive but unreachable code. Misleads
future readers into thinking trailing-slash URLs are possible here.

**Fix.** Drop the trailing-slash operand (or, per the P2 fix, delete the
manual `active` computation entirely):

```tsx
const active = tab.exact
  ? pathname === tab.to
  : pathname === tab.to || pathname.startsWith(`${tab.to}/`);
```

---

### [SEV: P3] `settings/index.tsx` Card chrome duplicates the org route's container without the mitigation

**Location** — `apps/web/src/routes/app/settings/index.tsx:31-50` (full
Card); compare `apps/web/src/routes/app/org/index.tsx:93-98`.

**Problem.** The settings index wraps `<UserProfile>` in a full
`Card`/`CardHeader`/`CardContent` stack, while the org route wraps
`<OrganizationProfile>` in a bare `min-h-[28rem] w-full overflow-hidden
rounded-xl border bg-card` div. The `Card` component already renders
`rounded-xl border bg-card text-card-foreground` (stock shadcn), so the
settings index is effectively double-wrapping: Card border + CardContent
padding around a Clerk component that already renders its own card. The
`appearance.elements` overrides (`cardBox: "w-full shadow-none"`,
`card: "w-full shadow-none"`) confirm the author had to fight Clerk's own
card chrome to make it fit — a signal that the Card wrapper is redundant.

The cleaner pattern is the org route's: drop the `Card`/`CardHeader`/
`CardContent` wrapper, use a bare reserved-height container, and let
Clerk's `shadcn` theme provide the card visuals (it already matches the
design system via `@clerk/ui/themes/shadcn.css` imported in
`styles.css:2`). The "Account" title + description can live in a simple
header `<div>` above the container, mirroring how `org/index.tsx` renders
its `<h1>` + `<p>` above the OrganizationProfile container.

**Impact.** Cosmetic + redundant DOM. The double-card (shadcn Card +
Clerk's internal card with shadow stripped) is visually fine but adds
unnecessary nesting and forced the `shadow-none` overrides. Not a
functional defect.

**Fix.** Align with the org route's container pattern:

```tsx
function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Account, keys, and activity.
        </p>
      </div>
      <div>
        <h2 className="text-lg font-semibold">Account</h2>
        <p className="text-sm text-muted-foreground">
          Profile, security, and connected accounts via Clerk.
        </p>
      </div>
      <div className="min-h-[28rem] w-full overflow-hidden rounded-xl border bg-card">
        <UserProfile
          routing="hash"
          appearance={{ theme: shadcn }}
        />
      </div>
    </div>
  );
}
```

This deletes the `Card`/`CardContent` imports, the `p-0 sm:p-2` hack, the
`overflow-x-auto` wrapper, and all six `appearance.elements` overrides —
Clerk's shadcn theme handles the rest. The `min-h-[28rem]` also fixes the
P2 CLS finding above in the same edit.

---

### Note: Stale org context after switch — N/A for this pair

The task asked to check for stale org context after an org switch. Neither
file in this pair reads org-scoped data:

- `settings.tsx` (layout) reads only `useRouterState({ select: (s) =>
  s.location.pathname })` — purely pathname-driven nav state, no org
  dependency. Switching orgs does not change `pathname`, so the layout is
  inert to org switches.
- `settings/index.tsx` renders `<UserProfile>` which is **user-scoped**
  (Clerk user, not Clerk org). `useOrganization` is not called here, so
  there is no org context to go stale. The `<UserProfile>` content re-renders
  on user changes (Clerk's reactive store), not org changes.

The stale-org risk lives in the *siblings*: `settings/keys.tsx` and
`settings/activity.tsx`, both of which call `useOrganization()` + Convex
queries keyed off `orgSlug`. Those are reviewed in
`reviews/apps.web.src.routes.app.settings.keys.tsx.md` and
`reviews/apps.web.src.routes.app.settings.activity.tsx.md` respectively.
Flagging here only to record that the angle was checked and dismissed for
this pair.

---

## Summary

**Counts:** P0: 0 · P1: 0 · P2: 2 · P3: 3

**Top 3 to fix first:**

1. **Stop the aria-current leak on the Overview tab** (P2) — pass
   `activeOptions={{ exact: tab.exact }}` at minimum, or (preferred) cutover
   to the `activeProps`/`data-[status=active]` pattern already used in
   `admin-header.tsx` so TanStack owns active detection and the manual
   `pathname` selector is deleted entirely.
2. **Reserve height for `<UserProfile>`** (P2) — add `min-h-[28rem]` to the
   wrapper (matching `org/index.tsx`) to eliminate the three-stage CLS on
   bundle-load → skeleton → data-paint. This folds cleanly into the P3
   Card-chrome cleanup.
3. **Animate the tab indicator** (P3) — always-mount + `data-status`-driven
   opacity, or a `view-transition-name` morph between tabs, so the indicator
   honors the `--dur-fast` cadence the rest of the nav already uses.

**Cross-cutting note:** the P2 aria-current fix and the P3 indicator-animation
fix are the same edit — adopting `activeProps`/`data-status` and an
always-mounted indicator kills both birds with one cutover. Likewise the P2
CLS fix and the P3 Card-chrome cleanup collapse into one container change.
Net: two edits resolve four of the five findings.

**Verified clean:** no raw Tailwind colors (all `bg-primary` /
`text-foreground` / `text-muted-foreground` / `border-border`), no hardcoded
motion values (`--dur-instant` / `--ease` CSS vars, defined in
`styles.css:48-52`), no `isPending`/`isLoading` misuse (no mutations or
queries in either file), no leaked errors (no try/catch, no error surface),
no missing view-transition (sub-nav swaps ride the router's
`defaultViewTransition` → `nav-swap` per `router.tsx:64-83`, fast-scoped to
`--dur-fast` in `styles.css:192-198`), `prefers-reduced-motion` respected at
the stylesheet level (`styles.css` media block kills transforms and
view-transitions; the only motion in this pair is a 150ms color transition,
which is safe). `routing="hash"` + `shadcn` theme pattern is consistent with
`org/index.tsx`.
