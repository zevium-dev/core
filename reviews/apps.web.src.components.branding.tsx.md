# Tiger Review — Branding & Theme Components

**Files reviewed:**
- `apps/web/src/components/brand-mark.tsx`
- `apps/web/src/components/public-header.tsx`
- `apps/web/src/components/theme-provider.tsx`
- `apps/web/src/components/theme-toggle.tsx`

**Patches spanned:** `0893c6e` (wave 1 — theme system), `9411901` (motion tokens), `aebbc75` (brand mark).

---

## Verdict

**Correct — no blockers, no correctness bugs.** Two minor nits (P3) below.
FOUC prevention is sound: `__root.tsx` ships a head-level `themeInitScript`
that sets the `dark` class + `color-scheme` before first paint, matching the
`ThemeProvider`'s `storageKey="zevium-theme"` / `defaultTheme="system"` /
`attribute="class"` config. `suppressHydrationWarning` on `<html>` covers the
class/style mutation. No raw Tailwind colors, no XSS surface, no dead code,
no hardcoded motion values (all transitions use `--dur-*` / `--ease` vars).

---

## File Stats

| File | Lines | Findings |
|---|---|---|
| `brand-mark.tsx` | 17 | 0 |
| `public-header.tsx` | 87 | 0 |
| `theme-provider.tsx` | 18 | 1 |
| `theme-toggle.tsx` | 44 | 1 |

---

## Findings

### [P3] `theme-provider.tsx:5-16` — `{...props}` spread after enforced props permits `storageKey` override, desyncing from the head FOUC script

```tsx
export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="zevium-theme"
      {...props}
    >
```

**Problem:** The `{...props}` spread is positioned *after* the enforced
props, so any caller can override `storageKey` (or `attribute`, `defaultTheme`,
`enableSystem`). `__root.tsx` hardcodes the FOUC-prevention script to
`'zevium-theme'`:

```js
const themeInitScript = `(function(){try{var k='zevium-theme';var t=localStorage.getItem(k);...`;
```

If a future caller passes `<ThemeProvider storageKey="other">`, the head
script reads/writes `zevium-theme` while next-themes reads/writes `other`:
the dark class set by the head script and the class next-themes believes
it owns diverge, producing a first-paint flash of the wrong theme and a
mismatched toggle state. The two values are coupled across files with no
single source of truth.

**Impact:** Latent — no current caller overrides the prop (ThemeProvider is
mounted once in `__root.tsx` with no extra props). Breaks silently on first
override.

**Fix:** Spread first so enforced props always win, or drop the spread
entirely if the wrapper is meant to be a fixed-config boundary:

```tsx
    <NextThemesProvider
      {...props}
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="zevium-theme"
    >
```

**Confidence:** 0.55

---

### [P3] `theme-toggle.tsx:27-43` — Sun/Moon icon transform transition not gated by `prefers-reduced-motion`

```tsx
      <Sun
        className={cn(
          "size-4 transition-[transform,opacity] duration-[var(--dur-instant)] ease-[var(--ease)]",
          isDark
            ? "rotate-90 scale-0 opacity-0"
            : "rotate-0 scale-100 opacity-100",
        )}
      />
      <Moon
        className={cn(
          "absolute size-4 transition-[transform,opacity] duration-[var(--dur-instant)] ease-[var(--ease)]",
          isDark
            ? "rotate-0 scale-100 opacity-100"
            : "-rotate-90 scale-0 opacity-0",
        )}
      />
```

**Problem:** On toggle, the outgoing icon rotates 90° and scales to 0 while
the incoming icon rotates in from −90° and scales up — a 150ms transform
animation. The global `@media (prefers-reduced-motion: reduce)` block in
`styles.css` only neutralizes `.content-enter`, view-transitions,
`.group-hover:-translate-y-0.5`, `.group-active:scale-[0.98]`,
`.active:scale-[0.97]`, and `.animate-pulse`. It does **not** cover
`transition-[transform,opacity]`, so users who requested reduced motion
still get an icon spin on every theme toggle. The project's stated UI rules
include `prefers-reduced-motion`, and `button.tsx` already uses the
`motion-reduce:` variant (`motion-reduce:active:scale-100`), so the pattern
is established in-repo.

**Impact:** Vestibular discomfort for reduced-motion users on an explicitly
user-triggered animation. Non-blocking.

**Fix:**

```tsx
      <Sun
        className={cn(
          "size-4 transition-[transform,opacity] duration-[var(--dur-instant)] ease-[var(--ease)] motion-reduce:transition-none",
          isDark
            ? "rotate-90 scale-0 opacity-0"
            : "rotate-0 scale-100 opacity-100",
        )}
      />
      <Moon
        className={cn(
          "absolute size-4 transition-[transform,opacity] duration-[var(--dur-instant)] ease-[var(--ease)] motion-reduce:transition-none",
          isDark
            ? "rotate-0 scale-100 opacity-100"
            : "-rotate-90 scale-0 opacity-0",
        )}
      />
```

**Confidence:** 0.6

---

## Summary

| Severity | Count |
|---|---|
| P0 | 0 |
| P1 | 0 |
| P2 | 0 |
| P3 | 2 |

**Top issues:**
1. `theme-provider.tsx` — `{...props}` after enforced props lets `storageKey`
   override desync from the head FOUC script (latent).
2. `theme-toggle.tsx` — icon swap transform transition not gated by
   `prefers-reduced-motion`.

**What was checked and found clean:** FOUC (head script + `attribute="class"`
+ `suppressHydrationWarning` — correct), hydration mismatch (`mounted` gate
in `ThemeToggle` matches SSR output — correct), raw Tailwind colors (none —
all `text-foreground` / `text-muted-foreground` / `bg-primary` etc.), hardcoded
motion values (none — all `var(--dur-instant)` / `var(--ease)`), XSS (no user
input; `themeInitScript` is a static string; BrandMark paths are static),
dead code (none — `className` prop on `ThemeToggle` is unused by current
callers but is the standard `cn()` extension point, not dead code), BrandMark
a11y (`aria-hidden="true"` with text label in every host — correct),
Moon icon `absolute` positioning (static-position centering via flex
`justify-center` — correct shadcn pattern), `min-w-[9.5rem]` auth slot (both
Sign-in ≈97px and Dashboard+UserButton ≈127px fit within 152px — no shift).
