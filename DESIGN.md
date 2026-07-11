# Zevium Design Language

> Last updated: 2026-07-11
> Companion docs: [PRODUCT.md](PRODUCT.md) (what), [FLOW.md](FLOW.md) (which screens). This doc is **how it looks and, above all, how it feels**.

## Philosophy

1. **Visuals are stock. Motion is the brand.** Components are unmodified latest shadcn/ui. No custom fonts, no custom palette, no bespoke component styling. All design effort goes into transitions, animations, and micro-interactions.
2. **One application, not pages.** Navigating anywhere — landing → catalogue → API detail → settings — must feel like one continuous surface. Elements travel; screens don't "swap".
3. **Alive, not busy.** Everything responds to the user (hover, press, focus, scroll), nothing moves on its own without cause. Micro-interactions everywhere; ambient animation almost nowhere.
4. **Butter.** 60fps or the animation doesn't ship. Compositor-only properties (`transform`, `opacity`); never animate layout properties (`width`, `height`, `top`, `margin`).
5. **Motion is progressive enhancement.** Content must be fully usable if every animation is disabled.

## Visual base: stock shadcn/ui

- **shadcn/ui latest**, style `new-york`, base color `neutral`, CSS variables on, lucide icons. Regenerate `components.json` + theme tokens via the shadcn CLI so config and CSS agree (today `components.json` says `stone` while `app.css` holds neutral values, and references a `tailwind.config.mjs` that doesn't exist)
- Tailwind v4 CSS-first. Keep `@tailwindcss/typography`. System font stack — no webfonts
- Semantic tokens only (`bg-primary`, `text-muted-foreground`, `border-destructive`). Raw Tailwind colors (`gray-900`, `yellow-400`) are banned — the current landing page violates this and gets rebuilt
- Dark + light both first-class; theme switch is **instant** (no crossfade — snappy beats smooth here)

### Kill list (existing customizations to delete)

| Item | Why |
| --- | --- |
| `src/components/magicui/` (all 6) | Landing-only decoration; `text-reveal.tsx` is dead code already |
| `src/components/animated-beam-zev.tsx` | Landing-only wrapper |
| `--animate-ripple` keyframe in `app.css` | Serves only magicui/ripple |
| Commented `font-heading` @apply | Dead code |
| `src/routes/index.tsx` (current landing) | Hardcoded raw colors, bespoke mockups; rebuild on stock components + the motion system below |
| `components.json` stale `tailwind.config.mjs` ref + stone/neutral drift | Regenerate |

Keep: `motion` v12 + app-wide `LazyMotion` in providers (the foundation), `file-upload.tsx` (functional), `cap-widget` CSS vars (functional captcha). Evaluate `text-hover-effect.tsx`/`screen-center.tsx` against the new system.

## Motion tokens

One easing. A tight duration scale. Springs only where physics is the point (cursor-follow, drag). **No bounce, no wiggle, no easter-egg motion in the app shell.**

```ts
// src/lib/motion.ts — the only place these values live
export const EASE = [0.16, 1, 0.3, 1] as const; // ease-out-expo-ish. THE easing.

export const DUR = {
  instant: 0.15, // hover/press feedback, toggles
  fast: 0.25,    // dropdowns, tooltips, tab switches, list item enter
  base: 0.35,    // dialogs, sheets, popovers, card enter
  page: 0.4,     // view transitions, route-level enter
  slow: 0.6,     // scroll-reveals on landing, hero entrances (marketing only)
} as const;

export const STAGGER = 0.05;   // list children; 0.025 for per-character effects
export const DIST = 16;        // px translate for enters (24 on landing hero)

export const SPRING = {
  cursor: { stiffness: 250, damping: 18, mass: 0.4 }, // magnetic/trailing effects
  scroll: { stiffness: 120, damping: 30, mass: 0.4 }, // scroll-linked progress
  pop:    { type: "spring", stiffness: 350, damping: 14 }, // badge/stat pop-in
} as const;
```

CSS mirror (for CSS-only transitions):

```css
:root {
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-instant: 150ms; --dur-fast: 250ms; --dur-base: 350ms; --dur-page: 400ms;
}
```

Rules:

- App chrome (dashboards, settings, tables) uses `instant`/`fast`/`base`. `slow` is landing-page-only
- Every duration/easing in the codebase imports from `motion.ts` or uses the CSS vars. Hardcoded `duration-300 ease-in-out` in a component is a review reject
- Delays only as stagger (`i * STAGGER`), never arbitrary waits

## Route transitions: View Transitions API

TanStack Router drives the native View Transitions API. This is the #1 coherence device.

### Wiring

```ts
// router.tsx
defaultViewTransition: {
  types: ({ fromLocation, toLocation }) => {
    vtState.active = true; // see coordination below
    const from = fromLocation?.state.__TSR_index ?? 0;
    const to = toLocation?.state.__TSR_index ?? 0;
    return to >= from ? ["navigate-forward"] : ["navigate-back"];
  },
},
```

- Default: **cross-fade** of `main-content` over `DUR.page` with THE easing. No directional slides on morphing routes (slides fight morphs); `navigate-forward`/`back` types are reserved for stack-like flows (e.g. multi-step checkout) only
- **Hard loads** (refresh, direct URL — no old DOM to transition from): `.content-enter` CSS class on `<main>` — fade + 8px rise, `DUR.page`, plays once (React `isInitialLoad` flag, cleared after 400ms so soft navs never replay it)

### Shared-element morphs (`view-transition-name`)

Naming convention `{kind}-{slug}`, must be unique per snapshot. The signature moments:

| From → To | Morphing element(s) |
| --- | --- |
| Catalogue card → API detail | `api-title-{slug}`, `api-logo-{slug}`, `api-price-{slug}` — card title grows into page heading |
| Projects list → project page | `project-title-{slug}`, `project-status-{slug}` |
| Project page → spec editor / explorer | `project-title-{slug}` persists in breadcrumb |
| Landing hero CTA → catalogue heading | `catalogue-heading` |
| Org switcher → org home | `org-name-{slug}` |
| Credits balance (sidebar chip → billing page stat) | `credit-balance` |

- Text that changes size/font across a morph: snap content instantly (`animation-duration: 0.01s; step-end`) while the *group* animates position/size over `DUR.page` — prevents font-crossfade flash
- The morph inventory grows with FLOW.md; every new list→detail pair ships with a morph or a written reason why not

### VT ↔ Motion coordination

Module-level flag (`src/lib/vt.ts`): `vtState.active` set synchronously in the router `types` callback, cleared on `viewtransitionend` (600ms fallback). Motion components read it to set `initial={vtState.active ? false : enterVariant}` — entrance animations must never render `opacity: 0` into the new-state VT snapshot. Without this, morphs flicker. Non-negotiable pattern.

## Micro-interactions (the "alive" layer)

Reusable primitives, built once in `src/components/motion/`:

- **`<Reveal>`** — scroll-entrance wrapper: fade + `DIST`px directional rise, `DUR.slow` on landing / `DUR.base` in-app, `viewport={{ once: true, margin: "-60px" }}`, children stagger `i * STAGGER`. The only sanctioned scroll animation
- **`<Pop>`** — `SPRING.pop` scale 0→1 for badges, counts, status dots appearing
- **`<NumberTicker>`** — count-up for credits balance, call counts, revenue stats (cubic ease-out, ≤1s; respects reduced motion by rendering final value)
- **`.link-draw`** — CSS underline draw (background-size 0→100%, `--dur-base` `--ease`) for inline links

Per-surface spec:

| Surface | Interaction |
| --- | --- |
| Buttons | `whileTap scale 0.97`; hover = token color shift over `instant`. No hover scale on app chrome |
| Cards (catalogue, projects) | hover: `-translate-y-0.5` lift + border/`shadow-sm` deepen over `instant`; press 0.98 |
| Inputs | focus ring animates in over `instant` (default shadcn ring, ensure `transition`) |
| Dialogs / sheets | shadcn defaults retimed to `base` + THE easing; overlay fade `fast` |
| Dropdowns / tooltips / popovers | `fast`, scale-from-origin 0.96→1 + fade (stock Radix, retimed) |
| Toasts (Sonner) | default slide, retimed `base`; success toasts get `<Pop>` on the icon |
| Sidebar collapse | width via `grid-template-columns` transition `base`; icon-label crossfade `fast` |
| Nav active state | `layoutId` pill slides between items (Motion layout animation, `fast`) |
| Tables / lists | row enter: fade + 4px rise, stagger `STAGGER`, cap total ≤400ms (long lists: first 8 rows only) |
| Tabs | `layoutId` underline slides; panel crossfade `fast` |
| Key reveal (create API key) | value blurs in (`filter: blur(8px)→0` + fade, `base`); copy button → checkmark morph `instant` |
| Credits balance | `<NumberTicker>` on change; top-up success: balance pulses once (`SPRING.pop`) |
| Spec editor: save/publish | Save: button label morphs to spinner to check (`fast` each). Publish: dialog exits, version badge `<Pop>`s into header |
| Issues panel | count badge `<Pop>`s on change; panel expands `base` |
| Empty states | illustration + copy `<Reveal>` once |
| Theme toggle | instant swap; icon rotates 90° over `instant`. Fix current hydration mismatch |
| Skeletons | shadcn `<Skeleton>` shimmer; skeleton→content = crossfade `fast`, layout-stable (skeleton matches final dimensions exactly — zero shift) |

Landing page only (delight budget): magnetic cursor-pull on primary CTA + social links (`SPRING.cursor`, strength ≤0.3, off for reduced motion + touch), hero copy staggered entrance (`DUR.slow`, stagger 0.15s), one `<NumberTicker>` stat row. That's the whole budget — no orbs, no beams, no ripples, no word-rotate.

## Loading & perceived speed

- Route loaders prefetch (TanStack `ensureQueryData`) so most navs transition with data ready — VT morphs need the destination rendered; a morph into a spinner is a failed morph
- Optimistic UI everywhere mutations allow (repo convention already) — the animation of the result IS the feedback; no spinner if under ~300ms
- Never two loading indicators for one action. Button-local spinner beats page overlay
- Suspense fallbacks: skeleton screens matching real layout, never blank white / centered giant spinner

## Reduced motion & a11y

- Every Motion component gates on `useReducedMotion()`: entrances render final state, magnetic/trailing effects disable, tickers render final value
- Global CSS kill switch:

```css
@media (prefers-reduced-motion: reduce) {
  .content-enter,
  ::view-transition-old(root),
  ::view-transition-new(root),
  ::view-transition-group(*) { animation: none; }
}
```

- Focus states never depend on motion; `:focus-visible` ring always instant-on
- No animation blocks interaction: pointer events live from frame one of any enter

## Performance rules

- `transform` + `opacity` only. `filter: blur` allowed for small, short, non-scroll-linked moments (key reveal)
- `LazyMotion` + `m.` components (already wired in providers) — no full `motion.` imports; keeps bundle lean
- Infinite/looping animation forbidden in app chrome. Loops only where state demands (active spinner)
- Scroll-linked animation only through `useScroll` + `useSpring(SPRING.scroll)` — no scroll listeners
- Test on 6× CPU throttle; jank = cut the animation, not the frame budget

## Definition of done (per screen)

A screen matches this doc when:

1. Zero raw Tailwind color classes; stock shadcn components unmodified
2. Route into + out of the screen crossfades; list→detail pairs morph a named element
3. Every interactive element responds on hover AND press within 150ms
4. Loading is skeleton-shaped, layout-stable, single-indicator
5. All durations/easings come from `motion.ts` / CSS vars
6. Feels identical in dark and light; respects reduced motion
