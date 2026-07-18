# Tiger Review — `apps/web/src/routes/app/settings.tsx` + `apps/web/src/routes/app/settings/index.tsx`

## Verdict

**Incorrect** — one real accessibility defect (visual vs. accessible state divergence on the Overview tab) plus one minor dead branch. No raw Tailwind colors, no hardcoded motion values, no isPending misuse, no leaked errors, no stale org context (neither file holds org-scoped data), no missing view-transition (router-level `defaultViewTransition` covers sub-nav swaps as `nav-swap`).

## File Stats

| File | Lines | Findings |
|---|---|---|
| `apps/web/src/routes/app/settings.tsx` | 59 | 2 |
| `apps/web/src/routes/app/settings/index.tsx` | 57 | 0 |

## Findings

### [P2] Overview tab announces `aria-current="page"` on every settings sub-route

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

**Problem.** The visual `active` flag is computed manually with `tab.exact`, so the Overview tab (`to: "/app/settings"`, `exact: true`) is underlined only on `/app/settings`. But the `<Link>` is a TanStack Router `Link`, which spreads `STATIC_ACTIVE_PROPS = { "data-status": "active", "aria-current": "page", className: "active" }` whenever its *own* `isActive` is true — and `isActive` defaults to `activeOptions.exact === false`. Confirmed in `node_modules/.../react-router/dist/esm/link.js:381` (`"aria-current": "page"` inside `STATIC_ACTIVE_PROPS`, applied via `...isActive && STATIC_ACTIVE_PROPS`). The router does not set `trailingSlash`, so the default `'never'` applies and the Overview link resolves to the index route.

Consequence: on `/app/settings/keys` and `/app/settings/activity`, TanStack considers the Overview link active (those are descendants of `/app/settings`), so it emits `aria-current="page"` and `data-status="active"`, while the manual `active` branch styles it as inactive (muted, no underline). Screen-reader users hear "current page: Overview" when they are in fact on "API keys" or "Activity". Visual and accessible state disagree — a direct WCAG 4.1.2/4.1.3 concern.

The "API keys" and "Activity" tabs are unaffected because both the manual check and TanStack's default use `exact: false`, so they agree.

**Impact.** Wrong current-page announcement to assistive tech on two of the three tabs; also appends a stray `active` class (no-op under Tailwind v4, no `.active` rule exists) to the Overview link on every sub-route.

**Fix.** Align TanStack's active detection with the visual `exact` flag:

```tsx
return (
  <Link
    key={tab.to}
    to={tab.to}
    activeOptions={{ exact: tab.exact }}
    className={cn(
      "relative rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-[var(--dur-instant)] ease-[var(--ease)]",
      active
        ? "text-foreground"
        : "text-muted-foreground hover:text-foreground",
    )}
  >
```

This makes `aria-current`/`data-status` fire only when the manual `active` is true, restoring agreement. (Better still, drop the manual `pathname` check entirely and drive styling via `activeProps`/`inactiveProps` like `apps/web/src/components/admin-header.tsx:34` — but the one-line fix above is the minimal correct change.)

---

### [P3] Unreachable trailing-slash branch in active detection

**Location** — `apps/web/src/routes/app/settings.tsx:32`

```tsx
const active = tab.exact
  ? pathname === tab.to || pathname === `${tab.to}/`
  : pathname === tab.to || pathname.startsWith(`${tab.to}/`);
```

**Problem.** With no `trailingSlash` option set on the router (`apps/web/src/router.tsx`), TanStack's default `'never'` canonicalizes `location.pathname` without a trailing slash. `pathname === \`${tab.to}/\`` therefore never matches; the `||` operand is dead. The `pathname.startsWith(\`${tab.to}/\`)` arm in the non-exact branch already covers every descendant, so the exact tab is correctly identified by `pathname === tab.to` alone.

**Impact.** None functionally — defensive but unreachable code. Slightly misleads future readers into thinking trailing-slash URLs are possible here.

**Fix.** Drop the trailing-slash operand:

```tsx
const active = tab.exact
  ? pathname === tab.to
  : pathname === tab.to || pathname.startsWith(`${tab.to}/`);
```

---

## Summary

- **2 findings** — P2: 1, P3: 1.
- **Top issue:** the Overview settings tab leaks `aria-current="page"` (and `data-status="active"`) onto every `/app/settings/*` sub-route because TanStack `<Link>`'s built-in active detection runs `exact: false` while the visual styling uses a manual `exact: true` check. Fix by passing `activeOptions={{ exact: tab.exact }}` (or by switching to `activeProps`/`inactiveProps` like `admin-header.tsx`).
- **Secondary:** dead `pathname === \`${tab.to}/\`` branch given the router's default `trailingSlash: 'never'`.
- No raw Tailwind colors (all `bg-primary` / `text-foreground` / `text-muted-foreground`), no hardcoded motion values (`--dur-instant` / `--ease` CSS vars, defined in `apps/web/src/styles.css:48-52`), no isPending/isLoading misuse (no mutations or queries in either file), no leaked errors (no try/catch), no stale org context (neither file reads org-scoped data; `<UserProfile>` in `settings/index.tsx` is user-scoped and mirrors the `routing="hash"` + `shadcn` theme pattern already used by `apps/web/src/routes/app/org/index.tsx:94-97`), no missing view-transition (sub-nav swaps ride the router's `defaultViewTransition` → `nav-swap` fast-swap per `apps/web/src/router.tsx:64-83`).
