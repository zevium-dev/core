# Tiger Review — `apps/web/src/routes/app/billing.tsx`

Scope: `apps/web/src/routes/app/billing.tsx`, `apps/web/src/lib/stripe-ui.ts`,
`apps/web/src/lib/billing-cycle.ts`, `convex/billing.ts` (server context).

## Verdict

**Incorrect.** The primary user-facing success state is wrong: a fulfilled
checkout intent (`status: "complete"`) is classified as `"processing"` by
`checkoutStateFromStatus`, so the confirmation card lies indefinitely after the
wallet is already credited. Compounded by a real double-click race on the buy
button and internal config strings leaking into the toast. No blockers / no
security issues.

## File Stats

| File | Lines | Findings |
|---|---|---|
| `apps/web/src/routes/app/billing.tsx` | 333 | 4 |
| `apps/web/src/lib/stripe-ui.ts` | 336 | 1 |
| `convex/billing.ts` | 1048 | 1 (context only) |
| `apps/web/src/lib/billing-cycle.ts` | 84 | 0 |

## Findings

### [SEV: P1] Completed checkout displayed as "Confirming payment"

**Location:** `apps/web/src/lib/stripe-ui.ts:32-52` (`checkoutStateFromStatus`); consumed in `apps/web/src/routes/app/billing.tsx:108-110`.

```ts
export function checkoutStateFromStatus(status: string): CheckoutState {
  switch (status) {
    case "succeeded":
    case "paid":
    case "completed":        // ← never produced by the server
      return "succeeded";
    case "failed":
    case "payment_failed":
    case "expired":
    case "canceled":
    case "cancelled":
      return "failed";
    default:
      return "processing";   // ← "complete" lands here
  }
}
```

**Problem.** The server (`convex/billing.ts`, `upsertPaidPayment`, line ~470)
patches the checkout intent to `status: "complete"` *after* the wallet has
been credited via `grantPaymentCredits`. The schema enum
(`convex/schema.ts:215-221`) is `created | open | complete | expired | failed`.
`checkoutStateFromStatus` matches the literal `"completed"` (with a `d`),
which the server never emits, so the real `"complete"` status falls through to
the `default` → `"processing"` branch.

**Impact.** When a buyer returns to `/app/billing?checkout=SESSION_ID` after
the webhook has fulfilled the payment, the confirmation card renders:

> Confirming payment — We are waiting for Stripe to confirm this payment.
> Credits are not added from this page.

…while the `NumberTicker` wallet balance simultaneously animates upward
(via the realtime subscription). The success state is unreachable: the only
two terminal states the UI can express are `processing` and `failed`; the
card persists with the wrong copy until the `?checkout=` query param is
stripped from the URL. This is the primary success path of the billing page.

**Fix.**
```ts
export function checkoutStateFromStatus(status: string): CheckoutState {
  switch (status) {
    case "succeeded":
    case "paid":
    case "completed":
    case "complete":
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

---

### [SEV: P2] Double-click on "Buy" fires two concurrent checkout mutations

**Location:** `apps/web/src/routes/app/billing.tsx:79-97`, `:259-264`.

```tsx
const { mutate: buyPack, isPending: checkoutPending } = useMutation({
  mutationFn: async (packId: PackId) => {
    setCheckoutPackId(packId);
    return await createCheckout({ packId });
  },
  onSuccess: ({ url }) => {
    window.location.assign(url);
  },
  …
});
…
<Button
  className="w-full"
  disabled={button.disabled}            // button.disabled = isPending
  onClick={() => buyPack(pack.packId)}
>
```

**Problem.** The button's `disabled` state is derived from React Query's
`isPending`, which only flips `true` after the mutation is registered and React
re-renders. A user double-clicking within the same tick (~16ms) fires
`buyPack` twice before the re-render disables the button. React Query v5
`useMutation` switches to the second mutation but the first keeps running, so
**two** `createCheckout` actions reach the server. Each call to
`prepareCheckoutIntent` (`convex/billing.ts:170`) inserts a fresh
`checkoutIntents` doc with a new id, and `createHostedCheckout`
(`convex/billing.ts:225`) uses `idempotencyKey: checkout:${checkoutIntentId}`
— distinct per intent, so Stripe creates **two** independent Checkout Sessions.
Both `onSuccess` callbacks then race to call `window.location.assign(url)`; the
second wins and the user pays exactly once. The first session is orphaned in
`status: "open"` for 30 minutes.

This is **not** a double-charge (the user only completes one hosted Checkout
session), but it is a real race producing orphaned intents, a wasted Stripe
`customers.create` round-trip, and nondeterministic redirect target.

**Fix.** Guard with a synchronous ref so the second click is a no-op before the
re-render, and move the `setCheckoutPackId` side-effect out of `mutationFn`
into `onMutate` where it belongs.

```tsx
const inFlightRef = useRef<PackId | null>(null);
const { mutate: buyPack, isPending: checkoutPending } = useMutation({
  mutationFn: async (packId: PackId) => {
    inFlightRef.current = packId;
    return await createCheckout({ packId });
  },
  onMutate: (packId) => setCheckoutPackId(packId),
  onSuccess: ({ url }) => {
    window.location.assign(url);
  },
  onError: (error: unknown) => {
    setCheckoutPackId(null);
    toast.error(
      checkoutStartFailureMessage(
        humanError(error, "Could not start secure checkout."),
      ),
    );
  },
  onSettled: () => {
    inFlightRef.current = null;
  },
});
…
<Button
  className="w-full"
  disabled={button.disabled || inFlightRef.current !== null}
  onClick={() => buyPack(pack.packId)}
>
```

---

### [SEV: P2] Internal config errors leak into the checkout toast

**Location:** `apps/web/src/routes/app/billing.tsx:91-96`; `apps/web/src/lib/human-error.ts:6-24`.

```tsx
onError: (error: unknown) => {
  setCheckoutPackId(null);
  toast.error(
    checkoutStartFailureMessage(
      humanError(error, "Could not start secure checkout."),
    ),
  );
},
```

**Problem.** `createCheckout` is a Convex **action**, and action-thrown errors
surface their raw `.message` to the client (unlike mutations, which arrive
wrapped as `"Uncaught …"`). `humanError` only suppresses messages containing the
substrings `"Server Error"`, `"ConvexError"`, `"Uncaught"`, or `"at handler"`.
Several action error paths pass through unfiltered:

- `stripePriceForPack` → `"STRIPE_PRICE_PACK_10 is not configured"`
- `appOrigin` → `"APP_ORIGIN is not configured"` / `"APP_ORIGIN must be an
  absolute URL"` / `"APP_ORIGIN must use HTTPS outside localhost"`
- `stripeClient` → `"STRIPE_SECRET_KEY is not configured"`
- `setStripeCustomer` → `"Checkout intent not found"`, `"Payment profile not found"`
- `attachCheckoutSession` → `"Checkout intent already has a different Stripe session"`

Each of these is ≤200 chars and contains no forbidden substring, so it is
rendered verbatim in the toast — leaking internal environment-variable names,
the existence of a `payment profile` table, and Stripe session bookkeeping
details to the buyer. The project rule is "never leak internal errors".

**Fix.** Whitelist the *expected* user-facing action errors (e.g. a typed
`ConvexError` with a known code) and fall back to the generic copy for
everything else; do not pass `error.message` through a substring denylist for
action results.

```ts
// human-error.ts — replace substring denylist with explicit allowlist
export function humanError(
  err: unknown,
  fallback = "Something went wrong. Try again.",
): string {
  if (err instanceof ConvexError && typeof err.data === "string") {
    return err.data;
  }
  return fallback;
}
```
(Throw the user-facing messages as `ConvexError` from the action so they are
typed and intentional; everything else returns the fallback.)

---

### [SEV: P2] Refunded / partially-refunded payments display the full granted credits

**Location:** `apps/web/src/routes/app/billing.tsx:213-216` (mobile) and
`:283-285` (table); source data in `convex/billing.ts` `getBillingState` return
`credits: payment.grantedCredits` (line ~970).

```tsx
<span className="tabular-nums">
  {payment.credits.toLocaleString()}
</span>
```

**Problem.** `payment.credits` is bound to `grantedCredits` on the server, not
`grantedCredits - reversedCredits`. For a `refunded` or `partially_refunded`
payment (status produced by `finalizeRefund` / `finalizeDispute` in
`convex/billing.ts`), the row shows the badge "Refunded" / "Disputed" alongside
the *original* credit grant — e.g. a fully refunded pack still reads
"100,000" in the Credits column with no indication that those credits were
reversed. `failureReason` is `undefined` for refunds (it is only set on
failed/disputed paths), so the Details column shows "—", reinforcing the
impression that the credits remain.

**Impact.** A buyer who reversed a charge appears to still hold the credits.
Misleading accounting surface; not a data issue (the wallet balance is
correct) but a display correctness defect on a financial history table.

**Fix.** Expose `reversedCredits` (and/or a derived `netCredits`) from
`getBillingState` and render the net, or annotate the row when
`reversedCredits > 0`.

```ts
// convex/billing.ts — getBillingState payments mapping
payments: payments.map((payment) => ({
  …
  credits: payment.grantedCredits,
  reversedCredits: payment.reversedCredits,
  …
})),
```
```tsx
<span className="tabular-nums">
  {payment.credits.toLocaleString()}
  {payment.reversedCredits > 0 ? (
    <span className="ml-1 text-destructive">
      (−{payment.reversedCredits.toLocaleString()})
    </span>
  ) : null}
</span>
```

---

### [SEV: P3] `setCheckoutPackId` called inside `mutationFn`

**Location:** `apps/web/src/routes/app/billing.tsx:81-84`.

```tsx
mutationFn: async (packId: PackId) => {
  setCheckoutPackId(packId);
  return await createCheckout({ packId });
},
```

**Problem.** `mutationFn` is the async unit-of-work; React Query's contract is
that `onMutate` is the place for pre-mutation side-effects (it runs
synchronously before `mutationFn`, and is the documented callback for
optimistic state). Calling `setState` inside `mutationFn` works today but
couples UI state to the network call's scheduling and makes the optimistic
"which pack is pending" state unavailable to `onError` rollback reasoning in
any future refactor. Minor — no observable bug at present.

**Fix.** Move to `onMutate` (shown in the P2 fix above).

---

### [SEV: P3] Disabled non-selected pack buttons still read "Buy $X"

**Location:** `apps/web/src/lib/stripe-ui.ts:55-66`, consumed at
`apps/web/src/routes/app/billing.tsx:247-252`.

```ts
label:
  isPending && selectedPackId === packId
    ? "Redirecting to Stripe…"
    : `Buy ${priceLabel}`,
```

**Problem.** While a checkout is pending, every non-selected pack button is
`disabled: true` (correct) but still displays "Buy $50" / "Buy $100" rather
than a pending hint. Disabled buttons that read "Buy" invite the click that
does nothing, and there is no `aria-busy` on the form. Cosmetic, but the
function already receives `isPending` and could trivially return a neutral
label for the disabled case.

**Fix.**
```ts
label:
  isPending && selectedPackId === packId
    ? "Redirecting to Stripe…"
    : isPending
      ? "Please wait…"
      : `Buy ${priceLabel}`,
```

---

## Non-issues (checked, no defect)

- **`isPending` vs `isLoading`**: `useMutation`'s `isPending` is the correct
  v5 name; `useConvexAuth().isLoading` is that hook's own API. No misuse.
- **Raw Tailwind colors**: every color in the route uses semantic tokens
  (`text-muted-foreground`, `text-destructive`, `border-destructive/40`).
- **Hardcoded motion**: card hover uses `duration-[var(--dur-instant)]`
  `ease-[var(--ease)]`; `NumberTicker` sources `DUR.slow` from `#/lib/motion`.
  No `duration-300 ease-in-out`.
- **Skeletons**: `pendingComponent: BillingSkeleton`, auth/org-gate fallback,
  and `<Suspense fallback={<BillingSkeleton />}>` all covered.
- **XSS**: balance and credit values are `number` rendered via `NumberTicker`
  (`{text}`) and `toLocaleString()`; `failureReason` is rendered as React text
  children. No `dangerouslySetInnerHTML`. No injection surface.
- **Realtime balance**: `getBillingState` is a Convex query subscribed via
  `convexQuery` + `useSuspenseQuery`; wallet credits from the webhook flow
  through automatically. The stale-looking notice is the P1 above, not a stale
  balance.
- **Idempotency on the server**: `createHostedCheckout` uses
  `idempotencyKey: checkout:${checkoutIntentId}` and `customers.create` uses
  `customer:${organizationId}`, so concurrent calls do not duplicate Stripe
  objects. The double-click problem above is orphaned intents, not double
  charges.

## Summary

- **6 findings** — P1: 1, P2: 3, P3: 2.
- **Top 3 to fix before merge:**
  1. Add `"complete"` to the succeeded branch of `checkoutStateFromStatus`
     (P1) — the success notice is unreachable today.
  2. Guard the buy button against sub-render double-clicks with a synchronous
     ref (P2) — eliminates orphaned checkout intents.
  3. Stop surfacing raw action error messages in the toast (P2) — internal
     config strings (`STRIPE_PRICE_PACK_*`, `APP_ORIGIN`) leak to buyers.
