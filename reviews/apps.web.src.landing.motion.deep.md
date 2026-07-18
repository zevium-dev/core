# Tiger Deep Review — Landing + Motion Foundation

**Scope:** `apps/web/src/routes/index.tsx`, `apps/web/src/lib/landing.ts`, `apps/web/src/lib/motion.ts`, `apps/web/src/lib/vt.ts`, `apps/web/src/components/motion/{reveal,fade-in,magnetic,number-ticker}.tsx`
**Method:** Full read of every file + call-site/consumer grep for `NumberTicker`, `FadeIn`, `skeleton-crossfade`, `SPRING.*`, `tryItBaseUrl`, `vtState`/`markViewTransitionActive`, `viewTransitionName`, and the `--dur-*/--ease` CSS tokens. Prior review claims re-verified against current source.

---

## Verdict

The motion foundation is well-intentioned and mostly small, but it ships one real correctness bug (NumberTicker retargeting snap on realtime balance ticks), one SSR-global latch that leaks across requests in `vt.ts`, a duplicated token source between `motion.ts` and `styles.css` that directly contradicts the module's own header comment, and a cluster of SSR/JS-less accessibility holes where hero and `Reveal` content is server-rendered with `opacity:0` inline styles and no fallback. The landing route also silently masks real backend failures as "empty catalogue" and links to a `#pricing` anchor that does not exist. No praise — see findings.

---

## File Stats

| File | LoC | Role |
|---|---|---|
| `routes/index.tsx` | 556 | Landing page (hero, how-it-works, MCP config, teasers, footer) |
| `lib/landing.ts` | 89 | URL builders + teaser picker |
| `lib/motion.ts` | 23 | Duration/easing/stagger/spring tokens |
| `lib/vt.ts` | 36 | View-transition coordination flag |
| `components/motion/reveal.tsx` | 47 | Scroll-entrance wrapper |
| `components/motion/fade-in.tsx` | 35 | Skeleton→content crossfade |
| `components/motion/magnetic.tsx` | 70 | Cursor-pull delight effect |
| `components/motion/number-ticker.tsx` | 106 | Count-up for balances/stats |

---

## Findings

### [P1] NumberTicker retargeting snaps on realtime balance updates
**Location:** `components/motion/number-ticker.tsx:54-89`
```ts
const tick = (now: number) => {
  const elapsed = now - start;
  const t = Math.min(1, elapsed / durationMs);
  const next = from + (to - from) * easeOutCubic(t);
  setDisplay(next);
  if (t < 1) {
    frameRef.current = requestAnimationFrame(tick);
  } else {
    setDisplay(to);
    fromRef.current = to;
  }
};
frameRef.current = requestAnimationFrame(tick);
return () => {
  if (frameRef.current !== null) {
    cancelAnimationFrame(frameRef.current);
  }
  fromRef.current = to;   // ← snaps origin to target, ignoring in-flight display
};
```
**Problem:** The cleanup writes `fromRef.current = to` (the *previous* target), not the *current displayed value*. When `value` changes mid-animation (e.g. a Convex realtime wallet decrement arrives while the A→B count-up is still in flight at display ≈ (A+B)/2), the cleanup cancels the frame and sets `fromRef = B`. The next effect's first tick computes `next = B + (C-B)*easeOutCubic(0) ≈ B`, producing a visible **jump discontinuity** from the in-flight midpoint to B, then animates B→C. This component is wired directly to live wallet balances (`routes/app/billing.tsx:124`, `routes/app/index.tsx:137`) and earnings (`routes/app/earnings.tsx:288`, `components/project-earnings-panel.tsx:113/121/132`), where successive per-call decrements arrive faster than the 600 ms animation.
**Impact:** Visual snap/jitter on every realtime balance tick that overlaps the previous animation. The exact scenario the component exists to render smoothly.
**Fix:** Capture the live displayed value into `fromRef` on cleanup, not the target. Mirror `display` into a ref updated inside `tick` and in the `from===to` early return, and read that in cleanup:
```ts
const displayRef = useRef(value);
// inside tick, after setDisplay(next): displayRef.current = next;
// in the from===to branch: displayRef.current = to;
// in cleanup: fromRef.current = displayRef.current;
```
Then `from = fromRef.current` in the next run starts from the actual on-screen number.

---

### [P2] `vt.ts` latches `vtState.active = true` before the SSR guard, never clearing on the server
**Location:** `lib/vt.ts:14-16`
```ts
export function markViewTransitionActive() {
  vtState.active = true;                    // ← set unconditionally
  if (typeof document === "undefined") return;   // ← guard AFTER latch
  ...
}
```
**Problem:** `markViewTransitionActive()` is called from `router.tsx:66` inside `defaultViewTransition.types`, which TanStack Router invokes on navigation regardless of environment. On SSR there is no `document`, so the function latches `vtState.active = true` and returns without scheduling any cleanup (no `viewtransitionend` listener, no 600 ms timer). `vtState` is a module-level singleton, so on a long-lived SSR server the flag stays `true` for the remainder of the process after the first navigation. Every subsequent SSR render of `Reveal`, `FadeIn`, the landing hero, and `notification-bell` reads `vtState.active === true` → `skip = true` → `initial={false}`. That happens to render content visible (no `opacity:0`), which masks the bug, but it also means the SSR branch is now permanently taking the VT-skip path for *all* routes, not just navigations, and any future logic keyed on `vtState.active` for non-entrance purposes is wrong on the server.
**Impact:** Module-global state corruption on SSR; entrance-animation skip path is permanently engaged server-side after the first navigation. Latent correctness hazard for any future consumer of `vtState`.
**Fix:** Guard first, latch second:
```ts
export function markViewTransitionActive() {
  if (typeof document === "undefined") return;
  vtState.active = true;
  ...
}
```

---

### [P2] NumberTicker SSR locale hydration mismatch
**Location:** `components/motion/number-ticker.tsx:21-25, 94-98`
```ts
function defaultFormat(n: number, decimals: number): string {
  return n.toLocaleString(undefined, {           // ← undefined locale
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
}
...
const text =
  format !== undefined
    ? format(display)
    : defaultFormat(decimals === 0 ? Math.round(display) : display, decimals);
```
**Problem:** `toLocaleString(undefined)` resolves to the runtime default locale — Node's `Intl` default on the server, the browser's locale on the client. `display` is initialized to `value` via `useState(value)`, so the server renders `defaultFormat(value)` with the server locale and the client hydrates with the user's locale. When they differ (e.g. server `en-US` → `1,234`, client `de-DE` → `1.234`), React emits a hydration mismatch warning and the number visually flickers. This affects every `NumberTicker` consumer that SSRs (`routes/app/billing.tsx`, `routes/app/index.tsx`, `routes/admin/index.tsx`, `routes/app/earnings.tsx`, `components/project-earnings-panel.tsx`).
**Impact:** Hydration warnings + visual flicker on locale-mismatched clients for every balance/stat rendered by `NumberTicker`.
**Fix:** Pin a locale explicitly (`"en-US"` is the project's existing convention) or pass `locale` through `NumberTickerProps`. At minimum use a stable locale for SSR consistency.

---

### [P2] `motion.ts` values duplicated in `styles.css` despite the "only place these values live" header
**Location:** `lib/motion.ts:1` (comment) vs `styles.css:47-53`
```ts
// src/lib/motion.ts — the only place these values live
export const EASE = [0.16, 1, 0.3, 1] as const;
...
--dur-instant: 150ms;  --dur-fast: 250ms;  --dur-base: 350ms;  --dur-page: 400ms;  --dur-slow: 600ms;
```
```css
:root {
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-instant: 150ms;
  --dur-fast: 250ms;
  --dur-base: 350ms;
  --dur-page: 400ms;
  --dur-slow: 600ms;
}
```
**Problem:** The `motion.ts` header explicitly claims these values live in one place. They don't — `styles.css` redefines the same five durations and the same easing curve as CSS custom properties, used pervasively across the codebase (`button.tsx`, `dialog.tsx`, `sheet.tsx`, `sidebar.tsx`, `sonner.tsx`, `docs-layout.tsx`, `notification-bicker.tsx`, `admin-header.tsx`, `public-header.tsx`, `theme-toggle.tsx`, `spec-rail.tsx`, `catalogue/index.tsx`, `app/billing.tsx`, `app/projects/index.tsx`, `app/projects/$projectSlug.tsx`, `app/settings.tsx`, and the landing footer/teaser cards). The two sources are already semantically duplicated (TS seconds vs CSS milliseconds) and nothing enforces they stay in sync. A change to `DUR.slow` in `motion.ts` will not propagate to the dozens of CSS-token consumers and vice versa.
**Impact:** Silent drift between the JS and CSS motion systems; the comment actively misleads future maintainers into trusting a single source that doesn't exist.
**Fix:** Pick one source of truth. Either (a) generate `styles.css` `--dur-*/--ease` from `motion.ts` at build time, or (b) delete the duplicated constants from `motion.ts` and read from CSS via `getComputedStyle`, or (c) at minimum delete the false header comment and add a cross-reference comment in both files naming the other as the paired source.

---

### [P2] Landing loader silently masks all Convex failures as "empty catalogue"
**Location:** `routes/index.tsx:84-95`
```ts
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
**Problem:** The catch block treats *every* error — auth failure, schema mismatch, Convex outage, network error, malformed response — as "empty catalogue" and falls back to `FALLBACK_TEASERS`. There is no logging, no telemetry, no distinction between a legitimately empty catalogue and a broken backend. Operators have no signal that the public landing is serving static teasers because the backend is down. The SSR path additionally `await`s `ensureQueryData` with no timeout, so a slow/offline Convex directly delays TTFB for the landing page (see P2 below).
**Impact:** Real backend failures are indistinguishable from an empty catalogue; the landing degrades silently with no operator visibility.
**Fix:** At minimum log the error to the server logger and/or report to the error tracker. Consider distinguishing "empty result" (no error) from "query failed" (error) so the fallback semantics are honest.

---

### [P2] `/catalogue#pricing` anchor target does not exist; link performs a full-page reload
**Location:** `routes/index.tsx:424-428`
```tsx
<a
  href="/catalogue#pricing"
  className="text-muted-foreground transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground"
>
  Pricing
</a>
```
**Problem:** A grep for `id="pricing"` or any `#pricing` anchor target in `routes/catalogue/` returns nothing — the catalogue index and detail pages have no element with that id. The link is a raw `<a href>` (not a TanStack `<Link>`), so it bypasses client-side routing entirely and performs a **full-page reload** to `/catalogue`, where the browser scrolls to a non-existent anchor and silently drops the hash. The pricing surface the user expected is not surfaced. This is both a navigation regression (full reload vs. SPA transition) and a dead-link UX defect.
**Impact:** Footer "Pricing" link reloads the page, drops the user on `/catalogue` with no pricing surfaced, and silently discards the hash. Breaks the SPA contract for every visitor who clicks it.
**Fix:** Either add an `id="pricing"` section to the catalogue page and use a client-side `<Link to="/catalogue#pricing">`, or route to the actual pricing surface (a `/pricing` route or the catalogue's pricing filter) via `<Link>`.

---

### [P2] Skeleton (3 cards) → 1–2 teaser layout shift when `liveItems.length < 3`
**Location:** `routes/index.tsx:118-122, 296-318`
```ts
const liveItems = catalogueQuery.data?.items ?? [];
const teasers = pickLandingTeasers(liveItems, FALLBACK_TEASERS);
const showSkeleton = catalogueQuery.isPending && liveItems.length === 0;
...
{showSkeleton
  ? Array.from({ length: 3 }).map((_, i) => ( <Card>...3 skeletons...</Card> ))
  : teasers.map((teaser, i) => ( <Reveal>...teaser...</Reveal> ))}
```
**Problem:** The skeleton always renders 3 cards (matching `sm:grid-cols-3`), but `pickLandingTeasers` slices `liveItems` to `limit=3` — if the catalogue has 1 or 2 live items, the resolved teaser array has 1 or 2 entries. When the query resolves from 0 items (skeleton) to 1–2 items (real), the grid drops from 3 columns populated to 1–2 columns populated, causing a visible layout shift in the teasers section. The fallback path (`FALLBACK_TEASERS`, always 3) is fine; the partial-catalogue path is not.
**Impact:** CLS / visual reflow in the live catalogue section whenever the public catalogue has fewer than 3 listings.
**Fix:** Pad `teasers` to 3 with fallback entries when `liveItems.length` is 1 or 2, or render skeletons for the missing slots so the column count is stable across the loading→loaded transition.

---

### [P2] Footer Clerk `<Show>` renders neither state on SSR → hydration layout shift
**Location:** `routes/index.tsx:450-470`
```tsx
<div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4 text-xs text-muted-foreground">
  <span>© {new Date().getFullYear()} Zevium</span>
  <Show when="signed-out">
    <Link to="/sign-in/$" ...>Sign in</Link>
  </Show>
  <Show when="signed-in">
    <Link to="/app" ...>Dashboard</Link>
  </Show>
</div>
```
**Problem:** On SSR, Clerk cannot know the auth state, so *neither* `<Show>` branch renders — the footer's `justify-between` row contains only the copyright span, collapsing to a single left-aligned item. On hydration, once Clerk resolves, one of the two links appears, shifting the row from one item to two and reflowing the `justify-between` layout. This is a visible footer layout shift on every landing-page load for signed-in users (and a smaller one for signed-out users once Clerk resolves).
**Impact:** Footer layout shift on hydration for all visitors; the `justify-between` row reflows when the auth-gated link mounts.
**Fix:** Reserve space for the auth link with a skeleton/placeholder of the same dimensions on SSR, or restructure the footer so the auth link's absence doesn't change the layout (e.g. always render the slot with a stable-width placeholder).

---

### [P2] SSR renders `Reveal` and hero children with `opacity:0` inline styles; no JS-less fallback
**Location:** `components/motion/reveal.tsx:38-44`, `routes/index.tsx:138-150`
```tsx
// reveal.tsx
<Comp
  initial={skip ? false : { opacity: 0, y }}
  whileInView={{ opacity: 1, y: 0 }}
  viewport={{ once: true, margin: "-60px" }}
  ...
/>
// index.tsx hero
<m.h1 variants={enterItem}>...</m.h1>   // enterItem.hidden = { opacity: 0, y: DIST+8 }
```
**Problem:** When `skip` is false (no reduced motion, no active VT), `Reveal` and the landing hero variants set `initial={ opacity: 0, y }`. Motion renders this as an inline `style="opacity:0;transform:translateY(...)"` in the SSR HTML. The `whileInView` animation only fires once the browser has JS, Motion has hydrated, and the IntersectionObserver has triggered. Users with JS disabled, or during the window between first paint and Motion hydration, see **invisible content** (opacity:0) for every `Reveal`-wrapped section (How it works, Consumers/Publishers, For agents, Live catalogue header, and every teaser card) and the hero stack. On SSR the bug is partly masked by the P2 `vt.ts` latch (which forces `skip=true` after the first navigation), but on a cold first-page SSR render where `vtState.active` is still false, the server emits `opacity:0` inline styles into the HTML.
**Impact:** Content invisible without JS; accessibility regression for JS-less users and slow-3G/hydration-gap scenarios. The `vt.ts` latch happens to hide this for post-navigation SSR but is itself a bug (see P2 above).
**Fix:** Use `@media (scripting: none)` CSS to reset `opacity:1` for JS-less clients, or render `Reveal` content visible by default and gate the entrance on a client-only effect (e.g. set `initial` only after a `useEffect` confirms JS + IntersectionObserver availability).

---

### [P2] SSR loader blocks render on `ensureQueryData` with no timeout
**Location:** `routes/index.tsx:84-95`
```ts
await context.queryClient.ensureQueryData(queryOpts);
```
**Problem:** On SSR the loader awaits the catalogue query with no timeout. If Convex is slow (cold start, network blip) or unreachable, the entire landing-page SSR render is delayed until the query settles — and the catch block then swallows the failure (see P2 "silent loader catch" above) so the operator gets no signal that TTFB is being held by a failing backend. The landing page is the highest-traffic public surface; a slow Convex directly degrades first-paint for every visitor.
**Impact:** SSR TTFB unbounded by backend latency; combined with the silent catch, a Convex outage manifests as a slow landing page with no error visibility.
**Fix:** Wrap `ensureQueryData` in a timeout (e.g. `Promise.race` against a 500 ms deadline) and fall back to `FALLBACK_TEASERS` on timeout, with the error logged separately.

---

### [P3] Hero stagger hardcodes `0.15` instead of the `STAGGER` token; left and right hero columns inconsistent
**Location:** `routes/index.tsx:155-158, 197-203`
```tsx
// left column (hero text)
variants={{
  show: { transition: { staggerChildren: reduce ? 0 : 0.15 } },   // ← hardcoded
}}
...
// right column (request card)
variants={{
  show: { transition: {
    staggerChildren: reduce ? 0 : STAGGER * 2,   // ← token-based (0.1)
    delayChildren: reduce ? 0 : 0.15,             // ← hardcoded
  }},
}}
```
**Problem:** The left hero column uses a hardcoded `0.15` for `staggerChildren`; the right column uses `STAGGER * 2` (= 0.1). The two columns stagger at different rates with no stated reason, and `delayChildren: 0.15` is also a magic number rather than a multiple of `STAGGER`. `STAGGER` exists in `motion.ts` precisely so these values are not sprinkled through routes.
**Impact:** Inconsistent hero entrance rhythm; token bypassed; future `STAGGER` tuning won't propagate to the hero.
**Fix:** Express all hero staggers/delays as multiples of `STAGGER` (e.g. `STAGGER * 3` for 0.15) and reconcile the left/right rates intentionally.

---

### [P3] `itemReduced` variant is redundant — `item` alone covers the reduce case via `skipEnter`
**Location:** `routes/index.tsx:131-153`
```ts
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
**Problem:** When `reduce` is true, `skipEnter` is also true (`skipEnter = Boolean(reduce) || vtState.active`), so `item.hidden` is already `{ opacity: 1, y: 0 }` — visually identical to `itemReduced.hidden` (`{ opacity: 1 }`). The `show` transitions are identical. `itemReduced` adds no observable behavior; `enterItem = item` would produce the same render. Additionally, neither variant guards `duration` with `reduce ? 0 : DUR.slow`, so even in reduced-motion the hero `show` transition runs a 600 ms no-op opacity 1→1 animation (the `Reveal` component does gate duration on reduce, but these inline hero variants do not).
**Impact:** Dead variant; cognitive overhead; reduced-motion users get a 600 ms no-op transition on every hero item.
**Fix:** Delete `itemReduced`; use `item` directly. Gate the hero `show` transition `duration: reduce ? 0 : DUR.slow` to match `Reveal` semantics.

---

### [P3] `motion-reduce` only kills transforms on teaser hover; box-shadow and border-color transitions still run
**Location:** `routes/index.tsx:536`, `styles.css:215-225`
```tsx
<Card className="h-full py-4 transition-[transform,box-shadow,border-color] duration-[var(--dur-instant)] ease-[var(--ease)] group-hover:-translate-y-0.5 group-hover:shadow-sm group-active:scale-[0.98]">
```
```css
@media (prefers-reduced-motion: reduce) {
  .group-hover\:-translate-y-0\.5:hover,
  .group-active\:scale-\[0\.98\]:active,
  .active\:scale-\[0\.97\]:active { transform: none !important; }
  ...
}
```
**Problem:** The global reduced-motion CSS resets `transform` on hover/active, but `TeaserCard`'s `transition-[transform,box-shadow,border-color]` still animates `box-shadow` (the `group-hover:shadow-sm`) and `border-color` over 150 ms. Reduced-motion users still get a shadow/border animation on hover. The same applies to `routes/app/projects/index.tsx:122` and `routes/catalogue/index.tsx:448` which share the class pattern.
**Impact:** Reduced-motion preference partially ignored on teaser/project/catalogue card hovers.
**Fix:** Either extend the reduced-motion block to suppress `box-shadow`/`border-color` transitions on these selectors, or scope the transition to `transform` only and animate shadow/border via a separate property that's killed under reduced-motion.

---

### [P3] `Magnetic` applies `will-change-transform` always-on for every mouse user
**Location:** `components/motion/magnetic.tsx:55-65`
```tsx
return (
  <m.div
    ref={ref}
    className={cn("inline-flex will-change-transform", className)}
    style={{ x, y }}
    onPointerMove={onPointerMove}
    ...
  >
```
**Problem:** `will-change: transform` is unconditionally in the className for every non-reduced-motion render, even when the pointer is nowhere near the element. `will-change` is a hint meant to be applied just before a change and removed after; always-on `will-change` promotes the element to its own compositing layer permanently, costing memory and (on pages with many magnetic elements) layer thrash. The landing has two `Magnetic` instances (hero "Browse catalogue" button only, currently), so the cost is small today, but the pattern is wrong.
**Impact:** Permanent compositing layer for every magnetic element; memory/GPU cost scales with adoption.
**Fix:** Apply `will-change-transform` on `onPointerEnter` and remove it on `onPointerLeave`/`onPointerCancel`, or use Motion's `onHoverStart`/`onHoverEnd`.

---

### [P3] Most landing CTAs have no `viewTransitionName`; only "Browse catalogue" is named
**Location:** `routes/index.tsx:183-187, 191-193, 264, 274, 314-316`
```tsx
<Link to="/catalogue" style={{ viewTransitionName: "catalogue-heading" }}>Browse catalogue</Link>
<Link to="/sign-up/$">Get started</Link>            // ← no VT name
<Link to="/catalogue">Find an API</Link>            // ← no VT name
<Link to="/app/projects">Start publishing</Link>   // ← no VT name
<Link to="/catalogue">View all</Link>               // ← no VT name
```
**Problem:** The project's UI rules require "every list→detail nav ships view-transition morph or written reason." Only the primary hero CTA has a `viewTransitionName`. The three "Find an API" / "View all" CTAs navigate to `/catalogue` (a list view) without a morph target, and "Get started" / "Start publishing" navigate without any VT name. None have a written reason for the omission. The `catalogue-heading` name is also applied to a `<Link>` that lands on the catalogue *index*, not a detail — and there's no corresponding `viewTransitionName: "catalogue-heading"` on the catalogue index heading to morph into, so the name is a one-sided declaration that triggers nothing.
**Impact:** VT morph contract violated on five CTAs; the one named element has no morph partner so the name is decorative.
**Fix:** Either add corresponding `viewTransitionName` targets on the destination routes' hero headings, or document per-CTA why no morph is shipped.

---

### [P3] `DIST + 8` magic number instead of a token
**Location:** `routes/index.tsx:132`
```ts
hidden: skipEnter ? { opacity: 1, y: 0 } : { opacity: 0, y: DIST + 8 },
```
**Problem:** `DIST` is 16; `DIST + 8` = 24, which matches the `motion.ts` comment `// 24 on landing hero` next to `DIST`. Rather than encoding 24 as a token (e.g. a `DIST_HERO` export or a `heroDistance` prop on `Reveal`), the hero adds a magic `+ 8` inline. The comment in `motion.ts` and the `+ 8` in `index.tsx` are two unlinked sources of truth for the hero distance.
**Impact:** Future maintainer changing `DIST` must know to also recompute the `+8`; the comment and the arithmetic can drift.
**Fix:** Export a `DIST_HERO = 24` (or `heroDistance`) from `motion.ts` and use it directly, deleting the `+ 8`.

---

### [P3] `noreferrer` without `noopener` on the GitHub link
**Location:** `routes/index.tsx:441-447`
```tsx
<a
  href={GITHUB_URL}
  target="_blank"
  rel="noreferrer"
  className="..."
>
  GitHub
</a>
```
**Problem:** `rel="noreferrer"` happens to imply `noopener` behavior in modern evergreen browsers, but the spec keyword that guarantees the `window.opener` is null is `noopener`. Older browsers and some embeddable webviews honor `noreferrer` as a referrer-suppression hint without fully nulling `opener`. The project standard elsewhere should be `rel="noreferrer noopener"`.
**Impact:** Theoretical tabnabbing exposure on legacy webviews; inconsistent with the safer `noopener` convention.
**Fix:** `rel="noreferrer noopener"`.

---

### [P3] Dead `.skeleton-crossfade` CSS — no consumer
**Location:** `styles.css:233-236`
```css
/* Skeleton → content: opacity crossfade helper (paired with FadeIn) */
.skeleton-crossfade {
  transition: opacity var(--dur-fast) var(--ease);
}
```
**Problem:** A grep for `skeleton-crossfade` across `apps/web/src` returns only this CSS definition — no component applies the class. `FadeIn` (the intended pairing, per the comment) uses Motion's `animate` prop, not the CSS class. The class is dead weight and its comment is misleading (it claims pairing with `FadeIn` which doesn't use it).
**Impact:** Dead code; misleading comment; future maintainer may reach for a class that does nothing.
**Fix:** Delete the rule, or wire `FadeIn` to actually use it.

---

### [P3] Dead `Math.min(1000, DUR.slow * 1000)` clamp — 600 < 1000 always
**Location:** `components/motion/number-ticker.tsx:71`
```ts
const durationMs = Math.min(1000, DUR.slow * 1000);
```
**Problem:** `DUR.slow = 0.6` (seconds), so `DUR.slow * 1000 = 600`. `Math.min(1000, 600) = 600` — the 1000 ms cap never engages. Either the cap is defensive code for a future `DUR.slow > 1.0` (which the comment in `motion.ts` constrains to "marketing only" and wouldn't exceed 1 s), or it's a leftover from an earlier 1-second animation. Either way it's dead logic.
**Impact:** Dead branch; misleading — reads as if the animation could be 1 s when it is fixed at 600 ms.
**Fix:** If the intent is a hard 1 s cap on count-up duration, export it as a token (e.g. `DUR.tickerMax`) and comment why. Otherwise delete the `Math.min` and use `DUR.slow * 1000` directly.

---

### [P3] Dead `SPRING.scroll` export — no consumer
**Location:** `lib/motion.ts:20`
```ts
export const SPRING = {
  cursor: { stiffness: 250, damping: 18, mass: 0.4 },
  scroll: { stiffness: 120, damping: 30, mass: 0.4 },   // ← no consumer
  pop: { type: "spring" as const, stiffness: 350, damping: 14 },
};
```
**Problem:** A grep for `SPRING.scroll` across `apps/web/src` returns only the definition. `SPRING.cursor` is used by `magnetic.tsx:27-28` and `SPRING.pop` by `notification-bell.tsx:162`. `SPRING.scroll` (commented "scroll-linked progress") is exported but never imported — no scroll-linked spring exists in the codebase.
**Impact:** Dead export; invites reliance on a spring config that nothing validates.
**Fix:** Delete `SPRING.scroll`, or wire the intended scroll-linked progress component.

---

### [P3] `buildMcpConfigSnippet` hand-rolls JSON via string interpolation
**Location:** `lib/landing.ts:43-54`
```ts
export function buildMcpConfigSnippet(mcpUrl: string): string {
  return `{
  "mcpServers": {
    "zevium": {
      "url": "${mcpUrl}",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}`;
}
```
**Problem:** The snippet is built by interpolating `mcpUrl` directly into a JSON-shaped string with no `JSON.stringify` and no escaping. If `mcpUrl` ever contains a `"`, a backslash, or a control character (e.g. a misconfigured `VITE_GATEWAY_URL` with a trailing path containing a quote, or a future URL with a fragment), the emitted snippet is invalid JSON that an agent client will reject. There's a test file (`landing.test.ts`) but it doesn't cover adversarial URL characters.
**Impact:** Fragile; a malformed env value produces a broken MCP config shown to every landing visitor, with no guard.
**Fix:** Build the config object and `JSON.stringify` it with an indent, or at minimum `mcpUrl.replace(/"/g, '\\"')`.

---

### [P3] `McpConfigBlock` `setTimeout` is not cleared on unmount
**Location:** `routes/index.tsx:500-510`
```ts
async function onCopy() {
  try {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    toast.success("MCP config copied");
    window.setTimeout(() => setCopied(false), 1500);
  } catch {
    toast.error("Could not copy — select and copy manually");
  }
}
```
**Problem:** The 1500 ms timeout that resets `copied` to `false` is not tracked or cleared in a cleanup effect. If the user copies and navigates away within 1500 ms, the timeout fires `setCopied(false)` on an unmounted component. React 18+ no longer warns about this, but the timeout still leaks and the `setDisplay`-equivalent call is wasted work.
**Impact:** Minor timer leak on unmount; not user-visible but sloppy.
**Fix:** Store the timeout id in a ref and clear it in a `useEffect` cleanup, or use a `useEffect` keyed on `copied` that resets after 1500 ms.

---

### [P3] `Magnetic` calls `getBoundingClientRect()` on every `pointermove` — layout thrash
**Location:** `components/motion/magnetic.tsx:33-49`
```ts
const onPointerMove = useCallback(
  (event: PointerEvent<HTMLDivElement>) => {
    if (reduce) return;
    if (event.pointerType !== "mouse") return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();   // ← every pointermove
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    rawX.set((event.clientX - cx) * strength);
    rawY.set((event.clientY - cy) * strength);
  },
  [rawX, rawY, reduce, strength],
);
```
**Problem:** `getBoundingClientRect` forces a layout flush; calling it on every `pointermove` event (which can fire 60–120 Hz) is a known layout-thrash anti-pattern. The element's rect doesn't change during a hover unless the page scrolls or resizes, so it can be cached on `pointerenter` and invalidated on scroll/resize.
**Impact:** Unnecessary layout recalculation on every mouse move over a magnetic element; jank on low-end devices, especially if multiple magnetic elements exist.
**Fix:** Cache the rect on `onPointerEnter` and recompute on `scroll`/`resize`, or use `useMemo`/ref with an invalidation handler.

---

### [P3] `useReducedMotion()` returns `null` on first render; `Magnetic`/`Reveal` animate before matchMedia resolves
**Location:** `components/motion/reveal.tsx:33-36`, `components/motion/magnetic.tsx:24, 51`
```ts
// reveal.tsx
const reduce = useReducedMotion();           // null on first paint
const skip = Boolean(reduce) || vtState.active;
const y = reduce ? 0 : distance;             // ← null → distance (animates)

// magnetic.tsx
const reduce = useReducedMotion();            // null on first paint
...
if (reduce) { return <div>...</div>; }       // ← null → renders magnetic version
```
**Problem:** Motion's `useReducedMotion()` returns `null` until `matchMedia` resolves (SSR and first client paint). `Boolean(null)` is `false`, so `skip` is false and `Reveal` sets `initial={ opacity: 0, y: distance }` on the first render — then re-renders with `reduce=true` once matchMedia resolves, flipping to `skip=true` / `initial={false}`. For a reduced-motion user this is a one-frame flash of the entrance animation being set up, then disabled. `Magnetic` has the inverse issue: `if (reduce)` is false for `null`, so it renders the magnetic interactive version on first paint even for reduced-motion users, then flips to the plain div.
**Impact:** One-frame motion flash for reduced-motion users on first paint; inconsistent treatment of the `null` state across components.
**Fix:** Treat `null` as "motion enabled" consistently (current `Reveal` behavior) or "motion disabled" consistently, and document which. For `Magnetic`, prefer `if (reduce !== false)` (i.e. default to off when unknown) to err on the accessibility-safe side.

---

### [P3] `NumberTicker` uses a non-reactive `prefersReducedMotion()` instead of `useReducedMotion()`
**Location:** `components/motion/number-ticker.tsx:27-33, 53-57`
```ts
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
...
useEffect(() => {
  if (prefersReducedMotion()) { setDisplay(value); fromRef.current = value; return; }
  ...
});
```
**Problem:** Every other motion component in the codebase uses Motion's `useReducedMotion()` hook (reactive, SSR-safe). `NumberTicker` rolls its own `prefersReducedMotion()` that reads `matchMedia` directly inside `useEffect` — non-reactive (won't re-run if the user toggles reduced-motion mid-session unless `value` changes) and inconsistent with the rest of the motion system. It also returns `false` on SSR, so the SSR render assumes motion is enabled and emits the animated path's initial state.
**Impact:** Inconsistent motion-detection pattern; reduced-motion toggle mid-session doesn't propagate to the ticker until the next `value` change.
**Fix:** Replace `prefersReducedMotion()` with `useReducedMotion()`, matching `Reveal`/`FadeIn`/`Magnetic`.

---

### [P3] `Magnetic` early-returns a plain `<div>` for reduce, breaking the `asChild`/layout contract
**Location:** `components/motion/magnetic.tsx:51-54`
```tsx
if (reduce) {
  return <div className={cn("inline-flex", className)}>{children}</div>;
}
```
**Problem:** When `reduce` is true, `Magnetic` renders a plain `<div>` without the `style={{ x, y }}` motion values and without `will-change-transform`. The animated path renders `<m.div className="inline-flex will-change-transform" style={{ x, y }}>`. The two branches differ in both class list (`will-change-transform` present/absent) and inline style (motion `x`/`y` vs nothing). If a consumer wraps `Magnetic` around a `Button asChild` expecting the wrapper to forward motion props, the reduce branch silently drops them. Also, `Magnetic` doesn't accept an `as` / `asChild` prop, so it always renders a `<div>` even when a `<button>` or `<a>` would be the correct semantic wrapper — the `<Button asChild>` inside the hero compensates, but the outer `Magnetic` div is an extra wrapper around the `<Link>`.
**Impact:** Class/style drift between reduce and non-reduce branches; extra wrapper div around semantic elements.
**Fix:** Unify the two branches — render `<m.div>` in both, just without the pointer handlers (or with handlers that no-op) when reduced. Consider an `as` prop.

---

### [P3] `landing.ts` `resolveGatewayOrigin` defaults to `http://localhost:8787` — production hazard if env unset
**Location:** `lib/landing.ts:5-11`
```ts
export function resolveGatewayOrigin(
  envValue: string | undefined,
  fallback = "http://localhost:8787",
): string {
  if (typeof envValue === "string" && envValue.trim().length > 0) {
    return envValue.trim().replace(/\/+$/, "");
  }
  return fallback.replace(/\/+$/, "");
}
```
**Problem:** If `VITE_GATEWAY_URL` is unset (misconfigured deploy, missing `.env`), the landing page's MCP config block and discovery URL render with `http://localhost:8787/mcp` and `http://localhost:8787/discovery` — a localhost URL shown to public visitors. There is no warning, no fallback to a production origin, and no build-time check that the env is set. The catch-the-world loader (P2) would also mask any error from this path.
**Impact:** A misconfigured production deploy shows visitors a localhost MCP URL; copy-paste of the MCP config silently fails for every agent that tries it.
**Fix:** Either fail the build when `VITE_GATEWAY_URL` is unset in production, or log a loud warning when the fallback is engaged at runtime.

---

### [P3] `vt.ts` 600 ms fallback timer is hardcoded; not derived from `DUR.page`
**Location:** `lib/vt.ts:31`
```ts
clearTimer = setTimeout(clear, 600);
```
**Problem:** The VT-clear fallback timer is 600 ms, matching `DUR.slow` (0.6 s) — but `styles.css` scopes view-transition durations to `--dur-page` (400 ms) for the default cross-fade and `--dur-fast` (250 ms) for `nav-swap`. The fallback timer is therefore longer than any actual VT animation (400 ms max), which is safe, but it's a magic number unrelated to the tokens that define the actual animations it's guarding. If `--dur-page` is ever raised above 600 ms, the fallback would fire *before* `viewtransitionend` and clear `vtState.active` mid-transition, re-engaging entrance animations (opacity:0) into the still-rendering VT snapshot — the exact failure mode `vtState` exists to prevent.
**Impact:** Latent bug if the page VT duration ever exceeds 600 ms; magic number divorced from the motion tokens.
**Fix:** Derive the fallback from `DUR.page` (or a dedicated `VT_FALLBACK_MS` token) with a safety margin, e.g. `DUR.page * 1000 + 200`.

---

## Summary

| Severity | Count |
|---|---|
| P0 | 0 |
| P1 | 1 |
| P2 | 8 |
| P3 | 16 |
| **Total** | **25** |

**Top 3 to fix first:**
1. **NumberTicker retargeting snap (P1)** — directly degrades the live wallet/earnings tickers the component exists to render, on every overlapping realtime update. Capture live `display` into `fromRef` in cleanup.
2. **`vt.ts` SSR latch before guard (P2)** — module-global `vtState.active` latches `true` on the server and never clears, permanently engaging the VT-skip path for all subsequent SSR renders and corrupting shared state on long-lived servers. Guard before latch.
3. **`motion.ts` ↔ `styles.css` duplicated token source (P2)** — the "only place these values live" comment is false; five durations + the easing curve are duplicated across TS and CSS with no sync mechanism, and the CSS copies are consumed by ~20 components. Pick one source of truth or at minimum delete the misleading comment and cross-reference.

**Re-verification of prior review claims:** All 4 prior P2s and 7 prior P3s re-confirmed against current source (some with expanded detail: the `#pricing` anchor has zero target in the catalogue routes; `skeleton-crossfade` has zero consumers; `SPRING.scroll` joins `Math.min(1000,…)` as additional dead code). The prior "dead STAGGER/DIST hero hints" claim is **not** re-confirmed — both `STAGGER` and `DIST` are actively used in the landing (Reveal delays and `item.hidden`), though `DIST + 8` is a magic number (P3 above). The prior "motion lib 3 P1" claim is partially re-confirmed: the NumberTicker retargeting snap is a real P1; the `vt.ts` SSR latch and SSR locale mismatch are real but rate P2 (not P1) since neither causes data loss or security impact.
