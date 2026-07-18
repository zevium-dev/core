# Tiger Review — `apps/web/src/routes/app/billing.tsx` (deep-dive)

Files read in full:
- `apps/web/src/routes/app/billing.tsx` (333 lines)
- `apps/web/src/lib/stripe-ui.ts` (336 lines)
- `apps/web/src/lib/billing-cycle.ts` (not imported by this route — confirmed dead relative to billing.tsx; consumed only by `routes/admin/orgs.tsx` + `billing-cycle.test.ts`)
- `convex/billing.ts` (1048 lines)
- Cross-checked: `convex/schema.ts` (checkoutIntents/payments status unions), `apps/web/src/lib/human-error.ts`, `apps/web/src/lib/motion.ts`, `apps/web/src/components/motion/number-ticker.tsx`, `apps/web/src/styles.css` (CSS var defs).

## Verdict

**NEEDS WORK.** One real correctness defect ships to production: a fulfilled Stripe Checkout is permanently mis-rendered as “Confirming payment” because `checkoutStateFromStatus` never matches the server’s `complete` status. The same denial-list-based `humanError` leaks env/config identifiers (`STRIPE_PRICE_PACK_*`, `APP_ORIGIN`, `STRIPE_SECRET_KEY`) into user-facing toasts. The buy flow also lacks intent-level idempotency, so action retries or a post-success re-click mint orphan Stripe sessions. No blockers, no XSS, no raw Tailwind colors, no `isLoading` misuse — but the “tiger” bars are not cleared on the status-mapping defect.

## File Stats

- File: `apps/web/src/routes/app/billing.tsx`
- Lines reviewed: 333 (full) + 1048 (`convex/billing.ts`) + 336 (`stripe-ui.ts`)
- Findings: 8 — P0: 0, P1: 1, P2: 3, P3: 4

## Findings

---

### [SEV: P1] `checkoutStateFromStatus` never matches the server’s `complete` status — fulfilled checkout shows “Confirming payment” forever

**Location** — `apps/web/src/lib/stripe-ui.ts:42-57` + `convex/billing.ts:516-519`, `convex/schema.ts:215-220`

```ts
// stripe-ui.ts — succeeded cases
export function checkoutStateFromStatus(status: string): CheckoutState {
  switch (status) {
    case "succeeded":
    case "paid":
    case "completed":        // ← singular "completed"
      return "succeeded";
    case "failed":
    case "payment_failed":
    case "expired":
    case "canceled":
    case "cancelled":
      return "failed";
    default:
      return "processing";
  }
}
```

```ts
// convex/billing.ts — upsertPaidPayment patches the intent
await ctx.db.patch(intent._id, {
  stripePaymentIntentId: args.stripePaymentIntentId,
  status: "complete",       // ← server writes "complete" (not "completed")
  updatedAt: now,
});
```

```ts
// convex/schema.ts — the literal union the server actually emits
status: v.union(
  v.literal("created"),
  v.literal("open"),
  v.literal("complete"),    // ← the only “success” terminal state
  v.literal("expired"),
  v.literal("failed"),
)
```

**Problem.** `getBillingState` returns `checkout.status: Doc<"checkoutIntents">["status"]` to the client verbatim. The only terminal success value the server ever writes is `"complete"`. `checkoutStateFromStatus` accepts `"completed"` (past tense, with `d`) but not `"complete"`. So a successfully fulfilled checkout intent falls through to `default → "processing"`, and `checkoutDisplay("processing")` renders the card titled **“Confirming payment”** with body *“We are waiting for Stripe to confirm this payment. Credits are not added from this page.”*

**Impact.** User pays, Stripe webhook fires, `upsertPaidPayment` runs, the wallet is credited (the realtime `convexQuery` subscription pushes the new balance and `NumberTicker` animates up), the user returns to `/app/billing?checkout=SESSION_ID` — and sees a “Confirming payment” card next to a freshly-increased balance. The badge reads “Processing” indefinitely. The card never transitions to “Confirmed”. The only terminal states that DO render correctly are `expired` and `failed` (→ “failed”); the happy path is the one that’s broken.

This is the single highest-impact bug on the page: it misrepresents a successful payment as in-flight, in the exact surface the user checks to confirm money moved.

**Fix.** Add `"complete"` to the succeeded arm:

```ts
export function checkoutStateFromStatus(status: string): CheckoutState {
  switch (status) {
    case "succeeded":
    case "paid":
    case "complete":        // server's terminal success literal
    case "completed":
      return "succeeded";
    // …
  }
}
```

The `Doc<"checkoutIntents">["status"]` union is the source of truth — the client helper must cover every literal in it. (Note: the inverse mismatch would have been caught by a status-union-typed argument; `status: string` erases the contract. Consider typing the arg as the schema union so the compiler flags this.)

---

### [SEV: P2] `paymentStatusLabel` / `paymentStatusVariant` do not handle `partially_refunded` — partial refunds render as “Processing”

**Location** — `apps/web/src/lib/stripe-ui.ts:75-119`, `convex/schema.ts:261-266`

```ts
// schema.ts — payments.status union
status: v.union(
  v.literal("pending"),
  v.literal("paid"),
  v.literal("partially_refunded"),
  v.literal("refunded"),
  v.literal("disputed"),
  v.literal("failed"),
)

// stripe-ui.ts — label switch has no case for "partially_refunded"
export function paymentStatusLabel(status: string): string {
  switch (status) {
    case "pending":              return "Processing";
    case "succeeded":
    case "paid":                 return "Paid";
    case "failed":
    case "payment_failed":
    case "expired":              return "Failed";
    case "refunded":             return "Refunded";
    case "disputed":             return "Disputed";
    default:                     return "Processing";   // ← "partially_refunded" lands here
  }
}
```

**Problem.** `finalizeRefund` (`convex/billing.ts:594-598`) sets `status: "partially_refunded"` when `reversedCredits < grantedCredits`. The history table (both mobile and `sm:block` variants in `billing.tsx:230-300`) maps that row through `paymentStatusLabel` → `"Processing"` and `paymentStatusVariant` → `"outline"`. A user who was partially refunded sees the row labelled “Processing” — indistinguishable from a freshly-created pending payment — with no indication any credits were reversed.

**Impact.** Misleading payment history. A partial refund — money moving *back out* of the wallet — is presented as a payment still *coming in*. Reconciliation confusion, support tickets, trust erosion.

**Fix.** Add an explicit case in both helpers:

```ts
// paymentStatusLabel
case "partially_refunded": return "Partially refunded";
// paymentStatusVariant
case "partially_refunded": return "outline";   // or "secondary" to distinguish from "refunded"
```

Same root cause as P1: the label helpers take `status: string` instead of the schema union, so the compiler can’t tell you a literal is unhandled.

---

### [SEV: P2] Internal config / env-var identifiers leak into the checkout-failure toast via `humanError`’s denylist

**Location** — `apps/web/src/routes/app/billing.tsx:75-83` + `apps/web/src/lib/human-error.ts` + `convex/billing.ts:60-72, 152-156, 382`

```ts
// billing.tsx — onError
onError: (error: unknown) => {
  setCheckoutPackId(null);
  toast.error(
    checkoutStartFailureMessage(
      humanError(error, "Could not start secure checkout."),
    ),
  );
},
```

```ts
// human-error.ts — substring denylist (allowlist-by-default inverted)
if (
  msg.length > 0 &&
  msg.length <= 200 &&
  !msg.includes("Server Error") &&
  !msg.includes("ConvexError") &&
  !msg.startsWith("Uncaught") &&
  !msg.includes("at handler")
) {
  return msg;            // ← raw server message reaches the toast
}
```

```ts
// convex/billing.ts — thrown inside createCheckout / helpers
throw new Error("STRIPE_PRICE_PACK_10 is not configured");     // stripePriceForPack
throw new Error("APP_ORIGIN is not configured");                 // appOrigin
throw new Error("APP_ORIGIN must be an absolute URL");
throw new Error("APP_ORIGIN must use HTTPS outside localhost");
throw new Error("STRIPE_SECRET_KEY is not configured");          // stripeClient
throw new Error("Active organization is not provisioned");       // prepareCheckoutIntent
throw new Error("Stripe Checkout did not return a hosted URL"); // createHostedCheckout
```

**Problem.** Convex actions surface thrown `Error.message` to the client. Every one of the messages above is ≤200 chars and contains none of the four denylisted substrings (`"Server Error"`, `"ConvexError"`, `"Uncaught"`, `"at handler"`). So `humanError` returns them verbatim, and `checkoutStartFailureMessage` passes them through (it only falls back when the message is empty/whitespace). The user’s toast literally reads **“STRIPE_PRICE_PACK_10 is not configured”** or **“APP_ORIGIN must use HTTPS outside localhost”**.

**Impact.** Infrastructure detail leak: env-var names (`STRIPE_PRICE_PACK_10/50/100`, `APP_ORIGIN`, `STRIPE_SECRET_KEY`), the HTTPS/localhost origin policy, and the existence of a `stripeCustomerId` provisioning step are all exposed to end users. Denylist-based error filtering is the wrong shape — any new `throw new Error("…")` in the checkout path automatically leaks unless someone remembers to extend the denylist. This is the exact class of bug a denylist guarantees.

**Fix.** Either (a) make `humanError` an allowlist: only forward a curated set of user-safe messages, default to `fallback`; or (b) on the server, throw typed `ConvexError` instances with a `publicMessage` field and a separate `internalMessage`, and have `humanError` read only `publicMessage`. The denylist must go — it is a leak waiting for the next `throw`.

---

### [SEV: P2] `createCheckout` has no intent-level idempotency — action retries and post-success re-clicks mint orphan Stripe sessions

**Location** — `apps/web/src/routes/app/billing.tsx:58-95, 195-200` + `convex/billing.ts:244-260, 332-389`

```ts
// billing.tsx — buy button
const { mutate: buyPack, isPending: checkoutPending } = useMutation({
  mutationFn: async (packId: PackId) => {
    setCheckoutPackId(packId);
    return await createCheckout({ packId });
  },
  onSuccess: ({ url }) => { window.location.assign(url); },
  onError: (error: unknown) => { setCheckoutPackId(null); toast.error(...); },
});
// …
<Button
  className="w-full"
  disabled={button.disabled}        // button.disabled = checkoutPending
  onClick={() => buyPack(pack.packId)}
>
```

```ts
// convex/billing.ts — prepareCheckoutIntent always inserts a fresh row
const checkoutIntentId = await ctx.db.insert("checkoutIntents", {
  // … no idempotency key derived from (org, pack, client request)
  status: "created",
  // …
});

// createHostedCheckout idempotencyKey is per-intent
{ idempotencyKey: `checkout:${args.checkoutIntentId}` }
```

**Problem — two distinct failure modes:**

1. **Action retry.** `createCheckout` is a Convex `action`. Convex retries actions on transient failure (network blip, Stripe 5xx) by re-running the whole handler. `prepareCheckoutIntent` has no idempotency guard on insert — every retry mints a *new* `checkoutIntents` row with a *new* id, so `createHostedCheckout`’s `idempotencyKey: checkout:${intentId}` is a *different* key each time → Stripe creates a *distinct* Checkout Session per retry. The user is redirected to whichever URL the last attempt returns; the earlier sessions are orphaned (not charged — the user never lands on them — but they exist in Stripe and in `checkoutIntents` with `status: "open"` forever).

2. **Post-success re-click window.** `onSuccess` fires `window.location.assign(url)`. Navigation is async. Between `onSuccess` and the browser actually leaving the page, `isPending` is already `false`, so `button.disabled` flips back to `false` for *every* pack (including the just-clicked one, whose label reverts from “Redirecting to Stripe…” to “Buy $X” because `checkoutPackButton`’s “Redirecting” branch requires `isPending && selectedPackId === packId`). A second click in this window starts a *second* `createCheckout` → second intent → second Stripe session → second `window.location.assign` overwrites the first. The first session is orphaned.

The button-level `disabled={isPending}` guard *does* protect against two separate click events on the way *in* (React flushes a re-render between browser-dispatched events, so the second click lands on a disabled button). It does **not** protect the post-success window, and it does **not** protect against Convex’s own action retries.

**Impact.** No double-charge in practice (only one Checkout URL is ever shown to the user), but: orphaned `checkoutIntents` rows accumulate (`status: "open"` until the 30-min `expiresAt`, then never tombstoned), orphaned Stripe Checkout Sessions pollute the Stripe dashboard, and the Stripe customer-creation idempotency key (`customer:${organizationId}`) silently no-ops on the *second* attempt because `setStripeCustomer` short-circuits — so the second intent reuses the existing customer, masking that two sessions were created. Hard to reconcile, easy to misattribute to webhook duplication.

**Fix.** Give the client a request-scoped idempotency token (`crypto.randomUUID()` in the click handler, passed to `createCheckout`), and have `prepareCheckoutIntent` look up an existing intent by `(organizationId, clientRequestToken)` before inserting. Or: derive the Stripe idempotency key from `(organizationId, packId, clientRequestToken)` instead of `checkoutIntentId`, so retries return the *same* Stripe session. Also reset `checkoutPackId` in `onSuccess` (or use `onMutate`/`onSettled`) and keep `button.disabled` true until `window.location.assign` has actually navigated (e.g., a `navigating` ref that only clears on unmount).

---

### [SEV: P3] `BillingSkeleton` does not reserve the wallet-balance header slot or the conditional checkout-notice card → layout shift on resolve

**Location** — `apps/web/src/routes/app/billing.tsx:103-128, 313-331`

```tsx
// Resolved layout: header row has a right-aligned wallet balance
<div className="flex flex-wrap items-end justify-between gap-4">
  <div> …h1 + p… </div>
  <div className="text-right">          {/* ← wallet balance, not in skeleton */}
    <p>… Wallet balance</p>
    <p className="text-3xl …"><NumberTicker …/> <span>credits</span></p>
  </div>
</div>
{checkoutNotice ? (<Card …>…</Card>) : null}   {/* ← conditional, not in skeleton */}
```

```tsx
// Skeleton: only left-aligned header + banner + 3 cards + history
<div className="space-y-2">
  <Skeleton className="h-8 w-32" />
  <Skeleton className="h-4 w-64" />
</div>
<Skeleton className="h-20 rounded-xl" />
<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"> 3× <Skeleton h-48/> </div>
<Skeleton className="h-72 rounded-xl" />
```

**Problem.** The skeleton’s header is left-only; the resolved header is a two-column flex with the wallet balance on the right. On resolve, the balance block appears and the heading row’s vertical metrics change. When `?checkout=SESSION_ID` is present, the `checkoutNotice` Card additionally inserts between the banner and the packs grid, pushing the grid down. The skeleton has no slot for either.

**Impact.** Visible layout shift (CLS) on every billing-page load, and a second shift when a checkout notice is present. The AGENTS.md bar is “layout-stable skeletons”; this skeleton isn’t shape-matched.

**Fix.** Mirror the resolved structure in `BillingSkeleton`: a `flex justify-between` header with a right-aligned `Skeleton h-8 w-24` for the balance, and (when `?checkout` is in search) a `Skeleton h-20 rounded-xl` placeholder for the notice card.

---

### [SEV: P3] `setCheckoutPackId` is called inside `mutationFn`; `onError` resets it but `onSuccess` does not

**Location** — `apps/web/src/routes/app/billing.tsx:60-83`

```ts
const { mutate: buyPack, isPending: checkoutPending } = useMutation({
  mutationFn: async (packId: PackId) => {
    setCheckoutPackId(packId);                       // ← state setter inside mutationFn
    return await createCheckout({ packId });
  },
  onSuccess: ({ url }) => { window.location.assign(url); },   // ← no reset
  onError: (error: unknown) => {
    setCheckoutPackId(null);                        // ← reset only on error
    toast.error(...);
  },
});
```

**Problem.** Two smells: (1) `mutationFn` should be the async payload producer; React state side-effects belong in `onMutate` (pre-flight) or in the click handler. (2) Asymmetry: `onError` clears `checkoutPackId`, `onSuccess` doesn’t. Today this is masked because `window.location.assign` unmounts the component, so the stale `checkoutPackId` never re-renders. But if `window.location.assign` ever fails or is replaced with in-app navigation (plausible — the success URL is `/app/billing?checkout=…`, an in-app route), the selected pack would stay stuck on “Buy $X” with no pending state, and the asymmetry becomes visible.

**Impact.** Latent. No bug today; fragile tomorrow.

**Fix.** Move `setCheckoutPackId(packId)` into the `onClick` (before `buyPack(packId)`), and reset in `onSettled` (or both `onSuccess` and `onError`). Better: drop `checkoutPackId` entirely and read the selected pack from the mutation’s `variables` via `useMutationState` / the `variables` field — React Query already tracks which pack is in-flight.

---

### [SEV: P3] Locale-dependent formatting risks SSR hydration mismatch

**Location** — `apps/web/src/routes/app/billing.tsx:303-307, 269, 285`

```ts
function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {            // ← undefined = runtime default locale
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}
// …
{new Date(payment.createdAt).toLocaleString()}        // ← runtime default locale + timezone
```

**Problem.** `Intl.NumberFormat(undefined, …)` and `Date.prototype.toLocaleString()` resolve to the runtime’s default locale at call time. If TanStack Start SSRs this component (the route has `pendingComponent: BillingSkeleton` and uses `useSuspenseQuery`, so the table likely only renders client-side after suspense resolves — but the `head`/route shell is SSR’d), the server’s locale/timezone and the client’s differ → React hydration warning for the payment-history cells.

**Impact.** Likely no visible bug today (suspense-gated to client), but the moment SSR is extended to cover the table, hydration warnings appear. Non-deterministic output by locale.

**Fix.** Pin the locale: `new Intl.NumberFormat("en-US", …)` and `new Date(…).toLocaleString("en-US", { timeZone: "UTC" })` (or whatever the project standard is — `billing-cycle.ts` already standardizes on `en-US` + UTC for `formatCycleMonthLabel`).

---

### [SEV: P3] `validateSearch` accepts an unbounded-length `checkout` param

**Location** — `apps/web/src/routes/app/billing.tsx:42-48`

```ts
validateSearch: (search: Record<string, unknown>): BillingSearch => {
  const checkout = search.checkout;
  return typeof checkout === "string" && checkout.trim().length > 0
    ? { checkout: checkout.trim() }
    : {};
},
```

**Problem.** Any non-empty string passes — including a 100 KB blob. The value is forwarded to `getBillingState` as `checkoutSessionId` and used in a Convex index lookup (`by_checkout_session`). Convex has payload-size limits that will reject it, but the client never validates shape/length, so the failure mode is an opaque Convex error → toast (which, per the P2 above, may leak the error text).

**Impact.** Minor. No injection (server-side index lookup, `unique()` returns null on no match → no card). Just an unvalidated input funnel.

**Fix.** Cap length and character class: `/^cs_(test_)?[A-Za-z0-9]{1,200}$/` or similar Stripe session-id shape, returning `{}` on mismatch.

---

## Summary

**Counts:** P0: 0 · P1: 1 · P2: 3 · P3: 4 · Total: 8

**Top 3 to fix first:**

1. **[P1] `checkoutStateFromStatus` misses `"complete"`.** The happy path is the one that’s broken — every fulfilled checkout is permanently mislabelled “Confirming payment” next to a balance that already went up. One-line fix (add `"complete"` to the succeeded arm); consider typing the arg as the schema union so the compiler catches the next gap.

2. **[P2] `partially_refunded` renders as “Processing”.** Same root cause as #1 — `string`-typed status helpers silently fall through `default`. A refund (money *out*) is presented as a pending payment (money *in*). Add an explicit case; type the arg.

3. **[P2] `humanError` denylist leaks `STRIPE_PRICE_PACK_*` / `APP_ORIGIN` / `STRIPE_SECRET_KEY` into toasts.** Denylist-based error filtering is structurally a leak — every new `throw` in the checkout path auto-leaks. Switch to an allowlist or typed `ConvexError` with `publicMessage`/`internalMessage`.

**What’s already right (no action):** No raw Tailwind colors (all `text-muted-foreground` / `text-destructive` / `border-destructive/40` semantic tokens). No hardcoded motion values (`duration-[var(--dur-instant)] ease-[var(--ease)]`, `--dur-instant`/`--ease` defined in `styles.css`; `NumberTicker` sources `DUR.slow` from `motion.ts`). No `isLoading` misuse (`useConvexAuth().isLoading` is Convex’s own API, `useOrganization().isLoaded` is Clerk’s, `useMutation` correctly reads `isPending`). No XSS — all dynamic values (`balance`, `pack.description`, `payment.failureReason`, `payment.credits`) flow through React’s text-escaping; no `dangerouslySetInnerHTML`. `useMutation` correctly uses `.mutate()` in `onClick`, not `.mutateAsync()`. Wallet balance is realtime via `convexQuery` subscription (not stale). `BillingSkeleton` exists and is wired as `pendingComponent` + Suspense fallback. Server enforces org ownership of the checkout intent (`intent.organizationId === organization._id`) before returning it — no cross-org leak.

**Dead code note:** `apps/web/src/lib/billing-cycle.ts` is not imported by this route. It is consumed by `routes/admin/orgs.tsx` and `billing-cycle.test.ts`, so it is not globally dead — but the billing page surfaces pack purchase + payment history only, not the `cycleBreakdown` query that already exists on the server. If the product intent was to show current-cycle usage on the billing page, that’s a feature gap, not a defect.
