# Tiger Review — `apps/web/src/routes/index.tsx`

Scope: `apps/web/src/routes/index.tsx` (556 LOC, primary) + `apps/web/src/lib/landing.ts`,
`apps/web/src/lib/landing.test.ts`, `apps/web/src/components/motion/{reveal,fade-in,magnetic,number-ticker}.tsx`,
`apps/web/src/lib/motion.ts`, `apps/web/src/lib/vt.ts`, `apps/web/src/styles.css` for boundary
context. Cross-checked `apps/web/src/routes/catalogue/index.tsx` for the `catalogue-heading`
view-transition morph target, and `apps/web/src/routes/sign-up.$.tsx` / `sign-in.$.tsx` for
the `$` splat route contract.

## Verdict

**Incorrect.** No P0 / no XSS / no raw Tailwind colors / no leaked internal errors (the
copy-failure toast is generic by design). But the file ships a real broken-navigation bug
(`<a href="/catalogue#pricing">` does a full-page reload to a fragment that does not exist),
several violations of the project's own motion contract (hardcoded `0.15` hero stagger,
`DIST + 8` magic, a dead `itemReduced` variant, missing `motion-reduce:` guard on the
teaser-card hover/active transforms, SSR-rendered `opacity:0` with no JS-less fallback),
inconsistent view-transition coverage on the CTAs, and a skeleton→live grid that can drop
columns. Plus the usual nits. Findings: 11 (P0: 0, P1: 0, P2: 4, P3: 7).

## File Stats

| File | Lines | Role |
|---|---|---|
| `apps/web/src/routes/index.tsx` | 556 | Marketing landing route (`/`) |
| `apps/web/src/lib/landing.ts` | 90 | Pure URL/teaser helpers (well-tested) |
| `apps/web/src/lib/landing.test.ts` | 124 | Vitest coverage for `landing.ts` |
| `apps/web/src/lib/motion.ts` | 19 | Motion token source of truth |
| `apps/web/src/components/motion/reveal.tsx` | 53 | Scroll-entrance wrapper |
| `apps/web/src/components/motion/fade-in.tsx` | 37 | Skeleton→content crossfade |
| `apps/web/src/components/motion/magnetic.tsx` | 67 | Cursor-pull wrapper |
| `apps/web/src/components/motion/number-ticker.tsx` | 105 | Count-up (not used on this route) |
| `apps/web/src/lib/vt.ts` | 27 | View-transition coordination flag |

---

## Findings

### [SEV: P2] "Pricing" footer link is a plain `<a>` to a non-existent `#pricing` anchor → full reload, no VT, lands at top

**Location** — `apps/web/src/routes/index.tsx:423-428`

```tsx
<a
  href="/catalogue#pricing"
  className="text-muted-foreground transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground"
>
  Pricing
</a>
```

**Problem.** This is the only non-external `<a>` in the footer — every other footer link is
a TanStack `<Link>`. Two compounding defects:

1. **Broken fragment.** `grep` of `apps/web/src/routes/catalogue/**` finds no element with
   `id="pricing"` (the catalogue page renders pricing *per card* via
   `formatCataloguePriceRange`, not under a `#pricing` section). The browser therefore
   navigates to `/catalogue` and silently ignores the unmatched hash — the user clicks
   "Pricing" and lands at the top of the catalogue, not on a pricing section. The link
   label promises something the target page does not deliver.
2. **Full-page reload.** Because it is a plain `<a href>`, the browser does a full document
   navigation, defeating the SPA router, the client-side query cache (the loader's
   `ensureQueryData` for `catalogue.listPublic` is thrown away and re-fetched from Convex),
   and any view-transition. The `catalogue-heading` morph that the hero "Browse catalogue"
   button sets up (`viewTransitionName: "catalogue-heading"` at line 184) is skipped
   entirely when the user enters via this link.

**Impact.** Every visitor who clicks "Pricing" in the footer pays a full cold-load penalty
(Convex round-trip + JS bundle re-execution) and arrives at a page that does not contain the
section they expected. The project rule "every list→detail nav ships view-transition morph
or written reason" is silently violated for this entry point.

**Fix.** Use a router `<Link>` (so the client cache and VT apply) and either add a
`#pricing` anchor to the catalogue page or drop the fragment and link to the pricing-relevant
target directly.

```suggestion
<Link
  to="/catalogue"
  className="text-muted-foreground transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground"
>
  Pricing
</Link>
```

---

### [SEV: P2] Hero entrance hardcodes `0.15` for `staggerChildren` and `delayChildren` instead of a motion token

**Location** — `apps/web/src/routes/index.tsx:165-176` (left-column hero) and `:191-201`
(right-column mock card)

```tsx
variants={{
  show: {
    transition: { staggerChildren: reduce ? 0 : 0.15 },
  },
}}
```
```tsx
variants={{
  hidden: {},
  show: {
    transition: {
      staggerChildren: reduce ? 0 : STAGGER * 2,
      delayChildren: reduce ? 0 : 0.15,
    },
  },
}}
```

**Problem.** `apps/web/src/lib/motion.ts` is — by the project's own rule and its leading
comment — "the only place these values live". `STAGGER = 0.05` exists precisely so hero
stagger math is centralized. The left column uses a literal `0.15` (= `STAGGER * 3`); the
right column mixes `STAGGER * 2` with a literal `0.15` for `delayChildren`. The two columns
stagger at different rates (0.15 vs 0.10) for no design reason stated in code, and the
`0.15` magic appears three times. If `STAGGER` is ever tuned, the hero will silently drift
out of sync.

**Impact.** Maintenance hazard and an undocumented inconsistency between the two hero
columns. Not a runtime bug today, but exactly the kind of drift the motion-token rule was
written to prevent.

**Fix.** Define a hero-stagger token in `motion.ts` and reference it everywhere.

```suggestion
// motion.ts
export const STAGGER = 0.05;
export const HERO_STAGGER = STAGGER * 3; // hero column child stagger
export const HERO_DELAY = STAGGER * 3;  // hero column first-child delay
```
```suggestion
// index.tsx, left column
transition: { staggerChildren: reduce ? 0 : HERO_STAGGER },
```
```suggestion
// index.tsx, right column
transition: {
  staggerChildren: reduce ? 0 : STAGGER * 2,
  delayChildren: reduce ? 0 : HERO_DELAY,
},
```

---

### [SEV: P2] `itemReduced` variant is dead code — `skipEnter` already collapses both branches to the same no-op

**Location** — `apps/web/src/routes/index.tsx:139-159`

```tsx
const reduce = useReducedMotion();
const skipEnter = Boolean(reduce) || vtState.active;

const item = {
  hidden: skipEnter ? { opacity: 1, y: 0 } : { opacity: 0, y: DIST + 8 },
  show: { opacity: 1, y: 0, transition: { duration: DUR.slow, ease: EASE } },
};

const itemReduced = {
  hidden: skipEnter ? { opacity: 1 } : { opacity: 0 },
  show: { opacity: 1, transition: { duration: DUR.slow, ease: EASE } },
};
const enterItem = reduce ? itemReduced : item;
```

**Problem.** Trace the two reachable states:

- `reduce === true` → `skipEnter === true` → `enterItem = itemReduced`, whose `hidden` branch
  is `{ opacity: 1 }` and `show` is `{ opacity: 1 }`. No animation, no transform.
- `reduce === false` → `enterItem = item`, and `skipEnter` is only true when `vtState.active`
  is true, in which case `item.hidden` is `{ opacity: 1, y: 0 }` and `show` is
  `{ opacity: 1, y: 0 }`. Also a no-op.

So when `reduce === true`, `item` (with `skipEnter=true`) yields
`hidden={opacity:1,y:0}, show={opacity:1,y:0}` — visually identical to `itemReduced`'s
`hidden={opacity:1}, show={opacity:1}` (omitting `y` vs `y:0` both render as "no transform").
`itemReduced` is never observably different from `item`. The `: { opacity: 0 }` branch of
`itemReduced.hidden` is unreachable because `skipEnter` is forced on whenever `reduce` is on.

**Impact.** Dead code that misleads future maintainers into thinking the reduced-motion path
is meaningfully different from the `item` path, and into keeping `DUR.slow` on the reduced
branch (which is also redundant given `skipEnter`). The conditional `enterItem = reduce ? …`
and the entire `itemReduced` block can be deleted with zero behavioral change.

**Fix.** Drop `itemReduced` and the conditional; `item` alone covers all three states
(reduced / VT-active / normal) via `skipEnter`.

```suggestion
const item = {
  hidden: skipEnter ? { opacity: 1, y: 0 } : { opacity: 0, y: DIST + 8 },
  show: { opacity: 1, y: 0, transition: { duration: DUR.slow, ease: EASE } },
};
const enterItem = item;
```

---

### [SEV: P2] SSR renders hero/section children with `opacity:0` inline; if the Motion bundle fails to hydrate the landing is permanently blank

**Location** — `apps/web/src/routes/index.tsx:160-201` (hero `m.div initial="hidden"`),
`:286-340` (`<Reveal>` wrappers around "How it works", consumers/publishers, "For agents",
catalogue teasers).

**Problem.** `<m.div initial="hidden" animate="show">` and `<Reveal>` (which sets
`initial={{ opacity: 0, y }}`) cause Motion to serialize the `hidden` variant as an inline
`style="opacity:0; transform: translateY(…)"` on the server-rendered HTML. On the client,
Motion's `useReducedMotion`/`useInView` take over and animate to `opacity:1` — but **only if
the Motion JS bundle executes**. There is no CSS fallback that flips these elements to
visible. If the client bundle fails to load (network blip, ad blocker killing Motion's
chunk, JS error during hydration), the entire hero, all `<Reveal>` sections, and the teaser
grid stay at `opacity:0` permanently — the landing page renders as a blank white screen with
only the header/footer visible.

The project's own DESIGN.md rule ("loading = layout-stable skeletons") and the SSR contract
imply the page must be readable without JS. The `bg-card` mock panel and the `<pre>` MCP
config block are the only content that survives a JS-failure scenario.

**Impact.** Total content loss for any user whose Motion chunk fails — including the
no-JS case entirely. Not a transient visual glitch; the page is blank. This is the
well-known SSR + animation-library pitfall and the standard fix is a one-line CSS escape
hatch.

**Fix.** Add a CSS rule that force-shows `[style*="opacity:0"]` Motion outputs when JS is
unavailable. The minimal, robust pattern is a `.no-js` / `<noscript>` class on `<html>` that
the app sets by default and removes on hydration:

```suggestion
/* styles.css — fail-open for SSR-rendered initial states */
html.no-js [style*="opacity:0"] { opacity: 1 !important; transform: none !important; }
```
plus in the root layout's `<head>`:
```suggestion
<script>document.documentElement.classList.remove('no-js')</script>
```

(If a `no-js` strategy is already in use elsewhere, the equivalent already-on strategy
`@media (scripting: none) { [style*="opacity:0"] { opacity: 1 !important; } }` also works
in modern browsers.)

---

### [SEV: P3] TeaserCard hover/active transforms have no `motion-reduce:` guard

**Location** — `apps/web/src/routes/index.tsx:535-536`

```tsx
<Card className="h-full py-4 transition-[transform,box-shadow,border-color] duration-[var(--dur-instant)] ease-[var(--ease)] group-hover:-translate-y-0.5 group-hover:shadow-sm group-active:scale-[0.98]">
```

**Problem.** The card lifts `-translate-y-0.5` on hover and scales to `0.98` on active. These
are CSS transitions, which `prefers-reduced-motion: reduce` does **not** automatically
disable. `apps/web/src/components/ui/button.tsx` ships `motion-reduce:transition-none` on
its base variant — the same convention is missing here. Vestibular-sensitive users still get
a transform on every hover/press of a teaser card.

**Impact.** Minor vestibular issue; the transforms are small (0.5 / 2%), but the project's
`prefers-reduced-motion` rule is global, not motion-lib-only.

**Fix.**

```suggestion
<Card className="h-full py-4 transition-[transform,box-shadow,border-color] duration-[var(--dur-instant)] ease-[var(--ease)] motion-reduce:transition-none group-hover:-translate-y-0.5 group-hover:shadow-sm group-active:scale-[0.98] motion-reduce:group-hover:translate-y-0 motion-reduce:group-active:scale-100">
```

---

### [SEV: P3] `Magnetic` wrapper sets `will-change-transform` unconditionally even at rest

**Location** — `apps/web/src/components/motion/magnetic.tsx:60-67`

```tsx
return (
  <m.div
    ref={ref}
    className={cn("inline-flex will-change-transform", className)}
    style={{ x, y }}
    onPointerMove={onPointerMove}
    onPointerLeave={reset}
    onPointerCancel={reset}
  >
```

**Problem.** `will-change: transform` is applied for the lifetime of the component
regardless of pointer state. On the landing page this promotes the "Browse catalogue" button
to its own compositor layer permanently, even when the cursor is nowhere near it. The
standard pattern is to toggle `will-change` on `pointerenter` and clear it on
`pointerleave`/cancel after the spring settles. Applied once this is negligible; the
landing is the only place `Magnetic` is used today, so impact is bounded, but the component
is reusable and the pattern should be correct.

**Impact.** Unnecessary layer promotion; on low-end devices with many simultaneously
promoted layers this contributes to compositor memory pressure. No visual bug.

**Fix.** Toggle `will-change` via state on pointer enter/leave, or omit it and rely on the
browser's heuristic (the spring is cheap).

---

### [SEV: P3] Skeleton grid (3 cards) collapses when live catalogue returns 1–2 items

**Location** — `apps/web/src/routes/index.tsx:316-345` + `apps/web/src/lib/landing.ts:71-83`

```tsx
{showSkeleton
  ? Array.from({ length: 3 }).map((_, i) => ( /* 3 skeletons */ ))
  : teasers.map((teaser, i) => ( /* live or fallback teasers */ ))}
```
```ts
// pickLandingTeasers
if (liveItems.length > 0) {
  return liveItems.slice(0, limit).map((item) => ({ … live: true }));
}
return fallbacks.slice(0, limit).map((t) => ({ …t, live: false }));
```

**Problem.** When the catalogue query resolves with 1 or 2 live items, `pickLandingTeasers`
returns exactly that many teasers (it only pads with `fallbacks` when `liveItems.length ===
0`). The skeleton state renders 3 cards; the resolved state renders 1 or 2 cards in a
`sm:grid-cols-3` grid — the third (and possibly second) column disappears, causing a visible
layout shift and an asymmetric grid. The "never blank right half" comment on
`FALLBACK_TEASERS` suggests the author wanted exactly this not to happen, but the padding
only triggers in the fully-empty case.

**Impact.** Edge case (most catalogues have ≥3 items), but when it hits, the skeleton→live
transition reshapes the grid. The project rule is "loading = layout-stable skeletons".

**Fix.** Pad live teasers up to `limit` with fallbacks when fewer live items are available,
so the grid is always 3 cells.

```suggestion
export function pickLandingTeasers(
  liveItems: CatalogueListItem[],
  fallbacks: ReadonlyArray<Omit<LandingTeaser, "live">>,
  limit = 3,
): LandingTeaser[] {
  const live = liveItems.slice(0, limit).map((item) => ({
    name: item.name,
    slug: item.slug,
    orgSlug: item.orgSlug,
    orgName: item.orgName,
    description: item.description ?? "Published OpenAPI API.",
    live: true,
  }));
  if (live.length >= limit) return live;
  const pad = fallbacks
    .filter((f) => !live.some((l) => l.slug === f.slug && l.orgSlug === f.orgSlug))
    .slice(0, limit - live.length)
    .map((t) => ({ ...t, live: false }));
  return [...live, ...pad];
}
```

---

### [SEV: P3] Footer right column layout shifts when Clerk resolves

**Location** — `apps/web/src/routes/index.tsx:449-470`

```tsx
<div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4 text-xs text-muted-foreground">
  <span>© {new Date().getFullYear()} Zevium</span>
  <Show when="signed-out">
    <Link to="/sign-in/$" …>Sign in</Link>
  </Show>
  <Show when="signed-in">
    <Link to="/app" …>Dashboard</Link>
  </Show>
</div>
```

**Problem.** During SSR and the first client paint, Clerk has not resolved, so neither
`<Show>` renders — the row contains only the copyright span and `justify-between` left-aligns
it. Once Clerk resolves (signed in or out), a link appears on the right and the copyright
snaps from full-width-left to its `justify-between` position. This is a visible horizontal
jump of the copyright text on every landing load.

**Impact.** Minor layout shift on the footer's first paint after auth resolution. Not a
Core Web Vital issue (below the fold) but violates the layout-stability rule.

**Fix.** Reserve the right slot with an invisible placeholder during the unresolved state,
or render both links with `hidden`/`aria-hidden` until Clerk resolves so the box is always
two-children.

---

### [SEV: P3] Most CTAs lack a `view-transition-name` and no written reason is recorded

**Location** — `apps/web/src/routes/index.tsx:184` (only "Browse catalogue" has
`viewTransitionName: "catalogue-heading"`), versus `:191` "Get started" → `/sign-up/$`,
`:357` "Find an API" → `/catalogue`, `:396` "Start publishing" → `/app/projects`,
`:328` "View all" → `/catalogue`.

**Problem.** The project rule: "every list→detail nav ships view-transition morph or written
reason." Only the hero "Browse catalogue" button is wired to morph into the catalogue h1
(via the shared `catalogue-heading` name, confirmed present at
`apps/web/src/routes/catalogue/index.tsx:144`). The other four CTAs — including a second
`/catalogue` entry ("View all", "Find an API") that could trivially share the morph — have
no `viewTransitionName` and no comment explaining the omission. (They cannot all share
`catalogue-heading` simultaneously — two elements with the same name on the same page is a
VT spec violation — but at most one is visible at a time per section, so scoped names or a
single shared name with a comment would satisfy the rule.)

**Impact.** Inconsistent VT coverage; the rule's "or written reason" escape hatch is not
used, so reviewers cannot tell whether the omission is deliberate.

**Fix.** Either give each catalogue-bound CTA the `catalogue-heading` name (they are in
separate sections, never co-visible in a way that would duplicate the name within one
snapshot — but verify) or add a one-line comment explaining why the morph is skipped.

---

### [SEV: P3] `DIST + 8` magic number for hero rise distance

**Location** — `apps/web/src/routes/index.tsx:147`

```tsx
const item = {
  hidden: skipEnter ? { opacity: 1, y: 0 } : { opacity: 0, y: DIST + 8 },
  …
};
```

**Problem.** `DIST` is 16 (from `motion.ts`); `DIST + 8` = 24, which matches the
`// 24 on landing hero` comment in `motion.ts`. But the `+ 8` is an inline magic adjustment
rather than a named token. The motion-token rule says these values live in `motion.ts`. If
`DIST` changes, the hero rise silently changes by a different ratio than intended.

**Impact.** Maintenance hazard; no runtime bug.

**Fix.** Add `HERO_RISE = 24` (or `DIST + 8`) to `motion.ts` and import it.

---

### [SEV: P3] Loader swallows prefetch errors with no telemetry

**Location** — `apps/web/src/routes/index.tsx:78-90`

```tsx
loader: async ({ context }) => {
  const queryOpts = convexQuery(api.catalogue.listPublic, {});
  try {
    if (typeof window !== "undefined") {
      void context.queryClient.prefetchQuery(queryOpts);
      return;
    }
    await context.queryClient.ensureQueryData(queryOpts);
  } catch {
    /* empty catalogue / offline — FALLBACK_TEASERS */
  }
},
```

**Problem.** The catch comment claims the only failure modes are "empty catalogue / offline",
but `ensureQueryData` throws on any Convex error — including schema mismatches, auth
config drift, and Convex backend outages. All of these are silently downgraded to
"FALLBACK_TEASERS" with zero log. The landing continues to render, so users see static
teasers instead of live ones and the team has no signal that the catalogue query is failing
SSR. The client-side `useQuery` will retry and surface real data eventually, but the SSR
prefetch failure is invisible.

**Impact.** Operational blind spot; degraded SSR with no alarm. Not a correctness bug —
the fallback is intentional — but the silent swallow makes catalogue-SSR outages
undetectable.

**Fix.** Log the error at minimum (console.error is fine for SSR; the gateway/worker code
already uses `console.error` for similar cases in `spec-source.ts`).

```suggestion
} catch (err) {
  console.error("landing loader: catalogue.listPublic prefetch failed", err);
}
```

---

### [SEV: P3] External GitHub link uses `rel="noreferrer"` without `noopener`

**Location** — `apps/web/src/routes/index.tsx:441-447`

```tsx
<a
  href={GITHUB_URL}
  target="_blank"
  rel="noreferrer"
  className="…"
>
  GitHub
</a>
```

**Problem.** `rel="noreferrer"` implies `noopener` in modern browsers (Chrome 88+, Firefox
52+), but not in older Safari or older Chrome. The defensive, conventional form is
`rel="noreferrer noopener"`. Stock shadcn/ui and the project's other external links (if any)
should be checked for the same pattern; this is the only external `<a>` on the landing.

**Impact.** Theoretical reverse-tabnabbing exposure on legacy browsers. No real risk on
modern browsers.

**Fix.**

```suggestion
<a
  href={GITHUB_URL}
  target="_blank"
  rel="noreferrer noopener"
  className="…"
>
```

---

## Summary

**Counts:** 11 findings — P0: 0, P1: 0, P2: 4, P3: 7.

**Top 3 to fix before merge:**

1. **P2 — "Pricing" footer link** (`:423-428`): plain `<a>` to a non-existent `#pricing`
   anchor causes a full-page reload and lands the user at the top of the catalogue, not on a
   pricing section. This is the only real user-visible navigation bug.
2. **P2 — SSR `opacity:0` with no JS-less fallback** (`:160-201`, `:286-340`): if the Motion
   chunk fails to load or hydrate, the entire hero and all `<Reveal>` sections stay invisible
   — the landing renders as a blank page. One-line CSS escape hatch fixes it.
3. **P2 — Hero stagger hardcodes `0.15`** (`:165-176`, `:191-201`) and **P2 — `itemReduced`
   is dead code** (`:139-159`): both violate the project's motion-token contract and
   mislead future maintainers; fixing both is a small, self-contained refactor of the hero
   variant block.

**What's actually fine** (no praise, just scope): no XSS (`<pre>{snippet}</pre>` and
`{mcpUrl}` render as escaped React children; `buildMcpConfigSnippet` interpolates a
server-controlled env value, not user input); no raw Tailwind colors (all classes use
semantic tokens `bg-background` / `text-muted-foreground` / `bg-card` etc.); no leaked
internal errors (the copy-failure toast is a fixed generic string); `isPending` is used
correctly for the skeleton gate, never `isLoading`; `pickLandingTeasers` and the URL
helpers in `landing.ts` are well-covered by `landing.test.ts`; the `catalogue-heading`
view-transition morph target is correctly confirmed present on the catalogue page.
