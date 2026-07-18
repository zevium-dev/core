# Tiger Deep Review — `apps/web/src/routes/app/earnings.tsx`

Deep-dive over the prior surface review (`reviews/apps.web.src.routes.app.earnings.tsx.md`).
Read in full: `apps/web/src/routes/app/earnings.tsx` (555 ln),
`apps/web/src/components/project-earnings-panel.tsx` (112 ln),
`convex/earnings.ts` (87 ln), `convex/payouts.ts` (754 ln),
plus `convex/schema.ts`, `convex/accounting.ts`, `convex/crons.ts`,
`apps/web/src/lib/{stripe-ui,human-error,project-helpers,motion,vt}.ts`,
`apps/web/src/components/motion/number-ticker.tsx`, `apps/web/src/router.tsx`.

The prior review landed 6 findings (1 P1 / 3 P2 / 2 P3). This deep pass
**verifies all 6** and **expands to 13**: 3 P1, 4 P2, 6 P3. Two of the new
P1s are action-defects in `convex/payouts.ts` that the route surfaces
unchanged, plus a display-truncation defect in `getPayoutState`.

## Verdict

**Incorrect.** Three independent paths strand publisher earnings or
materially misstate the dashboard: (1) matured `pending_risk` earnings
never release without a cron, (2) a single failed/created/pending
`publisherTransfer` permanently shadows new `available` earnings from
ever being swept, (3) `getPayoutState` computes headline lifecycle totals
from only the 100 most recent `publisherEarnings`, undercounting
"Transferred to Stripe" for every org with >100 earnings. Plus the
`forOrg` all-time statement still credits clawed-back `reversed` rows to
the publisher, and raw Stripe failure strings leak both to the toast
and to the transfer-history table. No raw Tailwind colors, no
`isLoading` misuse on TanStack mutations, skeletons present, motion
sourced from `DUR`/`vt` — those are clean.

## File Stats

- Lines reviewed: 555 (route) · 87 (`convex/earnings.ts`) · 754 (`convex/payouts.ts`) · 112 (panel) · supporting libs (~700)
- Findings: 13 (P0: 0 · P1: 3 · P2: 4 · P3: 6)
- Prior findings verified: 6/6 (1 P1, 3 P2, 2 P3 — note prior summary said 3 P2; deep pass confirms 3 P2 in the body, not 4)

## Findings

### [SEV: P1] Matured `pending_risk` earnings never release; transfer button self-deadlocks

**Location:** `convex/payouts.ts:296` (`releaseMatureEarnings`) × `convex/payouts.ts:620` (sole caller, inside `initiatePublisherTransfer`) × `convex/crons.ts` (only `low-balance-check` scheduled) × `apps/web/src/routes/app/earnings.tsx:176` (`canTransfer = profile.status === "enabled" && earnings.available > 0`).

**Problem:** `releaseMatureEarnings` is the only mutation that flips
`pending_risk → available` once `availableAt` has passed. It is invoked
exclusively inside `initiatePublisherTransfer` (line 620), which itself
runs only when the publisher clicks the transfer button — and that
button is `disabled` when `earnings.available <= 0`. So the moment every
matured earning is stuck in `pending_risk` (the common steady state:
risk windows expire, no prior transfer has run), `earnings.available
=== 0`, `canTransfer === false`, the button is disabled, and the single
code path that calls `releaseMatureEarnings` is unreachable from the UI.

There is no cron in `convex/crons.ts` (only `checkLowBalances` hourly),
no webhook path, and no read-side release. `getPayoutState` reads
`status` verbatim, so the **Pending** card shows the matured credits
indefinitely and the transfer button stays dead.

The schema literally ships a `by_status_available` index
(`convex/schema.ts:302`) intended for exactly this release — it is
unused.

**Trigger:** Any publisher with ≥1 matured `pending_risk` earning and
zero `available` balance (the default state right after risk windows
expire and before any prior transfer).

**Impact:** Stale "Pending" display + a hard deadlock blocking all
payouts for the affected org until an operator runs the internal
mutation by hand.

**Fix:**
```ts
// convex/crons.ts
crons.hourly(
  "release-mature-earnings",
  { minuteUTC: 5 },
  internal.payouts.releaseMatureEarningsAll,
);
```
where `releaseMatureEarningsAll` iterates orgs (or scans
`by_status_available` for `["pending_risk", { lte: now }]` across orgs
and patches each to `available`). Alternatively fold the release into
the top of `getPayoutState` so the page never shows a stale bucket even
between cron ticks — but a cron is the cleaner ownership boundary
because it also unblocks the `canTransfer` gate.

---

### [SEV: P1] A failed/created/pending transfer permanently shadows new `available` earnings from being swept

**Location:** `convex/payouts.ts:317-330` (`preparePublisherTransfer` retry branch) × `convex/payouts.ts:616-634` (`initiatePublisherTransfer`) × `apps/web/src/routes/app/earnings.tsx:142-153` (toast) × `apps/web/src/routes/app/earnings.tsx:173-178` (`canTransfer` gate).

**Problem:** `preparePublisherTransfer` queries the 20 most recent
`publisherTransfers` and short-circuits the moment it finds one in
`created | pending | failed`:
```ts
const retry = priorTransfers.find(
  (transfer) =>
    transfer.status === "created" ||
    transfer.status === "pending" ||
    transfer.status === "failed",
);
if (retry !== undefined) {
  return {
    transferId: retry._id,
    connectedAccountId: retry.stripeConnectedAccountId,
    amount: retry.amount,            // old amount, old earning set
    currency: retry.currency,
    idempotencyKey: retry.idempotencyKey,  // keyed on OLD earning ids
  };
}
```
When this branch fires, the function returns the *old* transfer's
amount and idempotency key — it never re-reads the current `available`
earnings, never re-prices, never creates a new transfer. Then
`initiatePublisherTransfer` calls `transferToStripe` with that stale
payload, and on Stripe success `markPublisherTransferSucceeded` only
promotes earnings whose `transferId === retry._id` (the old failed
batch) to `transferred`.

Consequences, in order of severity:

1. **Deadlock when Stripe persistently fails.** If the old transfer
   keeps failing (deleted destination account, capability revoked,
   rate-limit storm), it stays `failed`, stays at the top of
   `priorTransfers`, and EVERY subsequent "Transfer available earnings"
   click re-sends the same dead transfer via its idempotency key. New
   `available` earnings that accrued after the failed transfer are
   never swept — not on this click, not on the next, not ever, until
   the old transfer somehow succeeds. There is no UI path to abandon a
   failed transfer, no "resolve failed transfer" affordance, and no
   operator action surfaced.

2. **Misleading success toast.** When the old failed transfer *does*
   succeed on retry, the publisher clicked "Transfer available
   earnings" expecting the displayed `earnings.available` figure to
   move. Instead, the retry re-sends the *old* batch (covering the old
   `failed` earnings), and `earnings.available` is unchanged — the new
   earnings still show as Available. The toast says "Publisher transfer
   submitted to Stripe." with no indication that the available balance
   was not actually transferred. The publisher must click a second
   time to sweep the new batch.

3. **Idempotency key is computed from the old earning id set**, so even
   if the retry branch were removed, a failed transfer's idempotency
   key (which embeds the sorted earning `_id`s) would be re-derived
   identically only if the same set of earnings is `available` — which
   it isn't once new ones accrue. The retry branch hides this by never
   re-deriving.

The `failed` case is the dangerous one; `created`/`pending` are
transient. But the branch lumps all three together and returns stale
data unconditionally.

**Trigger:** Any org that has ever had a transfer fail (Stripe-side or
our-side) AND accrues new `available` earnings afterwards. Once the
failed transfer exists, every click retries it instead of sweeping new
earnings.

**Impact:** New publisher earnings stranded with no UI path forward;
materially misleading toast on the retry-success path. This is a real
money-movement defect, not a display nit.

**Fix:** The retry should only short-circuit for the *transient*
in-flight states (`created`, `pending`) — a transfer that was prepared
but never reached Stripe. For `failed`, the correct behavior is to
re-mark that transfer's earnings back to `available` (or to a
`failed_retryable` state) and let a fresh transfer sweep the union of
old-failed + new-available earnings under a new idempotency key:
```ts
const inFlight = priorTransfers.find(
  (t) => t.status === "created" || t.status === "pending",
);
if (inFlight !== undefined) {
  return { transferId: inFlight._id, /* …stale data for in-flight only… */ };
}
// A failed transfer must NOT shadow new earnings. Either:
//  (a) release its earnings back to `available` so they rejoin the
//      next sweep, then let a new transfer be created; or
//  (b) explicitly surface "1 failed transfer blocking payouts" in the
//      UI and require operator resolution before new sweeps.
```
At minimum, the toast and button label must reflect "retrying failed
transfer" vs. "transferring available earnings" so the publisher is not
misled.

---

### [SEV: P1] `getPayoutState` computes lifecycle totals from only the 100 most recent earnings

**Location:** `convex/payouts.ts:660-668` (`.order("desc").take(100)`) × `convex/payouts.ts:684-696` (totals loop over the 100-row slice) × `apps/web/src/routes/app/earnings.tsx:227-243` (renders those totals as headline cards) × `apps/web/src/routes/app/earnings.tsx:176` (`canTransfer` gates on the truncated `available`).

**Problem:**
```ts
const earnings = await ctx.db
  .query("publisherEarnings")
  .withIndex("by_publisher", (q) =>
    q.eq("publisherOrganizationId", organization._id),
  )
  .order("desc")
  .take(100);
// …
for (const earning of earnings) {
  if (earning.status === "pending_risk") totals.pendingRisk += earning.netCredits;
  else if (earning.status === "available") totals.available += earning.netCredits;
  else if (earning.status === "allocated_to_transfer") totals.allocated += earning.netCredits;
  else if (earning.status === "transferred") totals.transferred += earning.netCredits;
  else if (earning.status === "reversed") totals.reversed += earning.netCredits;
  else totals.failed += earning.netCredits;
}
```
The `take(100)` caps the row set, but the totals loop sums *that slice*.
So every headline card — Pending / Available / In transfer / Transferred
to Stripe — reflects only the 100 most recent earnings by creation
order. For any org that has accumulated >100 earnings (the common case
for a moderately active publisher — 100 settled calls is not a high bar),
the **Transferred to Stripe** figure undercounts by every `transferred`
earning older than the 100th-newest. The all-time ledger is wrong on the
primary dashboard.

Worse, the `else totals.failed += …` branch is a catch-all: today the
schema union is `{pending_risk, available, allocated_to_transfer,
transferred, reversed, failed}` (verified `convex/schema.ts:288-294`),
so `else` only catches `failed`. But there is no `paid` literal in the
`publisherEarnings` schema (see P3 finding below), and `stripe-ui.ts`
handles a `"paid"` earning status that can never occur. The moment any
new status is added to the schema union, it silently lands in the
**failed** bucket — a latent correctness trap.

The actual transfer action (`preparePublisherTransfer`) queries
`available` earnings with **no take limit** and transfers the full
uncapped set. So the displayed "Available" can be smaller than the
amount actually transferred on the next click — the publisher sees
"$0.50 Available", clicks transfer, and a much larger amount moves to
Stripe. The displayed totals and the acted-on totals disagree.

**Trigger:** Any org with >100 lifetime `publisherEarnings` rows.

**Impact:** Materially misstated publisher dashboard for every mature
org; the `canTransfer` gate can also read `0` when older `available`
earnings exist outside the 100-row window, disabling the transfer
button incorrectly (less common, since `available` earnings tend to be
recent, but the undercount on `transferred` is the common path).

**Fix:** Compute totals from an unbounded aggregation, not from the
display slice. Either:
- run a second unbounded query (or `ctx.db.query(...).collect()` and
  sum, accepting the read cost — these tables are per-org and modest),
  or
- maintain a materialized `publisherEarningsTotals` row updated on each
  status transition (the `by_status_available` index already implies
  this read pattern is intended), or
- at minimum, split the concerns: `take(100)` for the ledger table
  display, full scan for the totals.

```ts
const allEarnings = await ctx.db
  .query("publisherEarnings")
  .withIndex("by_publisher", (q) =>
    q.eq("publisherOrganizationId", organization._id),
  )
  .collect();
const ledgerRows = allEarnings.slice(-100).reverse(); // for display
// sum totals from `allEarnings`, not `ledgerRows`
```

---

### [SEV: P2] `forOrg` counts `reversed` (clawed-back) earnings in all-time / month / by-project totals

**Location:** `convex/earnings.ts:54-71` (no status filter on the sum loop) × `apps/web/src/components/project-earnings-panel.tsx:53-90` (renders as source-of-truth).

**Problem:**
```ts
for (const earning of earnings) {
  allGross += earning.grossCredits;
  allNet += earning.netCredits;
  if (earning.createdAt >= monthStart) {
    monthCalls += 1;
    monthGross += earning.grossCredits;
    monthNet += earning.netCredits;
  }
  if (earning.projectId === undefined) continue;
  const row = rows.get(earning.projectId) ?? { calls: 0, … };
  row.calls += 1;
  row.grossCredits += earning.grossCredits;
  row.netCredits += earning.netCredits;
  rows.set(earning.projectId, row);
}
```
No `status` check. The schema union includes `reversed` and `failed`
(`convex/schema.ts:288-294`). When a Stripe transfer is reversed,
`projectStripeTransfer` (`convex/payouts.ts:560-566`) patches the
attached earnings back to `status: "reversed"` — the money returned to
the platform, the publisher did not keep it. Yet `forOrg` still credits
those rows' `grossCredits`/`netCredits` to the publisher's all-time and
month-to-date totals, and `ProjectEarningsPanel` renders them as the
"source of truth".

This contradicts the earnings route's own lifecycle cards
(`apps/web/src/routes/app/earnings.tsx:227-243`), which bucket `failed`
and `reversed` separately and exclude them from Pending / Available /
In-transfer / Transferred. Two views of the same publisher statement
disagree after any reversal.

**Nuance on `failed`:** a `failed` earning is still *owed* to the
publisher (the call settled; only the transfer failed and will retry),
so including `failed` in all-time is defensible — but it must be
consistent with the lifecycle page. `reversed` is unambiguous: the
credits were clawed back and must not count toward "you keep 95%".

**Trigger:** Any org that has ever had a transfer reversed (Stripe
`transfer.reversed` webhook).

**Impact:** Publisher-facing "all time" / "this UTC month" figures in
`ProjectEarningsPanel` overstate real retained earnings by the reversed
amount; reconciliation against the lifecycle page won't tie out.

**Fix:**
```ts
for (const earning of earnings) {
  if (earning.status === "reversed") continue;        // clawed back — exclude
  if (earning.status === "failed") continue;          // optional: match lifecycle bucketing
  allGross += earning.grossCredits;
  allNet += earning.netCredits;
  if (earning.createdAt >= monthStart) { … }
  if (earning.projectId === undefined) continue;
  // …
}
```
At minimum exclude `reversed`. Decide explicitly on `failed` and
document the choice.

---

### [SEV: P2] Internal / Stripe errors leak both to the toast AND to the transfer-history table

**Location:** `apps/web/src/routes/app/earnings.tsx:118-121` and `:147-153` (`humanError` in `onError`) × `apps/web/src/lib/human-error.ts` (length-only filter) × `convex/payouts.ts:222-226` (`APP_ORIGIN` throws in `startOnboarding`) × `convex/payouts.ts:588-597` (`transferToStripe` catch → `markPublisherTransferFailed(reason = error.message.slice(0,240))` → re-throw) × `apps/web/src/routes/app/earnings.tsx:411-435` (`TransferHistoryCard` renders `moneyMovementFailure(status, failureReason)` verbatim).

**Problem:** Two leak surfaces, both passing through the same
length-only filter:

1. **Toast leak.** `humanError` lets through any `Error.message` ≤200
   chars that doesn't contain `"Server Error"`, `"ConvexError"`,
   `"Uncaught"`, or `"at handler"`. `startOnboarding` throws
   `"APP_ORIGIN is not configured"` and `"APP_ORIGIN must use HTTPS
   outside localhost"` (`convex/payouts.ts:222-226`) — raw infra/config
   strings surfaced to the publisher toast on onboarding failure.
   `transferToStripe` catches Stripe's error, stores the raw message as
   `failureReason`, and `throw error` re-raises it through
   `initiatePublisherTransfer` to the client toast. Stripe messages
   like `"No such destination account: acct_1AbC…"`, `"transfers: This
   API key doesn't have the required permissions"`, rate-limit strings,
   and `"Your account cannot currently make transfers"` are all short
   enough to pass the filter.

2. **Transfer-history table leak (deeper than the prior review caught).**
   `markPublisherTransferFailed` persists `args.reason.slice(0, 240)` —
   the raw Stripe error message — into `publisherTransfers.failureReason`
   (`convex/payouts.ts:540-560`). `TransferHistoryCard` then renders it
   verbatim via `moneyMovementFailure(status, failureReason)` in the
   "Details" column (`apps/web/src/routes/app/earnings.tsx:425-432`):
   ```ts
   const failure = moneyMovementFailure(transfer.status, transfer.failureReason);
   // …
   {failure ?? transfer.stripeTransferId ?? "—"}
   ```
   So even if the toast were silenced, the raw Stripe error — including
   Stripe `acct_…` connected-account IDs and permission strings — is
   rendered into the publisher's DOM on every failed transfer row,
   persistently, until the transfer succeeds. This is a broader leak
   than the toast: it's stored server-side and re-rendered on every
   page load.

`moneyMovementFailure` (`apps/web/src/lib/stripe-ui.ts:325-332`)
returns `failureReason` directly when `status === "failed"` — no
sanitization.

**Trigger:** Misconfigured `APP_ORIGIN`; any Stripe-side failure during
onboarding or transfer.

**Impact:** Internal config details and raw third-party API messages
(including account identifiers) exposed to publishers, contradicting
`humanError`'s own doc-comment "Never leak internals." The persistent
table rendering is worse than the ephemeral toast.

**Fix:** Sanitize at the source — the action should throw typed
user-facing errors and store a sanitized reason:
```ts
// transferToStripe catch
await ctx.runMutation(internal.payouts.markPublisherTransferFailed, {
  transferId: transfer._id,
  reason: "Stripe could not process the transfer. It was marked failed and can be retried.",
});
throw new Error("Stripe could not process the transfer. It was marked failed and can be retried.");
```
```ts
// startOnboarding, replace bare APP_ORIGIN throws
throw new Error("Onboarding is unavailable right now. Try again.");
```
Or broaden `humanError`'s blocklist to `APP_ORIGIN`, `acct_`,
`transfers:`, `API key`. But the table leak needs the server-side
sanitization regardless — `humanError` only touches the toast path.

---

### [SEV: P2] `?onboarding=return` is validated but never handled; URL and stale status linger

**Location:** `apps/web/src/routes/app/earnings.tsx:50-56` (`validateSearch` accepts `"refresh" | "return"`) × `apps/web/src/routes/app/earnings.tsx:107-112` (effect only acts on `"refresh"`).

**Problem:** Stripe redirects back to `/app/earnings?onboarding=return`,
which `validateSearch` accepts into the search state, but the
`useEffect` early-returns for anything other than `"refresh"`:
```ts
useEffect(() => {
  if (onboarding !== "refresh" || refreshStarted.current) return;
  refreshStarted.current = true;
  openOnboarding();
}, [onboarding, openOnboarding]);
```
Nothing refreshes the connected-account profile on return — the page
relies on the Stripe webhook + the realtime Convex subscription
eventually catching up — and the `onboarding=return` query param is
never stripped from the URL. A publisher returning from a successful
onboarding can sit on a stale `"incomplete"` / `"restricted"` badge for
the webhook-latency window (seconds to minutes), and the dangling param
pollutes history and any link copied from the page.

The `"refresh"` arm has its own problem: it calls `openOnboarding()`
which does `window.location.assign(url)` — navigating *away* to Stripe
on the refresh URL. So a user who hits Stripe's "refresh" link lands
back on the app at `?onboarding=refresh`, which immediately re-launches
onboarding. If the onboarding mutation fails (e.g. the `APP_ORIGIN`
leak above), `refreshStarted.current` is already `true`, so the param
stays in the URL with no auto-retry and no user-facing explanation.

**Trigger:** Every Stripe onboarding return (`?onboarding=return`);
every Stripe onboarding refresh (`?onboarding=refresh`).

**Impact:** Confusing stale status + dirty URL after the most important
moment in the onboarding flow.

**Fix:** On `"return"`, either navigate-clear the search param and rely
on realtime, or kick `refreshConnectedAccount` for the org's connected
account:
```ts
useEffect(() => {
  if (onboarding === "refresh" && !refreshStarted.current) {
    refreshStarted.current = true;
    openOnboarding();
    return;
  }
  if (onboarding === "return") {
    // optionally trigger a profile refresh + clear the param
    navigate({ to: "/app/earnings", replace: true });
  }
}, [onboarding, openOnboarding, navigate]);
```

---

### [SEV: P2] Display USD rounding disagrees with transfer USD flooring — "≈ $X.XX" can overstate the actually-transferred cents

**Location:** `apps/web/src/lib/project-helpers.ts:8-23` (`formatCreditsAsUsd` uses `toFixed(2)` → rounds) × `convex/accounting.ts:38-44` (`creditsToUsdCents` uses `Math.floor`) × `apps/web/src/routes/app/earnings.tsx:286-293` (`EarningTotalCard` renders `≈ {formatCreditsAsUsd(value)}`) × `convex/payouts.ts:369` (`amount = creditsToUsdCents(credits)` is what actually moves).

**Problem:** Two different credit→USD conversions coexist and disagree
on rounding:

- Display: `formatCreditsAsUsd(credits)` computes `credits / 10000` and
  formats with `toFixed(2)` for amounts ≥ $0.01 — which **rounds
  half-up** (actually banker's rounding via `toFixed`).
- Transfer: `creditsToUsdCents(credits) = Math.floor((credits * 100) /
  10000) = Math.floor(credits / 100)` — which **floors** (truncates).

For 10,499 credits: display = `10499/10000 = 1.0499 → toFixed(2) =
"$1.05"` (rounds up). Transfer = `Math.floor(10499/100) = 104 cents =
$1.04`. The `EarningTotalCard` shows `≈ $1.05` for the "Available"
figure, but when the publisher clicks transfer, `creditsToUsdCents`
sends `$1.04` to Stripe. The "≈" prefix softens this, but a 1-cent
overstatement on every card, accumulated across the lifecycle, makes
the dashboard not tie out to the bank.

`formatCreditsAsUsd` also has a 4-decimal sub-cent branch
(`abs > 0 && abs < 0.01 ? 4 : 2`) — but the threshold is wrong: an
amount like `$0.0100` (exactly 1 cent, 100 credits) uses 2dp, while
`$0.0099` (99 credits) uses 4dp. There is no clean sub-cent story; the
4dp trim regex `replace(/(\.\d{2}\d*?)0+$/, "$1")` only fires in the
4dp branch, leaving e.g. `$0.0100` (2dp) untouched while `$0.0090` (4dp)
trims to `$0.009`. Inconsistent.

**Trigger:** Any credit count whose `/100` floor differs from its
`/10000` round — i.e. whenever `credits % 100 !== 0`, which is the
common case once platform-fee flooring in `publisherEarningSplit`
(`Math.floor` on the fee) produces non-round nets.

**Impact:** Dashboard "≈ $X.XX" systematically overstates the
transferred amount by up to 1 cent per card; reconciliation against
Stripe transfer amounts drifts.

**Fix:** Make display use the same floor the transfer uses:
```ts
export function formatCreditsAsUsd(credits: number): string {
  if (!Number.isFinite(credits)) return "$0.00";
  const cents = Math.floor(credits / 100);   // match creditsToUsdCents
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}
```
or have `creditsToUsdCents` and `formatCreditsAsUsd` share one
`creditsToUsdCents` helper so they cannot diverge.

---

### [SEV: P3] `formatMoney` hardcodes `/100` subunit scaling

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
The `/100` divisor is only valid for 2-subunit currencies.
`Intl.NumberFormat` picks the right fraction digits per currency, but
the input scaling is hardcoded. For a 0-decimal currency (JPY, KRW) the
stored amount is in major units, so `/100` under-displays by 100×; for
3-decimal currencies (KWD, BHD) it's off by 10×.

Currently safe because `preparePublisherTransfer` hardcodes
`currency: "usd"` (`convex/payouts.ts:379`) and `projectConnectedPayout`
echoes whatever Stripe sends (Stripe uses minor units consistently for
the same currency). But the helper is a latent footgun the moment a
non-USD payout lands — and `PayoutHistoryCard` renders whatever
`connectedPayouts` row it receives with no currency guard.

**Trigger:** Any non-2-subunit currency in `connectedPayouts` or
`publisherTransfers`.

**Impact:** Wrong amounts displayed for exotic-currency payouts once
they exist.

**Fix:** Let Intl drive both digits and scaling:
```ts
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

---

### [SEV: P3] `openOnboarding` effect depends on an unstable `mutate` reference

**Location:** `apps/web/src/routes/app/earnings.tsx:107-112`.

**Problem:** `useMutation` returns a fresh `mutate` (`openOnboarding`)
on every render, and the `useEffect` depends on it:
```ts
const { mutate: openOnboarding, isPending: onboardingPending } = useMutation({ … });
useEffect(() => {
  if (onboarding !== "refresh" || refreshStarted.current) return;
  refreshStarted.current = true;
  openOnboarding();
}, [onboarding, openOnboarding]);
```
The effect re-runs every render until `refreshStarted.current` is set.
The ref guard prevents double-execution today, but it's a fragile
pattern: any future change that resets the ref (or a StrictMode
double-invoke in dev before the guard lands) would re-fire onboarding.
Combined with the `window.location.assign` in `onSuccess`, a
double-fire would race two Stripe navigations.

**Trigger:** Dev StrictMode; future refactors that touch the ref.

**Impact:** Latent double-onboarding risk; today only wasted effect churn.

**Fix:**
```ts
const openOnboardingRef = useRef(openOnboarding);
openOnboardingRef.current = openOnboarding;
useEffect(() => {
  if (onboarding !== "refresh" || refreshStarted.current) return;
  refreshStarted.current = true;
  openOnboardingRef.current();
}, [onboarding]);
```

---

### [SEV: P3] `EarningsPageSkeleton` grid shape disagrees with the real layout

**Location:** `apps/web/src/routes/app/earnings.tsx:542-555` (skeleton) vs `apps/web/src/routes/app/earnings.tsx:225-244` (real lifecycle grid).

**Problem:** The skeleton renders the lifecycle region as:
```tsx
<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
  {Array.from({ length: 6 }).map((_, index) => (
    <Skeleton key={index} className="h-28 rounded-xl" />
  ))}
</div>
```
— 6 skeleton cards in a 3-col `xl` grid. The real content renders 4
`EarningTotalCard`s in a 4-col `xl` grid:
```tsx
<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
  <EarningTotalCard label="Pending" …/>
  <EarningTotalCard label="Available" …/>
  <EarningTotalCard label="In transfer" …/>
  <EarningTotalCard label="Transferred to Stripe" …/>
</div>
```
On first paint → content swap, the grid column count jumps 3→4 and the
card count jumps 6→4, producing a visible layout shift on the primary
dashboard — exactly what `pendingComponent` skeletons are supposed to
prevent. The UI rules require layout-stable skeletons.

**Trigger:** Every cold load / Suspense fallback → resolve on this
route.

**Impact:** Layout shift on the earnings dashboard; violates the
loading = layout-stable skeleton contract.

**Fix:** Match the real grid:
```tsx
<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
  {Array.from({ length: 4 }).map((_, index) => (
    <Skeleton key={index} className="h-28 rounded-xl" />
  ))}
</div>
```

---

### [SEV: P3] `stripe-ui` handles a `"paid"` earning status that the schema cannot produce; `getPayoutState` else-branch silently routes unknown statuses to `failed`

**Location:** `apps/web/src/lib/stripe-ui.ts:160-205` (`EarningStatus` union includes `"paid"`; `earningStatusLabel` / `earningStatusVariant` / `earningTotalsByStatus` all branch on it) × `convex/schema.ts:288-294` (`publisherEarnings.status` union has no `"paid"` literal) × `convex/payouts.ts:684-696` (`else totals.failed += …` catch-all).

**Problem:** The `EarningStatus` type in `stripe-ui.ts` includes
`"paid"`:
```ts
export type EarningStatus =
  | "pending_risk" | "available" | "allocated_to_transfer"
  | "transferred" | "paid" | "reversed" | "failed";
```
and `earningStatusLabel` / `earningStatusVariant` /
`earningTotalsByStatus` all have a `"paid"` case. But the
`publisherEarnings.status` schema union (`convex/schema.ts:288-294`) is
`{pending_risk, available, allocated_to_transfer, transferred, reversed,
failed}` — **no `"paid"`**. (`status: "paid"` only appears on the
`payments` and `connectedPayouts` tables, verified — never on
`publisherEarnings`.) So the `"paid"` branches in `stripe-ui` are dead
code that can never execute against real `publisherEarnings` data.

Meanwhile `getPayoutState`'s totals loop ends with:
```ts
else totals.failed += earning.netCredits;
```
Today that `else` only catches `failed`. But because there is no
exhaustive `switch` and no `default: throw`, the moment a new status
literal is added to the schema union, it silently lands in the
**failed** bucket — a latent correctness trap that the type system
won't catch (the route consumes `earning.status: EarningStatus` which
already includes `"paid"`, so TS won't complain when a `"paid"` row
arrives).

**Trigger:** Today: dead branches. Future: any new `publisherEarnings`
status silently mis-bucketed.

**Impact:** Dead code today; silent misclassification tomorrow.

**Fix:** Either drop `"paid"` from `EarningStatus` (and its branches) —
the bank-payout concept is modelled on `connectedPayouts`, not on
`publisherEarnings` — or add `"paid"` to the schema and handle it
explicitly in `getPayoutState`'s totals. And make the totals loop
exhaustive so a new literal is a compile error, not a silent `failed`:
```ts
switch (earning.status) {
  case "pending_risk": totals.pendingRisk += earning.netCredits; break;
  case "available": totals.available += earning.netCredits; break;
  case "allocated_to_transfer": totals.allocated += earning.netCredits; break;
  case "transferred": totals.transferred += earning.netCredits; break;
  case "reversed": totals.reversed += earning.netCredits; break;
  case "failed": totals.failed += earning.netCredits; break;
  default: {
    const _exhaustive: never = earning.status;
    throw new Error(`Unknown earning status: ${_exhaustive}`);
  }
}
```

---

### [SEV: P3] `publisherTransfers.status: "pending"` is a dead schema literal

**Location:** `convex/schema.ts:311-316` (union includes `"pending"`) × `convex/payouts.ts:317-330` (retry branch checks for it) × every `publisherTransfers` writer (`preparePublisherTransfer` writes `"created"`; `markPublisherTransferSucceeded` writes `"succeeded"`; `markPublisherTransferFailed` writes `"failed"`; `projectStripeTransfer` writes `"succeeded" | "failed" | "reversed"`).

**Problem:** No code path ever writes `status: "pending"` to a
`publisherTransfers` row (verified by grep — `"pending"` writers only
appear in `webhooks.ts` and `connectedPayouts`, never on
`publisherTransfers`). Yet `preparePublisherTransfer`'s retry branch
defensively matches it:
```ts
const retry = priorTransfers.find(
  (transfer) =>
    transfer.status === "created" ||
    transfer.status === "pending" ||   // never written
    transfer.status === "failed",
);
```
The literal exists in the schema but is unreachable. Combined with the
P1 finding above — where this retry branch is the source of the
shadowing deadlock — the `"pending"` arm is both dead and part of a
defective short-circuit.

**Trigger:** Never (today).

**Impact:** Dead schema literal; misleading retry defense.

**Fix:** Either remove `"pending"` from the schema union and the retry
branch, or actually use it for the in-flight Stripe-call window
(between `transfers.create` succeeding and
`markPublisherTransferSucceeded` running) so the retry branch has a
real signal. If keeping it, narrow the retry to only the genuinely
in-flight `created` state (see P1 fix above).

---

### [SEV: P3] `NumberTicker` re-animates on every realtime Convex push — financial figures constantly flash

**Location:** `apps/web/src/components/motion/number-ticker.tsx:48-87` (effect keyed on `value`) × `apps/web/src/routes/app/earnings.tsx:286-293` (`EarningTotalCard` renders `<NumberTicker value={value} />` for Pending/Available/In-transfer/Transferred) × `apps/web/src/components/project-earnings-panel.tsx:113,121,132`.

**Problem:** `useSuspenseQuery(convexQuery(api.payouts.getPayoutState,
{}))` is a realtime subscription — Convex pushes new `payoutState` on
every `publisherEarnings` / `publisherTransfers` /
`connectedPayouts` mutation. Each push changes the `value` prop on
every `NumberTicker` in the four `EarningTotalCard`s, which retriggers
the 600ms count-up animation. For an active publisher (earnings
settling continuously, webhook-driven status transitions, cron-driven
releases), the headline figures are perpetually mid-animation — making
the actual numbers hard to read exactly when the publisher is looking
at them.

`NumberTicker` does respect `prefers-reduced-motion` (renders final
value immediately), which mitigates this for affected users. But for
default users, the financial dashboard is the one place where a stable,
readable number matters more than a count-up flourish.

**Trigger:** Any realtime update to `payoutState` while the earnings
page is mounted.

**Impact:** Distracting constant animation on financial figures;
readability suffers for active orgs.

**Fix:** Either skip the animation when the delta is small (e.g.
`Math.abs(to - from) < value * 0.01` → snap), or add a `stable` prop on
`EarningTotalCard`'s usage that disables count-up for financial
total cards, or debounce the animation while the subscription is
actively pushing (e.g. only animate on the last value after 500ms of
quiescence).

---

## Summary

- **P0: 0 · P1: 3 · P2: 4 · P3: 6 · total 13**
- Top 3:
  1. **P1 — Matured-earnings release deadlock.** `releaseMatureEarnings`
     has no cron and only runs inside the transfer action, which is
     disabled when `available === 0`. Publishers can be permanently
     stuck unable to pay out. Add a cron (the `by_status_available`
     index already exists for this) or fold the release into
     `getPayoutState`.
  2. **P1 — Failed transfer permanently shadows new available
     earnings.** `preparePublisherTransfer`'s retry branch returns
     stale data for any `failed`/`created`/`pending` prior transfer,
     so every "Transfer available earnings" click re-sends the old
     batch instead of sweeping new earnings. New earnings are stranded
     with no UI path until the old transfer succeeds — and if it
     persistently fails, they're stranded forever. Narrow the retry to
     in-flight `created` only; release `failed` earnings back to
     `available` for re-sweep.
  3. **P1 — `getPayoutState` totals computed from only the 100 most
     recent earnings.** Every headline lifecycle card undercounts for
     orgs with >100 earnings (the common mature-publisher case), and
     `canTransfer` can read `0` when older `available` earnings exist
     outside the window. Sum totals from an unbounded scan; keep
     `take(100)` only for the ledger table display.

**Verified clean (no regressions vs. prior review):** No raw Tailwind
colors — only `text-destructive`, `text-muted-foreground`,
`text-secondary`-via-`Badge` semantic tokens. No `isLoading` misuse —
TanStack v5 `isPending` on both `useMutation`s; `useConvexAuth`'s
`isLoading` is the Convex-specific hook with no `isPending` alternative
and is gated alongside Clerk's `isLoaded`. `.mutate()` used in onClick
handlers (never `.mutateAsync()`). Skeletons present at both
`pendingComponent` and `EarningsPage` early-return + Suspense fallback
(the skeleton *shape* is wrong — see P3 — but skeletons exist).
NumberTicker sources `DUR.slow` from `src/lib/motion.ts` (no hardcoded
motion values) and respects `prefers-reduced-motion`. No list→detail
navigation in this route, so no per-element `viewTransitionName` is
required; the global `defaultViewTransition` in `router.tsx` +
`app.tsx`'s `main-content` morph covers route-level transitions. Payout
double-submit is prevented at the button level (`transferPending`
disables), but the underlying idempotency story is defective (see P1 #2).
