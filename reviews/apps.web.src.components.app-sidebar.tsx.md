# Tiger Review — `apps/web/src/components/app-sidebar.tsx`

## Verdict

Incorrect — two real UX/navigation defects (mobile Sheet never closes on tap; two of eight nav items unmount the sidebar by leaving the `/app` shell) plus three a11y/IA nits. No data-corruption, auth, or state-persistence bug in this file; the sidebar itself owns no mutation, no error path, and no async state, so the `isPending`/leaked-error/raw-color/motion rules are satisfied by absence. `useActiveOrgSlug` is consumed by `notification-bell.tsx`, not here, so the org-switch race does not manifest in the sidebar — the prebuilt `OrganizationSwitcher` manages its own Clerk context. `convex/organizations.ts` is covered by its own dedicated review (`reviews/convex.organizations.ts.md`) and is not re-litigated.

## File Stats

- File: `apps/web/src/components/app-sidebar.tsx` (108 lines)
- Supporting context: `apps/web/src/hooks/use-active-org-slug.ts` (15 lines), `convex/organizations.ts` (169 lines)
- Mount point: `apps/web/src/routes/app.tsx:55-66` (the only route that renders `SidebarProvider` + `AppSidebar`)
- Findings: 5 (P2: 2, P3: 3)

## Findings

### [P2] Mobile sidebar Sheet does not close on navigation; close button is also hidden

**Location** — `app-sidebar.tsx:44, 75-92` (no `setOpenMobile` wiring); primitive `apps/web/src/components/ui/sidebar.tsx:185-201` (`SheetContent` with `[&>button]:hidden`); `ui/sidebar.tsx:70` (`openMobile` state).

```tsx
export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  …
                  <SidebarMenuButton
                    asChild
                    isActive={active}
                    tooltip={item.title}
                  >
                    <Link to={item.to}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
```

**Problem.** On mobile (`useIsMobile()` true) the `Sidebar` renders as a radix `Sheet` whose `open` is driven solely by `openMobile` in `SidebarProvider` (`ui/sidebar.tsx:70, 185`). Nothing in `AppSidebar` — nor anywhere else in the repo (grep for `setOpenMobile(false)` returns only the context definition) — calls `setOpenMobile(false)` when a nav item is tapped. The `Link` click changes the route under the sheet, but `openMobile` stays `true`, so the sheet keeps covering the freshly-loaded page. Worse, `SheetContent` ships `[&>button]:hidden` (`ui/sidebar.tsx:188` area), which removes the radix close (X) button — the only remaining dismiss affordance is tapping the backdrop. So every mobile navigation costs two taps (tap item → tap backdrop), and the `AppHeader` `SidebarTrigger` that opened the sheet is itself covered by the overlay and cannot be used to close it.

**Impact.** Broken mobile nav flow; the standard shadcn pattern (close the sheet on item select) is missing. Hits every mobile user on every nav tap. Not a desktop regression — desktop uses the fixed rail, not the sheet.

**Fix.** Pull `setOpenMobile` from `useSidebar()` and close on click; `SidebarMenuButton asChild` forwards the handler to the `Link`.

```suggestion
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "#/components/ui/sidebar";

…

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { setOpenMobile } = useSidebar();
```

```suggestion
                      <Link to={item.to} onClick={() => setOpenMobile(false)}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
```

---

### [P2] `/catalogue` and `/docs` nav items leave the `/app` shell — sidebar unmounts on tap

**Location** — `app-sidebar.tsx:21-30` (nav items); `apps/web/src/routes/app.tsx:55-66` (only mount of `AppSidebar`); `apps/web/src/routes/catalogue.tsx:1-11` (`createFileRoute("/catalogue")` → `<Outlet/>`, no sidebar); `apps/web/src/routes/docs/index.tsx:3-7` (`createFileRoute("/docs/")` → `DocsPage`, no sidebar).

```tsx
const navItems = [
  { title: "Dashboard", to: "/app", icon: LayoutDashboard, exact: true },
  { title: "Catalogue", to: "/catalogue", icon: BookOpen, exact: false },
  { title: "Projects", to: "/app/projects", icon: FolderKanban, exact: false },
  { title: "Organization", to: "/app/org", icon: Building2, exact: false },
  { title: "Billing", to: "/app/billing", icon: CreditCard, exact: false },
  { title: "Earnings", to: "/app/earnings", icon: Banknote, exact: false },
  { title: "Settings", to: "/app/settings", icon: Settings, exact: false },
  { title: "Docs", to: "/docs", icon: BookText, exact: false },
] as const;
```

**Problem.** Six of the eight items point inside `/app` (where `AppSidebar` is mounted). Two — `Catalogue` (`/catalogue`) and `Docs` (`/docs`) — point to top-level routes that render only `<Outlet/>` / `DocsPage` and do NOT mount `SidebarProvider` + `AppSidebar`. Tapping either one navigates the user out of the app shell: the sidebar they just tapped disappears, the `AppHeader` breadcrumb and trigger disappear, and the only way back is the browser back button or a manual `/app` URL. There is no visual signal on those two items that they behave differently from the six in-shell items. Additionally, the `active` computation for `/catalogue` and `/docs` is unreachable in practice: the sidebar is not rendered on those routes, so the `data-active` highlight for them is never observable — dead styling.

**Impact.** Inconsistent IA: most sidebar items preserve the shell, two silently destroy it. A user tapping "Catalogue" to browse APIs loses their navigation context and must re-navigate to return. Catalogue/Docs being public routes is fine; surfacing them from the authed sidebar as if they were in-app routes is the defect.

**Fix.** Either (a) render `SidebarProvider` + `AppSidebar` on `/catalogue` and `/docs` so the shell persists (preferred if those routes are meant for authed users too), (b) nest them under `/app/catalogue` and `/app/docs` so they inherit the shell, or (c) if they must stay public/top-level, mark them as external with a visual cue (e.g. `ExternalLink` icon, `target="_blank"`, `rel="noreferrer"`) so leaving the shell is intentional and signaled rather than surprising.

---

### [P3] `OrganizationSwitcher` is hidden in icon-collapse mode with no compact replacement

**Location** — `app-sidebar.tsx:54-61` (switcher wrapper `group-data-[collapsible=icon]:hidden`); `app-sidebar.tsx:46` (`<Sidebar collapsible="icon" variant="inset">`).

```tsx
<div className="px-1 group-data-[collapsible=icon]:hidden">
  <OrganizationSwitcher
    appearance={{ theme: shadcn }}
    afterSelectOrganizationUrl="/app"
    afterCreateOrganizationUrl="/app"
    hidePersonal={false}
  />
</div>
```

**Problem.** `collapsible="icon"` lets the desktop sidebar collapse to a 3rem rail (via rail drag or `Cmd/Ctrl+B`). When collapsed, the `group-data-[collapsible=icon]:hidden` wrapper removes the `OrganizationSwitcher` entirely, and the header shows only the `BrandMark`. There is no compact org avatar or switcher in its place, so a desktop user who collapses the sidebar loses all org-switching affordance from the sidebar and must expand it again to switch orgs — even though org switching is the primary action the header exists to host.

**Impact.** Minor but real desktop UX gap; org switching is a load-bearing action and it vanishes in the collapsed state the layout explicitly supports.

**Fix.** Render a compact avatar-only `OrganizationSwitcher` (or a single-button `UserButton`-style org avatar) that stays visible when `group-data-[collapsible=icon]`, opening the full switcher in a popover on click; or pin an org avatar button in the footer that re-expands the sidebar.

---

### [P3] Active nav item has no `aria-current="page"`

**Location** — `app-sidebar.tsx:74-84`; primitive `ui/sidebar.tsx:511-521` (`SidebarMenuButton` sets `data-active={isActive}` only).

```tsx
const active = item.exact
  ? pathname === item.to
  : pathname === item.to || pathname.startsWith(`${item.to}/`);
…
<SidebarMenuButton asChild isActive={active} tooltip={item.title}>
  <Link to={item.to}>
```

**Problem.** `SidebarMenuButton` consumes `isActive` to set `data-active` (a styling hook) and never sets `aria-current`. The `Link` receives no `aria-current` either. Screen-reader users navigating by "current page" landmark get no signal for which of the eight items represents the page they are on; the active state is purely visual. `data-active` is not an a11y attribute.

**Impact.** A11y gap: blind/low-vision users cannot identify the current page in the sidebar. Easy fix; `SidebarMenuButton asChild` forwards props to the `Link` via `Slot.Root`.

**Fix.**

```suggestion
                      <Link
                        to={item.to}
                        aria-current={active ? "page" : undefined}
                        onClick={() => setOpenMobile(false)}
                      >
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
```

---

### [P3] Sidebar menu has no `<nav>` landmark

**Location** — `app-sidebar.tsx:64-98` (`SidebarContent` → `SidebarGroup` → `SidebarGroupLabel` "Navigate" → `SidebarMenu` `<ul>`); primitive `ui/sidebar.tsx` does not wrap menu in `<nav>`.

**Problem.** The primary navigation is a `<ul>` inside `SidebarGroup` inside `SidebarContent`; there is no `<nav>` element wrapping it. The `SidebarGroupLabel` "Navigate" is a visible `<div>`, not an accessible name on a landmark. Screen-reader users cannot jump to "main navigation" via the rotor/landmark shortcut; they must tab through the entire sidebar.

**Impact.** A11y gap; landmark navigation is unavailable for the app's primary nav. The "stock shadcn unmodified" rule applies to the primitive, but the landmark wrapper is the consumer's responsibility at the composition site.

**Fix.** Wrap the group (or the whole `SidebarContent`) in `<nav aria-label="Main navigation">`.

```suggestion
      <SidebarContent>
        <nav aria-label="Main navigation">
          <SidebarGroup>
            <SidebarGroupLabel>Navigate</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => {
```

---

## Summary

- 5 findings: **P2 ×2, P3 ×3**. No P0/P1.
- Top issues:
  1. **[P2]** Mobile `Sheet` never closes on nav tap and its close button is hidden — every mobile navigation costs two taps (item → backdrop); the open/close `SidebarTrigger` in `AppHeader` is covered by the overlay and can't close it.
  2. **[P2]** `/catalogue` and `/docs` are top-level routes that don't mount `AppSidebar`, so tapping those two sidebar items unmounts the sidebar entirely; their `active` highlighting is also unreachable dead styling.
  3. **[P3]** `OrganizationSwitcher` vanishes in icon-collapse mode with no compact replacement, leaving no org-switch affordance in the collapsed state the layout supports.

- **Not flagged (verified clean):**
  - **Raw Tailwind colors** — only `bg-primary text-primary-foreground` semantic tokens on the brand container (`app-sidebar.tsx:51`); all chrome colors come from the `sidebar` primitive's semantic tokens (`bg-sidebar`, `text-sidebar-foreground`, `bg-sidebar-accent`, etc.). No raw `bg-*`/`text-*` color utilities.
  - **Hardcoded motion values** — `AppSidebar` declares no `motion`/`transition`/`duration` literals; the primitive's `transition-[width,height,padding]` and `duration-[var(--dur-base)] ease-[var(--ease)]` reference the project's CSS motion vars (`ui/sidebar.tsx:399, 432`). `ThemeToggle` (rendered in the footer) uses `duration-[var(--dur-instant)]` from the same var set.
  - **`isPending` misuse** — the component owns no mutation/query; `useRouterState` is a synchronous selector with no pending state. No `isLoading` anywhere in the file.
  - **Leaked errors** — no `try/catch`, no thrown errors, no mutation error paths; `OrganizationSwitcher` and `UserButton` are Clerk prebuilt components that handle their own error states internally.
  - **Missing skeletons** — the nav is static (no async data); `OrganizationSwitcher`/`UserButton` render Clerk's built-in loading placeholders while Clerk bootstraps. No layout-stable skeleton gap here.
  - **Missing view-transition** — sidebar → route nav is page nav, not list→detail, so the view-transition-morph rule does not apply.
  - **Dead code** — all eight `lucide-react` icon imports (`LayoutDashboard`, `BookOpen`, `FolderKanban`, `Building2`, `CreditCard`, `Banknote`, `Settings`, `BookText`) are referenced in `navItems`; all sidebar primitive imports are used; `useRouterState` and `Link` are used.
  - **Sidebar state persistence** — the `sidebar_state` cookie write/read asymmetry lives in `ui/sidebar.tsx` / the `SidebarProvider` mount in `app.tsx:55` (no `defaultOpen` derived from the cookie), not in `app-sidebar.tsx`; out of scope for this file and not introduced here.
  - **Org-switch race** — `AppSidebar` does not consume `useActiveOrgSlug` (grep confirms the only consumer is `apps/web/src/components/notification-bell.tsx:75`); it delegates org context to the prebuilt `OrganizationSwitcher`, which manages its own Clerk org state and redirects via `afterSelectOrganizationUrl="/app"`. No stale-context surface in this file. `convex/organizations.ts` is covered by `reviews/convex.organizations.ts.md` (including the `getBySlug` public-query and slug-validation findings) and is intentionally not re-litigated here.
