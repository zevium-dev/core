# Tiger Review — `apps/web/src/lib/motion.ts` + `vt.ts` + `components/motion/*`

Scope: `lib/motion.ts`, `lib/vt.ts`, `components/motion/reveal.tsx`,
`components/motion/fade-in.tsx`, `components/motion/magnetic.tsx`,
`components/motion/number-ticker.tsx`. Cross-checked against `styles.css`
(motion tokens), `router.tsx` (VT `types` callback + `LazyMotion strict`),
and all call sites in `routes/`.

## Verdict

Motion foundation is mostly coherent (single `EASE`, `DUR` ladder, reduced-motion
short-circuits, VT-aware entrance skip), but the foundation file is a lie — the
values live in TWO places (`motion.ts` AND `styles.css`) with no derivation, and
`NumberTicker` has a real retargeting bug plus an SSR locale hydration mismatch.
`vt.ts` has a plausible first-paint hydration hazard. No P0.

## File Stats

| File | LOC | Findings |
|---|---|---|
| `lib/motion.ts` | 19 | 4 |
| `lib/vt.ts` | 33 | 3 |
| `components/motion/reveal.tsx` | 47 | 2 |
| `components/motion/fade-in.tsx` | 34 | 2 |
| `components/motion/magnetic.tsx` | 68 | 3 |
| `components/motion/number-ticker.tsx` | 103 | 5 |
| **Total** | — | **19** |

## Findings

### [P1] `NumberTicker`: rapid value changes snap-jump instead of retargeting

`apps/web/src/components/motion/number-ticker.tsx:80-86`

```ts
return () => {
  if (frameRef.current !== null) {
    cancelAnimationFrame(frameRef.current);
  }
  fromRef.current = to;   // ← bug
};
```

The cleanup writes `fromRef.current = to` (the *target* of the just-cancelled
animation), not the current displayed value. When `value` changes mid-animation
the next effect run reads `from = fromRef.current` (= new `to`), hits
`if (from === to) { setDisplay(to); return; }`, and snaps to the final value
with zero animation.

**Impact**: `NumberTicker` is wired to Convex-realtime fields
(`overview.balance` in `app/index.tsx:137`, `billing.wallet.balance` in
`billing.tsx:124`, `analytics.calls`/`analytics.credits` in
`projects/$projectSlug.tsx:455,463`). Realtime balance bumps that arrive while
a previous count-up is still running will jump-cut to the new total instead of
smoothly retargeting — the exact scenario the component exists to make pretty.
For a credits-marketplace balance, this is visible financial-UI jitter.

**Fix**: capture the in-flight displayed value, not the target. Either store
`display` in a ref synced each tick (`displayRef.current = next`), or read the
live `display` state at cleanup time via a ref. In cleanup set
`fromRef.current = displayRef.current` so the next animation continues from
where the user actually sees it.

---

### [P1] `NumberTicker`: SSR/client locale hydration mismatch via `toLocaleString(undefined, …)`

`apps/web/src/components/motion/number-ticker.tsx:19-23`

```ts
function defaultFormat(n: number, decimals: number): string {
  return n.toLocaleString(undefined, {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
}
```

`undefined` locale → host default. On the Node SSR pass that is whatever ICU
the runtime was built with (typically `en-US`, producing `1,234.5`); on the
client it is the browser locale (e.g. `de-DE` → `1.234,5`, `fr-FR` →
`1 234,5`). `text` is rendered into the SSR HTML and again at hydration, so
the two strings diverge → React hydration warning + forced reconcile flicker
on every non-`en-US` client.

**Impact**: hydration warnings + a visible number reformat flash on first
paint for any user whose browser locale doesn't match Node's ICU default.
`NumberTicker` is used on every dashboard / billing / admin stat card.

**Fix**: pin the locale explicitly (e.g. `"en-US"`) on both server and client,
or route formatting through a single `formatNumber` helper that takes the
locale from a stable source (not `undefined`). At minimum pass `"en-US"` so
SSR and CSR agree.

---

### [P1] `vt.ts`: `vtState.active` set synchronously in the router `types` callback — first-paint hydration hazard

`apps/web/src/lib/vt.ts:8-15` + `apps/web/src/router.tsx:64-67`

```ts
export const vtState = { active: false };
export function markViewTransitionActive() {
  vtState.active = true;
  if (typeof document === "undefined") return;   // SSR: flag left TRUE, never cleared
  ...
}
```

```ts
defaultViewTransition: {
  types: ({ fromLocation, toLocation }) => {
    markViewTransitionActive();   // fires on navigation
    ...
  }
}
```

Two distinct problems:

1. **SSR path is a trap.** The `typeof document === "undefined"` guard fires
   *after* `vtState.active = true` is already set, so if the `types` callback
   is ever evaluated during SSR route resolution the flag is latched `true`
   with no timer/listener to clear it. Every Reveal/FadeIn rendered on that
   SSR pass sees `skip = true` and emits `initial={false}` (no `opacity:0`).
   The client re-initializes the module to `false` and renders
   `initial={{opacity:0}}` → React hydration mismatch on the inline
   `style="opacity:0; transform:..."` that motion emits during SSR.

2. **Client initial-load window.** Even when `types` only fires client-side, it
   fires synchronously at navigation start and `active` stays `true` for
   ~400–600 ms (cleared by `viewtransitionend` or the 600 ms fallback). If a
   route's first paint happens inside that window, components hydrate with
   `skip=true` (opacity 1) while the SSR HTML they were generated from had
   `skip=false` (opacity 0, via motion's `initial` inline style). The same
   attribute mismatch as above, just driven from the client side.

   [INFERENCE] Whether `defaultViewTransition.types` actually runs during the
   SSR/initial-hydration pass depends on TanStack Router internals — I did not
   trace the router source — but the *defensive* fix is cheap and the failure
   mode is real either way.

**Impact**: hydration warnings + a flash where entrance-animated content
jumps from invisible (SSR) to visible (client) instead of animating in.
Hard to reproduce locally (en-US, fast machine, no VT) but trivial to hit on
a real client.

**Fix**: (a) guard *before* mutating — `if (typeof document === "undefined") return;`
at the top of `markViewTransitionActive`, and never set `vtState.active` on
the server. (b) Better: drive the skip decision off a `useViewTransitionState`
hook (or read `document.visibilityState` / the `viewtransition` event) so it's
inherently client-only and reactive, rather than a module singleton latched
synchronously during navigation.

---

### [P2] `motion.ts`: tokens duplicated between `motion.ts` and `styles.css` — drift is inevitable

`apps/web/src/lib/motion.ts:1-12` vs `apps/web/src/styles.css:62-69`

```ts
// motion.ts — "the only place these values live"
export const DUR = { instant: 0.15, fast: 0.25, base: 0.35, page: 0.4, slow: 0.6 } as const;
export const EASE = [0.16, 1, 0.3, 1] as const;
```

```css
/* styles.css */
--ease: cubic-bezier(0.16, 1, 0.3, 1);
--dur-instant: 150ms;
--dur-fast: 250ms;
--dur-base: 350ms;
--dur-page: 400ms;
--dur-slow: 600ms;
```

The header comment ("the only place these values live") is false: every value
exists twice, once in seconds (JS) and once in ms (CSS), with no shared
source. They happen to match today. The first time someone tunes `DUR.base`
and forgets `--dur-base`, JS-driven animations (Reveal, FadeIn, NumberTicker)
and CSS-driven ones (`content-enter`, `link-draw`, `skeleton-crossfade`,
sidebar width transition, sonner toast) drift apart silently.

**Impact**: silent desync between motion-lib animations and Tailwind/CSS
animations on the same tokens — exactly the class of bug a "design system
foundation" file is supposed to prevent.

**Fix**: pick one source of truth. Either (a) generate the CSS vars from the
JS at build time (e.g. inject `--dur-*` from `DUR` in a `:root` block built
from `motion.ts`), or (b) have `motion.ts` read from the CSS custom properties
at runtime (`getComputedStyle` is overkill) — but at minimum delete the false
comment and add a test that asserts `DUR[k] * 1000 === parseInt(--dur-k)`.

---

### [P2] `NumberTicker`: rolls its own `prefersReducedMotion()` instead of `useReducedMotion()`

`apps/web/src/components/motion/number-ticker.tsx:25-31, 50-53`

```ts
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
...
useEffect(() => {
  if (prefersReducedMotion()) { setDisplay(value); fromRef.current = value; return; }
```

`Reveal`, `FadeIn`, `Magnetic` all use `useReducedMotion()` from `motion/react`
(reactive, SSR-safe, LazyMotion-aware). `NumberTicker` re-implements it as a
local function read once per `useEffect` run. If a user toggles reduced-motion
at runtime (OS setting change without reload), the sibling components respect
it immediately; `NumberTicker` only picks it up on the next `value` change.

**Impact**: inconsistent reduced-motion behavior across components on the
same screen (billing dashboard mixes `NumberTicker` and `FadeIn`).

**Fix**: `const reduce = useReducedMotion();` and branch on `reduce` inside
the effect (add it to the dep array).

---

### [P2] `NumberTicker`: never animates on initial mount — "count-up" is a misnomer

`apps/web/src/components/motion/number-ticker.tsx:47, 55-58`

```ts
const [display, setDisplay] = useState(value);   // display === value on mount
const fromRef = useRef(value);
...
useEffect(() => {
  ...
  const from = fromRef.current;   // = value
  const to = value;
  if (from === to) { setDisplay(to); return; }   // always true on first run
```

On mount `display` initializes to `value`, `fromRef` to `value`, so the effect
short-circuits and renders the final number with no count-up. The component
only animates on *subsequent* `value` changes.

**Impact**: the JSDoc ("Count-up for credits balance / stats") and the very
name `NumberTicker` imply an entrance count-up; in practice the entrance is
static. Whether this is a bug or an intentional "don't count from 0 on every
page load" decision is unclear from the code — but either way the name/docs
are misleading. [INFERENCE — could be deliberate for balance UI]

**Fix**: if entrance count-up is desired, initialize `display` to `0` (or to
a `initialFrom` prop) and `fromRef` likewise, and let the effect run. If
intentional, rename / re-doc so the contract is explicit.

---

### [P2] `Reveal`: `whileInView` observer registered even when entrance is skipped

`apps/web/src/components/motion/reveal.tsx:34-47`

```ts
const skip = Boolean(reduce) || vtState.active;
const y = reduce ? 0 : distance;
...
<Comp
  initial={skip ? false : { opacity: 0, y }}
  whileInView={{ opacity: 1, y: 0 }}
  viewport={{ once: true, margin: "-60px" }}
  ...
/>
```

When `skip` is true, `initial={false}` makes the element render at its final
state — but `whileInView` + `viewport` are still attached, so motion still
creates an `IntersectionObserver` for an element that will never animate.
Wasteful per-instance, and worse: if the element is below the fold and JS is
disabled (or the observer never fires for some reason), the SSR HTML emitted
by motion's `initial` path is `opacity:0` with no fallback to reveal it.

Also: `margin: "-60px"` requires the element to be 60 px *into* the viewport
before triggering; on short viewports elements near the bottom may sit
invisible until scroll, which is fine for marketing (`Reveal` is only used on
the landing page per the call sites) but worth noting.

**Impact**: unnecessary observers in reduced-motion / VT-active states; tiny
but non-zero. The JS-disabled invisible-content risk is real for the landing
hero where `<Reveal>` wraps "How it works", "For agents", "Live catalogue"
sections — a no-JS visitor sees blank sections.

**Fix**: when `skip`, drop `whileInView`/`viewport` (conditionally spread).
For no-JS, add a `<noscript>` style that disables `opacity:0` initial states,
or gate the `opacity:0` initial behind a `motion-safe:` / `.js` class.

---

### [P2] `Magnetic`: persistent `will-change-transform` + no clamp on `strength`

`apps/web/src/components/motion/magnetic.tsx:60-65, 16-19`

```ts
type MagneticProps = {
  /** Pull strength 0–1; DESIGN.md caps ≤0.3. */
  strength?: number;
};
...
<m.div
  ref={ref}
  className={cn("inline-flex will-change-transform", className)}
  style={{ x, y }}
  ...
>
```

Two issues:

1. `will-change-transform` is applied unconditionally for the element's
   entire lifetime, even when the cursor is nowhere near it. Browsers will
   keep a compositor layer + backing store resident for every magnetic
   element on the page (currently the landing CTA button — one element, so
   cheap today, but the pattern scales badly if reused).

2. The JSDoc says "DESIGN.md caps ≤0.3" but nothing enforces it. A caller can
   pass `strength={0.9}` and the magnetic pull will overshoot the element
   bounds. The single call site (`routes/index.tsx:180`) uses `0.3`, so this
   is latent rather than active.

**Impact**: GPU memory waste on idle magnetic elements; unenforced contract.

**Fix**: add `will-change-transform` only while hovering (toggle on
`onPointerEnter`/`onPointerLeave`). Clamp `strength` to `[0, 0.3]` (or
document the cap as a convention, not a guarantee).

---

### [P2] `vt.ts`: mutable singleton + redundant listener cleanup

`apps/web/src/lib/vt.ts:8-32`

```ts
export const vtState = { active: false };
...
document.addEventListener("viewtransitionend", clear, { once: true });
clearTimer = setTimeout(clear, 600);
...
const clear = () => {
  vtState.active = false;
  document.removeEventListener("viewtransitionend", clear);   // redundant with {once:true}
  if (clearTimer !== undefined) { clearTimeout(clearTimer); clearTimer = undefined; }
};
```

- `vtState` is exported as a bare mutable object — any module can write
  `vtState.active = true/false` directly, bypassing `markViewTransitionActive`.
  There is no encapsulation; the invariant ("active only during a real VT")
  is unenforceable.
- The `viewtransitionend` listener is registered with `{ once: true }` *and*
  manually `removeEventListener`'d inside `clear`. Harmless duplication but
  signals unclear ownership of the cleanup contract.
- The 600 ms fallback is hardcoded; it matches `DUR.slow` (600 ms) but the VT
  animations themselves use `--dur-page` (400 ms) or `--dur-fast` (250 ms)
  per `styles.css:185-198`. The fallback is therefore always longer than the
  real animation, which is safe, but the magic `600` is unexplained and
  untied to the `DUR` ladder it implicitly references.

**Impact**: low — the duplication is harmless and the singleton works. But
the foundation file should set the bar for encapsulation; this doesn't.

**Fix**: export `isViewTransitionActive()` as a getter, or expose
`vtState` as a readonly snapshot. Derive the fallback from `DUR.slow` (or
better, from `DUR.page` since that's what VTs actually use). Pick one cleanup
mechanism (`{once:true}` *or* manual remove, not both).

---

### [P2] `FadeIn`: no `as` prop — always renders a `<div>`, breaks inline contexts

`apps/web/src/components/motion/fade-in.tsx:27-33`

```ts
return (
  <m.div className={cn(className)} initial={...} animate={...}>
    {children}
  </m.div>
);
```

`Reveal` has an `as` prop (`"div" | "section" | "header" | "footer" | "li"`).
`FadeIn` does not — it's hardcoded to `m.div`. Wrapping inline content (a
breadcrumb, a `<span>` label, an inline status chip) forces a block-level
`<div>` into the tree, breaking layout. `FadeIn` is currently only used as a
page-level wrapper (`flex flex-col gap-6`), so the limitation is latent, but
the inconsistency with `Reveal` is a tripwire.

**Impact**: callers that want a skeleton→content crossfade on inline content
have no path through `FadeIn`; they'll either reach for raw `m.span` (bypassing
the VT-aware skip logic) or restructure their layout around a `div`.

**Fix**: add an `as` prop matching `Reveal`'s (or share a union type), and
forward to `m[as]`.

---

### [P3] `motion.ts`: `STAGGER` / `DIST` comments document tokens that don't exist

`apps/web/src/lib/motion.ts:11-13`

```ts
export const STAGGER = 0.05; // list children; 0.025 for per-character effects
export const DIST = 16; // px translate for enters (24 on landing hero)
```

The inline comments reference `0.025` (per-character stagger) and `24` (landing
hero distance) as if they were real tokens. They aren't — there's no
`STAGGER_CHAR` or `DIST_HERO` export, and no call site uses `0.025` or `24`.
The landing hero (`routes/index.tsx`) uses `<Magnetic strength={0.3}>` and
`<Reveal delay={i * STAGGER}>` with the default `distance=DIST=16`; the "24 on
landing hero" never materializes.

**Impact**: misleading docs; the next reader will grep for `DIST_HERO` and
find nothing.

**Fix**: either export the constants (`STAGGER_CHAR = 0.025`, `DIST_HERO = 24`)
and use them, or delete the parenthetical hints.

---

### [P3] `NumberTicker`: `Math.min(1000, DUR.slow * 1000)` is a dead clamp

`apps/web/src/components/motion/number-ticker.tsx:60`

```ts
const durationMs = Math.min(1000, DUR.slow * 1000);   // = Math.min(1000, 600) = 600
```

`DUR.slow` is `0.6` (a const), so this expression is always `600`. The
`Math.min(1000, …)` can never clamp unless someone bumps `DUR.slow` past `1.0`,
which the `DUR` ladder doesn't. The JSDoc says "≤1s" but the actual duration
is always exactly 600 ms.

**Impact**: dead branch; the "≤1s" doc is misleading.

**Fix**: `const durationMs = DUR.slow * 1000;` and update the JSDoc to
"600 ms (DUR.slow)" — or, if a real ceiling is desired, source it from a
`DUR.ticker` token instead of overloading `DUR.slow`.

---

### [P3] `styles.css`: `.skeleton-crossfade` is dead code

`apps/web/src/styles.css:233-236`

```css
/* Skeleton → content: opacity crossfade helper (paired with FadeIn) */
.skeleton-crossfade {
  transition: opacity var(--dur-fast) var(--ease);
}
```

Grep across `apps/web/src` finds zero usages of the class name. The comment
says "paired with `FadeIn`", but `FadeIn` implements the crossfade inline via
`<m.div animate={{opacity:1}} transition={{duration, ease: EASE}}>` — it does
not consume this class. Dead CSS in the motion-token stylesheet.

**Impact**: trivial bytes; the real cost is confusion — the comment claims a
pairing that doesn't exist, so future maintainers may reach for the class
expecting `FadeIn` to use it.

**Fix**: delete the rule, or wire `FadeIn` to apply `skeleton-crossfade`
instead of (or in addition to) its inline `transition` so there's one
definition of the skeleton→content timing.

---

### [P3] `motion.ts`: `SPRING.cursor` / `SPRING.scroll` omit `type: "spring"`

`apps/web/src/lib/motion.ts:15-18`

```ts
export const SPRING = {
  cursor: { stiffness: 250, damping: 18, mass: 0.4 },   // no type
  scroll: { stiffness: 120, damping: 30, mass: 0.4 },   // no type
  pop: { type: "spring" as const, stiffness: 350, damping: 14 },
};
```

`pop` explicitly sets `type: "spring"`; `cursor` and `scroll` rely on motion's
implicit-default behavior (spring when `stiffness`/`damping` are present).
Works today, but the inconsistency is a footgun — if motion ever changes its
default (or someone adds `duration` to one of these), the implicit spring
silently becomes a tween.

**Impact**: latent; current behavior is correct.

**Fix**: add `type: "spring" as const` to `cursor` and `scroll` for
consistency with `pop`, or drop it from `pop` and rely on the implicit
default everywhere.

## Summary

**19 findings**: **0 P0**, **3 P1**, **8 P2**, **4 P3**. (Plus 4 sub-items
folded into P2/P3 entries above.)

**Top 3 to fix now:**

1. **`NumberTicker` retargeting bug (P1)** — `fromRef.current = to` in cleanup
   makes realtime Convex balance updates snap-jump instead of animating. Fix
   is one line: capture the in-flight displayed value, not the target.
2. **`NumberTicker` SSR locale hydration mismatch (P1)** — `toLocaleString(undefined, …)`
   produces different strings on Node vs. browser. Pin the locale.
3. **`vt.ts` first-paint hydration hazard (P1)** — `vtState.active` mutates
   before the SSR guard, so any SSR-side evaluation of the `types` callback
   latches the flag with no clear; client/server `initial` disagree → React
   hydration warnings on every animated entrance. Guard before mutating, or
   drive skip off a client-only hook.

**Foundation-level concern**: the motion tokens are duplicated between
`motion.ts` (seconds) and `styles.css` `--dur-*` / `--ease` (ms) with no
shared source and a false "the only place these values live" comment. That
is the single highest-leverage fix for long-term design-system integrity —
make one side derive from the other.
