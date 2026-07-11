# Visual review 1 (post wave-2)

Screenshots: session scratchpad vis-*.png

## Pass
- Light/dark toggle works, tokens stock, icon swaps
- Landing typography/buttons clean stock shadcn, both themes coherent
- Catalogue page header/search layout fine

## Fix lane items
1. BUG: /catalogue skeletons never resolve (public listPublic query hangs client-side; check ConvexProvider on public routes / suspense query settle). May share root cause with SSR token bug.
2. Header not session-aware: shows "Sign in" while signed in → UserButton + Dashboard link when authed.
3. Landing hero right half empty — add proof strip per FLOW 1.1 (catalogue teaser/stat row), stagger entrance + magnetic CTA per DESIGN delight budget.
4. Confirm skeleton→content crossfade + view-transition morphs once data flows.
