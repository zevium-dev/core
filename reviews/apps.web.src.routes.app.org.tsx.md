# Review — `apps/web/src/routes/app/org.tsx` + `org/index.tsx` + `org/create.tsx`

## Verdict

NEEDS WORK — no P0/P1, but one real P2 correctness defect (stale local + server state surviving an org switch on `PublisherPaymentsCard`) and one P3 dead view-transition name. The create flow itself is sound: Clerk's `<CreateOrganization>` component owns slug validation, double-submit prevention, and post-create navigation, so none of the assignment's "org-create race" / "client-side slug validation" concerns apply to `create.tsx` — they are Clerk's responsibility and are handled. `org.tsx` is a trivial passthrough `<Outlet/>` with no issues.

## File Stats

- **`org.tsx`** — 10 LOC. Layout shell returning `<Outlet/>` under `/app/org`. No `head`/`pendingComponent` (children own both). No issues.
- **`org/index.tsx`** — 263 LOC. Org home: active-org header (name + slug badge + member count), `PublisherPaymentsCard` (Stripe Connect onboarding via `payouts.startOnboarding` action wrapped in `useMutation`), `OrganizationProfile` (Clerk-managed members/settings), `NoActiveOrg` empty state with `OrganizationList`, `OrgHomeSkeleton`.
- **`org/create.tsx`** — 47 LOC. Thin wrapper around Clerk's `<CreateOrganization appearance={{ theme: shadcn }} afterCreateOrganizationUrl="/app" routing="hash" />` with a matching skeleton.
- **`convex/organizations.ts`** — read for context (`ensureOrganization`, `upsertFromClerk`, `getBySlug`, `listMine`, `ensureWallet`). Not under review here; its races are covered in `reviews/convex.organizations.ts.md`.

## Findings

---

### [SEV: P2] `PublisherPaymentsCard` is not keyed by org id — `publisherCountry` state and stale `payoutState` data survive an org switch

**Location:** `apps/web/src/routes/app/org/index.tsx:91` (`<PublisherPaymentsCard />` — no `key`) + `:105` (`useState("")`) + `:106` (`useQuery(convexQuery(api.payouts.getPayoutState, {}))`).

```tsx
<PublisherPaymentsCard />
// …
function PublisherPaymentsCard() {
  const [publisherCountry, setPublisherCountry] = useState("");
  const payoutState = useQuery(convexQuery(api.payouts.getPayoutState, {}));
```

**Problem:** `OrgHomePage` re-renders on org switch (Clerk's `useOrganization()` context updates `organization`), but `PublisherPaymentsCard` is a child rendered without a `key`, so React reuses the same instance across the switch. Two stale-context bugs follow:

1. **Local state leak.** `publisherCountry` is `useState("")` and is never reset when the active org changes. A user who types `US` into org A's country field, then switches to org B (also `status === "not_started"`), sees org A's `US` pre-filled in org B's input. Clicking "Open Stripe" calls `startOnboarding({ country: "US" })` against org B — the wrong legal-entity country is submitted to Stripe Connect onboarding for the wrong org. The card's own `disabled` check (`!/^[A-Za-z]{2}$/.test(publisherCountry.trim())`) passes because `US` is valid — it has no way to know the country was entered for a different org.

2. **Server-state stale window.** `convexQuery(api.payouts.getPayoutState, {})` is org-scoped only via the Convex JWT `org_id` claim, not via its args (args are `{}`). The React Query cache key is therefore `["payouts.getPayoutState", {}]` — identical for every org. When the org switches, Clerk rotates the JWT and Convex re-subscribes, but between token rotation and subscription resolution React Query serves the cached `data` from the *previous* org. `payoutState.isPending` is `false` (data exists) and `payoutState.data` is the old org's `profile`, so the card renders the old org's `status` badge, `requirements` list, `disabledReason`, and `display` copy — and the `mutationFn` closure reads `payoutState.data?.profile.status` from that stale snapshot to decide whether to send `country`.

**Impact:** Wrong country submitted to Stripe for the wrong org's Connect onboarding (persisted, not transient — Stripe remembers the legal-entity region). Misleading status/requirements shown for the new org until Convex re-resolves. Triggered by: type country → switch org (sidebar `OrganizationSwitcher` or `OrganizationList` select) → click "Open Stripe". No double-click or error needed.

**Fix:** Force remount on org switch so both local state and the Convex subscription reset (`isPending → true → skeleton` while the new org's data loads):

```tsx
<PublisherPaymentsCard key={organization.id} />
```

If the intent is to preserve `publisherCountry` across orgs (it is not — the field is org-specific), that decision should be made explicitly; as written the persistence is accidental.

---

### [SEV: P3] Orphaned `viewTransitionName: org-name-${slug}` — no source element anywhere in the app carries a matching name

**Location:** `apps/web/src/routes/app/org/index.tsx:65-67`.

```tsx
style={
  slug ? { viewTransitionName: `org-name-${slug}` } : undefined
}
```

**Problem:** A view-transition name only produces a morph when *both* the outgoing and incoming page snapshots have an element with the same name. A repo-wide grep for `org-name-` finds this single occurrence — the destination only. The sidebar `OrganizationSwitcher` (`apps/web/src/components/app-sidebar.tsx:58-63`) and the `OrganizationList` in `NoActiveOrg` (`:236-240`) are Clerk-managed components with no `viewTransitionName` on their org-name elements, and the `/app` dashboard (`apps/web/src/routes/app/index.tsx`) has no org-name VT either. So this name never morphs — the heading just gets the default crossfade every other element gets. It is dead CSS that implies a morph the app never wires up, violating the "view-transition morph **or written reason**" rule (here it is neither).

**Impact:** No functional impact; misleading dead code suggesting an unimplemented morph.

**Fix:** Either add a matching `viewTransitionName: \`org-name-${slug}\`` to the source org-name element (not possible on Clerk's `OrganizationSwitcher`/`OrganizationList` without a custom wrapper), or drop the `style` prop and document why no morph is wired (Clerk owns the source list).

---

## Summary

- **Counts:** P0=0, P1=0, P2=1, P3=1. Total findings: 2.
- **Top issues to fix first:**
  1. **P2 — `PublisherPaymentsCard` not keyed by `organization.id`.** Local `publisherCountry` and stale `payoutState` survive an org switch; wrong country can be submitted to Stripe for the wrong org. One-character-class fix: `<PublisherPaymentsCard key={organization.id} />`.
  2. **P3 — Orphaned `viewTransitionName: org-name-${slug}`** on the org-home heading with no matching source element anywhere in the app. Dead VT name; drop or wire up the source.
- **Not bugs (deliberately not flagged):**
  - **Org-create double-submit / client-side slug validation:** `create.tsx` delegates both to Clerk's `<CreateOrganization>` component, which disables its submit button during the API call and validates slug uniqueness against Clerk's backend. No custom form, no race introduced by this patch. The webhook-vs-`ensureOrganization` mirror race is a Convex-layer concern covered in `reviews/convex.organizations.ts.md` and `reviews/apps.web.src.lib.ensure-mirror.ts.md`, not introduced by these route files.
  - **`isPending` usage** in `PublisherPaymentsCard` is correct: `useMutation`'s `isPending` gates the button and label; `.mutate()` (renamed `openOnboarding`) is called in `onClick`, not `.mutateAsync()`. Matches project mutation rules.
  - **Error handling:** `onError` routes through `humanError(error, "Could not open Stripe onboarding.")`; no internal/Convex error strings leak.
  - **Tailwind colors:** only semantic tokens used (`bg-card`, `bg-muted`, `text-muted-foreground`, `border`, `border-dashed`); no raw `bg-*`/`text-*` color utilities.
  - **Motion:** `FadeIn` uses `DUR`/`EASE` from `src/lib/motion.ts`; no hardcoded durations/easings. Skips enter during active view transitions (`vtState.active`) and reduced-motion. No inline `transition`/`duration` values.
  - **Skeletons:** `OrgHomeSkeleton` (route `pendingComponent` + `!isLoaded`), `PublisherPaymentsCard` skeleton (`isPending || !data`), `CreateOrgSkeleton` (route `pendingComponent`). All layout-stable (`min-h-[28rem]` / `min-h-[22rem]`). No missing loading states.
  - **Dead code / imports:** all imports in both files are used (verified: `Building2`, `Landmark`, `Plus`, `Badge`, `Button`, `Card*`, `Skeleton`, `Input`, `Label`, `connectedAccountDisplay`, `humanError`, `FadeIn`, `shadcn`, `OrganizationList`/`OrganizationProfile`/`useOrganization`/`CreateOrganization`).
