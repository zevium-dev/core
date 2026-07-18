# Tiger Review — `apps/web/src/routes/app/earnings.tsx`

Reviewed alongside `convex/earnings.ts`, `convex/payouts.ts`, `convex/schema.ts`,
`apps/web/src/components/project-earnings-panel.tsx`, `apps/web/src/lib/human-error.ts`,
`apps/web/src/lib/project-helpers.ts`, `apps/web/src/lib/stripe-ui.ts`,
`apps/web/src/components/motion/number-ticker.tsx`, `convex/crons.ts`.

## Verdict

Incorrect. One P1 ops deadlock (matured earnings can never become available without
an admin), one P2 data-integrity bug (`forOrg` all-time totals count reversed/failed
earnings), plus several P2/P3 leaks and nits. No raw Tailwind colors, no `isLoading`
misuse, no missing skeletons, no hardcoded motion values (NumberTicker sources `DUR`).

## File Stats

- Lines reviewed: 555 (route), 87 (`convex/earnings.ts`), 754 (`convex/payouts.ts`), 112 (panel)
- Findings: 6 (P0: 0, P1: 1, P2: 3, P3: 2)

## Findings

### [SEV: P1] Matured `pending_risk` earnings never release; transfer button deadlocks

**Location:** `apps/web/src/routes/app/earnings.tsx:176` (`canTransfer = profile.status === "enabled" && earnings.available > 0`) × `convex/payouts.ts:296` (`releaseMatureEarnings`) × `convex/payouts.ts:620` (only caller) × `convex/crons.ts` (no cron).

**Problem:** `releaseMatureEarnings` — the only mutation that flips `pending_risk` → `available` once `availableAt` has passed — is invoked exclusively inside `initiatePublisherTransfer` (line 620). There is no cron (`convex/crons.ts` only schedules `checkLowBalances`) and no webhook path that calls it. `getPayoutState` reads `status` verbatim, so a matured earning still displays under **Pending** indefinitely.

Worse, the transfer button is gated on `earnings.available > 0`. If every matured earning is stuck in `pending_risk`, `earnings.available === 0`, so `canTransfer === false` and the button is disabled — the sole code path that calls `releaseMatureEarnings` is unreachable from the UI. The publisher cannot advance their own earnings without an operator running the internal mutation by hand.

**Trigger:** Any publisher with at least one matured `pending_risk` earning and zero `available` balance (the common case right after risk windows expire and before any prior transfer).

**Impact:** Stale "Pending" display + a hard deadlock blocking all payouts for the affected org. The `by_status_available` index (schema line 309) exists precisely for this release but is unused.

**Fix:** Run the release on read (or via cron). A cron is the cleanest:
```suggestion
// convex/crons.ts
crons.hourly(
  "release-mature-earnings",
  { minuteUTC: 5 },
  internal.payouts.releaseMatureEarningsAll,
);
```
where `releaseMatureEarningsAll` iterates orgs (or use `by_status_available` to scan `pending_risk` with `availableAt <= now` across all orgs). Alternatively, fold the release into `getPayoutState` so the page never shows stale buckets.

### [SEV: P2] `forOrg` all-time totals count reversed and failed earnings

**Location:** `convex/earnings.ts:55-58` and `convex/earnings.ts:66-70`.

**Problem:** The `forOrg` loop sums `allGross`/`allNet`/`monthGross`/`monthNet`/`byProject` for every `publisherEarnings` row without consulting `status`:
```ts
for (const earning of earnings) {
  allGross += earning.grossCredits;
  allNet += earning.netCredits;
  if (earning.createdAt >= monthStart) {
    monthCalls += 1;
    monthGross += earning.grossCredits;
    monthNet += earning.netCredits;
  }
  ...
}
```
The schema union includes `reversed` and `failed` (`convex/schema.ts:288-294`). A reversed transfer moves its earnings back to `status: "reversed"` via `projectStripeTransfer` (`convex/payouts.ts:560-566`), yet `forOrg` still credits that row's gross/net to the publisher's all-time and month-to-date totals. `ProjectEarningsPanel` renders these as the "source of truth" (`apps/web/src/components/project-earnings-panel.tsx:53-90`).

This is inconsistent with the earnings route's own lifecycle cards (`apps/web/src/routes/app/earnings.tsx:227-243`), which bucket `failed`/`reversed` separately and exclude them from Pending/Available/In-transfer/Transferred. Two views of the same publisher statement disagree after any reversal.

**Trigger:** Any org that has ever had a transfer reversed or an earning marked `failed`.

**Impact:** Publisher-facing "all time" / "this UTC month" figures in `ProjectEarningsPanel` overstate real earnings by the reversed/failed amounts. Reconciliation against the lifecycle page won't tie out.

**Fix:**
```suggestion
for (const earning of earnings) {
  if (earning.status === "reversed" || earning.status === "failed") continue;
  allGross += earning.grossCredits;
  allNet += earning.netCredits;
  if (earning.createdAt >= monthStart) {
    monthCalls += 1;
    monthGross += earning.grossCredits;
    monthNet += earning.netCredits;
  }
  ...
}
```
(and likewise exclude from `byProject` if the panel should reflect only live earnings).

### [SEV: P2] Internal / Stripe errors leaked verbatim to the toast

**Location:** `apps/web/src/routes/app/earnings.tsx:118-121` and `apps/web/src/routes/app/earnings.tsx:147-153` (toast on `humanError(error, …)`); filter at `apps/web/src/lib/human-error.ts`.

**Problem:** `humanError` lets through any `Error.message` that is ≤200 chars and doesn't contain `"Server Error"`, `"ConvexError"`, `"Uncaught"`, or `"at handler"`. Two classes of leak pass that filter:

1. `startOnboarding` throws `"APP_ORIGIN is not configured"` and `"APP_ORIGIN must use HTTPS outside localhost"` (`convex/payouts.ts:222-226`) — both are infra/config messages that surface to the publisher toast on onboarding failure.
2. `initiatePublisherTransfer` → `transferToStripe` catches Stripe's error and `throw error` re-raises it (`convex/payouts.ts:592-596`). Stripe messages like `"No such destination account: acct_xxx"`, `"transfers: This API key doesn't have the required permissions"`, or rate-limit strings are short enough to pass the filter and land in the toast.

**Trigger:** Misconfigured `APP_ORIGIN` env, or any Stripe-side failure during onboarding/transfer.

**Impact:** Internal configuration details and raw third-party API messages exposed to publishers, contradicting the `humanError` doc-comment "Never leak internals."

**Fix:** Either broaden `humanError`'s blocklist to these known infra strings, or have the actions throw typed user-facing errors for the config/Stripe paths and fall back to the generic message for everything else:
```suggestion
// in transferToStripe catch
throw new Error("Stripe could not process the transfer. It was marked failed and can be retried.");
```
```suggestion
// in startOnboarding, replace bare throws on APP_ORIGIN branches
throw new Error("Onboarding is unavailable right now. Try again.");
```

### [SEV: P2] `?onboarding=return` is validated but never handled; URL lingers

**Location:** `apps/web/src/routes/app/earnings.tsx:50-56` (validateSearch accepts `"refresh" | "return"`) vs `apps/web/src/routes/app/earnings.tsx:107-112` (effect only acts on `"refresh"`).

**Problem:** Stripe redirects back to `/app/earnings?onboarding=return`, which `validateSearch` accepts into the search state, but the `useEffect` early-returns for anything other than `"refresh"`:
```ts
if (onboarding !== "refresh" || refreshStarted.current) return;
```
Nothing refreshes the connected-account profile on return (the page relies on the Stripe webhook + realtime subscription eventually catching up), and the `onboarding=return` query param is never stripped from the URL. A publisher returning from a successful onboarding can sit on a stale "incomplete"/"restricted" badge for the webhook latency window, and the dangling param can pollute subsequent link shares / history.

**Trigger:** Every Stripe onboarding return.

**Impact:** Confusing stale status + dirty URL after the most important moment in the flow (comparing onboarding).

**Fix:** Either navigate-clear the param on return and rely on realtime, or kick `refreshConnectedAccount` on `return`:
```suggestion
useEffect(() => {
  if (onboarding !== "refresh" || refreshStarted.current) return;
  refreshStarted.current = true;
  openOnboarding();
}, [onboarding, openOnboarding]);
// add: on "return", strip the search param or trigger a profile refresh
```

### [SEV: P3] `formatMoney` assumes every currency has 2 subunit digits

**Location:** `apps/web/src/routes/app/earnings.tsx:535-540`.

**Problem:**
```ts
function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}
```
The `/100` divisor is only valid for 2-subunit currencies. `Intl.NumberFormat` already picks the right fraction digits per currency, but the input scaling is hardcoded. For a 0-decimal currency (JPY, KRW) the stored amount is in major units, so `/100` under-displays by 100×; for 3-decimal currencies (KWD, BHD) it's off by 10×.

Currently safe because `preparePublisherTransfer` hardcodes `currency: "usd"` (`convex/payouts.ts:340`) and `projectConnectedPayout` echoes whatever Stripe sends (Stripe uses minor units consistently for the same currency), but the helper is a latent footgun the moment a non-USD payout lands.

**Trigger:** Any non-2-subunit currency in `connectedPayouts` or `publisherTransfers`.

**Impact:** Wrong amounts displayed for exotic-currency payouts once they exist.

**Fix:** Let Intl drive both digits and scaling, or assert minor-units per currency:
```suggestion
function formatMoney(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const fractionDigits = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: code,
  }).resolvedOptions().maximumFractionDigits;
  const major = amount / Math.pow(10, fractionDigits);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: code,
  }).format(major);
}
```

### [SEV: P3] `openOnboarding` effect has an unstable dependency

**Location:** `apps/web/src/routes/app/earnings.tsx:107-112`.

**Problem:** `useMutation` returns a fresh `mutate` (`openOnboarding`) on every render, and the `useEffect` depends on it:
```ts
const { mutate: openOnboarding, isPending: onboardingPending } = useMutation({ … });
useEffect(() => {
  if (onboarding !== "refresh" || refreshStarted.current) return;
  refreshStarted.current = true;
  openOnboarding();
}, [onboarding, openOnboarding]);
```
The effect re-runs every render until `refreshStarted.current` is set. The ref guard prevents double-execution today, but it's a fragile pattern: any future change that resets the ref (or a StrictMode double-invoke in dev before the guard lands) would re-fire onboarding. Pin the mutation with a ref or `useCallback` over a stable `mutate`.

**Trigger:** Dev StrictMode / future refactors.

**Impact:** Latent double-onboarding risk; today only wasted effect churn.

**Fix:**
```suggestion
const openOnboardingRef = useRef(openOnboarding);
openOnboardingRef.current = openOnboarding;
useEffect(() => {
  if (onboarding !== "refresh" || refreshStarted.current) return;
  refreshStarted.current = true;
  openOnboardingRef.current();
}, [onboarding]);
```

## Summary

- **P0: 0 · P1: 1 · P2: 3 · P3: 2 · total 6**
- Top 3:
  1. **P1 — Matured-earnings release deadlock.** `releaseMatureEarnings` has no cron and only runs inside the transfer action, which is disabled when `available === 0`. Publishers can be permanently stuck unable to pay out. Add a cron or fold the release into `getPayoutState`.
  2. **P2 — `forOrg` counts reversed/failed earnings** in all-time/month/by-project totals, contradicting the lifecycle page's separate bucketing.
  3. **P2 — Internal/Stripe errors leak to the toast** through `humanError`'s length-only filter (`APP_ORIGIN` config strings, raw Stripe messages).

**Not flagged (verified clean):** No raw Tailwind colors (only `text-destructive`/`text-muted-foreground` tokens). No `isLoading` misuse — Clerk's `isLoaded` + Convex's `isLoading` + TanStack v5 `isPending` all used correctly. Skeletons present at both `pendingComponent` and Suspense fallback. NumberTicker sources `DUR.slow` from `src/lib/motion.ts` (no hardcoded motion values) and respects `prefers-reduced-motion`. No view-transition morph required (no list→detail navigation in this route). Payout double-submit is not a real defect — `preparePublisherTransfer`'s idempotency-key + retry-existing-transfer branch plus Stripe's `idempotencyKey` make concurrent fires safe.
