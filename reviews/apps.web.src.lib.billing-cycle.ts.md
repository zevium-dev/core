# Tiger Review — `apps/web/src/lib/billing-cycle.ts` + `stripe-ui.ts` + `credits-label.ts`

Scope: the three web lib helpers and their vitest suites, reviewed together
(copy/format/stripe-status surface for the billing, credits, and earnings UI).

## Verdict

Not blocker-grade, but several real correctness defects ship to production:
an accounting bucket that hides `failed` earnings inside `pending`, a
`truncateKeyId` edge case that returns the *whole* id when `tail === 0`, and
two exported status unions that are narrower than the functions that purport
to consume them. The UTC cycle labelling is correct; the credit/dollar
conversion (`CREDITS_PER_DOLLAR = 10000`) does not appear in these files, so
no conversion bug here. Float math is mostly guarded (credits are integers
upstream), but the guards are conventional rather than enforced.

## File Stats

- `billing-cycle.ts` — 84 LOC, 5 exports, 5 tests (truncated body recovered).
- `stripe-ui.ts` — 336 LOC, 14 exports, 6 test groups.
- `credits-label.ts` — 9 LOC, 1 export, 3 tests.
- No integer-cent math, no cycle-day arithmetic, no direct `CREDITS_PER_DOLLAR`
  usage in any of the three files.

## Findings

### [P1] `earningTotalsByStatus` lumps `failed` into `pending`, hiding failed transfers from operators

`stripe-ui.ts` — `earningTotalsByStatus`:

```ts
case "pending_risk":
case "allocated_to_transfer":
case "failed":
  totals.pending += earning.netCredits;
  break;
```

The `EarningTotals` shape has no `failed` bucket, so a `failed` earning
(“Transfer failed”) is summed into `pending`. The test even encodes this:
`pending: 60` for inputs `10 + 20 + 30` where `30` is `failed`.

- **Problem:** On an accounting/reconciliation surface this is wrong. `failed`
  is terminal and requires operator action (retry); `pending_risk` /
  `allocated_to_transfer` are genuinely in-flight. Conflating them means an
  operator reading “pending: 60” cannot tell that 30 of those credits are
  actually stuck and need a retry, not awaiting Stripe.
- **Impact:** Failed transfers become invisible in the totals; operators may
  believe value is healthy/pending when it is actually stuck. Reconciliation
  against Stripe transfers will not foot.
- **Fix:** Add a `failed: number` bucket to `EarningTotals`, branch `failed`
  into it, and update the test to assert the split. If the UI genuinely wants a
  single “pending” rollup, expose both `pending` (excluding failed) and
  `failed` separately so the surface is not lossy.

### [P2] `truncateKeyId` returns the entire id when `tail === 0` (`slice(-0)` is `slice(0)`)

`billing-cycle.ts`:

```ts
return `${trimmed.slice(0, head)}…${trimmed.slice(-tail)}`;
```

Verified at runtime:

```text
truncateKeyId("abcdefghij", 4, 0) === "abcd…abcdefghij"
truncateKeyId("abc", 0, 0)        === "…abc"
```

`"abc".slice(-0)` is `"abc".slice(0)` → the whole string. The guard
`head < 0 || tail < 0` only rejects negatives; `0` slips through and the
“tail” becomes the entire key.

- **Problem:** `tail` is a public parameter (default `4`). Any caller asking
  for “head only, no tail” (`truncateKeyId(id, 8, 0)`) gets the *full* secret
  printed in a monospace table cell — the opposite of truncation.
- **Impact:** Latent secret exposure in the UI for any caller that passes
  `tail: 0`. Defaults don’t trigger it, but the function signature advertises
  it as supported.
- **Fix:** Guard `tail === 0` (and `head === 0`) explicitly, or compute the
  tail via `trimmed.slice(Math.max(0, trimmed.length - tail))`. Add tests for
  `tail=0` and `head=0`.

### [P2] `truncateKeyId` bypasses truncation entirely on negative `head`/`tail` — full key leak

`billing-cycle.ts`:

```ts
if (head < 0 || tail < 0) {
  return trimmed;
}
```

Verified: `truncateKeyId("abcdefghij", -1, 4) === "abcdefghij"`.

- **Problem:** A misconfigured caller (`head: -1`) gets the untruncated id
  rendered. The docstring says “Truncate opaque key ids for monospace table
  cells”; this escape hatch silently disables the contract.
- **Impact:** Defense-in-depth failure; a single bad default at a callsite
  leaks the whole key id in the DOM.
- **Fix:** Treat negative `head`/`tail` as `0` (clamp with `Math.max(0, …)`),
  or throw. Do not return the raw id.

### [P2] Exported `PaymentStatus` type is narrower than `paymentStatusLabel`/`Variant` actually handle — type confusion

`stripe-ui.ts`:

```ts
export type PaymentStatus =
  "pending" | "succeeded" | "failed" | "refunded" | "disputed";
```

But `paymentStatusLabel` / `paymentStatusVariant` / `checkoutStateFromStatus`
all switch on `string` and additionally handle `"paid"`, `"payment_failed"`,
`"expired"`, `"canceled"`, `"cancelled"`, `"completed"`.

- **Problem:** Callers that type their status field as `PaymentStatus` will
  get a type error when the backend returns `"paid"` or `"expired"` (both very
  real Stripe webhook/checkout statuses). The exported type is a lie about
  what the function consumes, so callers either widen to `string` (losing
  safety) or omit valid statuses.
- **Impact:** Status values are silently dropped to the `default` branch
  (“Processing” / `outline`) when a typed caller narrows the union, producing
  wrong badges/labels for `paid`/`expired` payments.
- **Fix:** Either widen `PaymentStatus` to the full set the functions handle
  (and have the functions accept `PaymentStatus`, not `string`), or document
  the type as “canonical only” and keep `string` params. Today it is the worst
  of both.

### [P2] `paymentStatusLabel` / `paymentStatusVariant` have no `canceled`/`cancelled` case — inconsistent with `checkoutStateFromStatus`

`stripe-ui.ts`. `checkoutStateFromStatus` maps `canceled`/`cancelled` →
`failed`, but neither `paymentStatusLabel` nor `paymentStatusVariant` has a
case for either, so a canceled payment renders as **“Processing”** with an
`outline` badge in payment history while its checkout redirect view says
**failed**.

- **Problem:** Two surfaces disagree about the same status. A canceled payment
  in the history list looks healthy; clicking through shows failure.
- **Impact:** User confusion and support load; no test covers `canceled` in
  `paymentStatusLabel`, so the regression is silent.
- **Fix:** Add `canceled`/`cancelled` → `"Failed"` in `paymentStatusLabel` and
  `→ "destructive"` in `paymentStatusVariant` (or pick one canonical spelling
  and normalize at the boundary).

### [P2] Exported `MoneyMovementStatus` type is narrower than `moneyMovementStatusLabel` handles — same type-confusion pattern

`stripe-ui.ts`:

```ts
export type MoneyMovementStatus =
  "pending" | "processing" | "succeeded" | "failed" | "reversed" | "paid";
```

But `moneyMovementStatusLabel` switches on `string` and handles `created`,
`queued`, `in_transit`, `transferred`, `canceled` — none of which are in the
type.

- **Problem:** Identical to the `PaymentStatus` issue: a typed caller cannot
  represent `in_transit` or `transferred` without widening to `string`, yet
  the function explicitly supports them.
- **Impact:** Mis-typed status fields; silent `default` rendering for values
  the type forbids but Stripe actually emits.
- **Fix:** Reconcile the union with reality (Stripe transfer/payout statuses:
  `created`, `pending`, `in_transit`, `succeeded`/`transferred`, `paid`,
  `failed`, `canceled`, `reversed`) and have the functions take that union.

### [P2] `checkoutStartFailureMessage` echoes server `message` verbatim — can leak internal errors

`stripe-ui.ts`:

```ts
export function checkoutStartFailureMessage(message?: string): string {
  return message?.trim() || "Could not start secure checkout.";
}
```

- **Problem:** Project rule: “never leak internal errors”. This surfaces
  whatever the server returns as the user-visible failure string. If the
  checkout-start endpoint ever returns a raw stacktrace, Convex error, or
  Stripe internal message, it is rendered directly to the user.
- **Impact:** Potential information disclosure; UX depends entirely on server
  discipline that is not enforced here.
- **Fix:** Whitelist a small set of known-safe server codes/messages, or map
  server `code` → safe copy and only fall back to `message` when it matches a
  known pattern. At minimum, truncate/strip anything that looks like a path
  or stack frame.

### [P3] `creditsLabel` has no non-finite guard and no grouping — inconsistent with `formatCredits`

`credits-label.ts`:

```ts
export function creditsLabel(n: number): string {
  return `${n} credit${n === 1 ? "" : "s"}`;
}
```

- `creditsLabel(NaN)` → `"NaN credits"`; `creditsLabel(Infinity)` →
  `"Infinity credits"`.
- `creditsLabel(1000000)` → `"1000000 credits"` (no grouping), while the
  sibling `formatCredits(1000000)` → `"1,000,000"`. The catalogue detail
  header, endpoint badges, and pricing summary all use `creditsLabel`, so
  large per-call costs render ungrouped.
- `creditsLabel(1.0000000000001)` → `"1.0000000000001 credits"` — float
  precision leaks straight into the UI. `ep.cost` is a real number from the
  catalogue; nothing truncates it before label formatting.
- **Impact:** Inconsistent number formatting across the billing UI; ugly
  float/NaN renderings possible if a cost is ever fractional or undefined.
- **Fix:** Guard `!Number.isFinite(n)` → `"0 credits"` (or `"—"`), and either
  route through `formatCredits` for grouping or document that `creditsLabel`
  is only for small counts. Consider `Math.round` / integer-cost contract.

### [P3] `formatCredits` uses `Math.trunc`, not `Math.round`/`floor` — wrong rounding mode for negatives

`billing-cycle.ts`:

```ts
return Math.trunc(n).toLocaleString("en-US");
```

- **Problem:** `trunc` rounds toward zero. For positive credits this equals
  `floor` and is fine. For negative balances (refunds, chargebacks),
  `formatCredits(-1.9)` → `"-1"` while `floor` would give `"-2"`. Displaying
  `-1` when the true value is `-1.9` understates the debt.
- **Impact:** Minor; only matters if negative fractional balances reach the
  `org.balance` badge. The contract should be “credits are integers”, but it
  is not enforced, and `trunc` is the silent choice.
- **Fix:** Either assert integers (`Number.isInteger`) and keep `trunc`, or
  pick `Math.round`/`floor` deliberately and document it.

### [P3] `connectedAccountDisplay` surfaces raw Stripe `requirements` codes verbatim

`stripe-ui.ts`:

```ts
const requirementSummary = requirements.length
  ? ` Stripe still needs: ${requirements.join(", ")}.`
  : "";
```

- **Problem:** `requirements` are Stripe Connect requirement strings
  (e.g. `individual.verification.document`, `bank_account.verification`).
  Joining them raw into user-facing copy reads as internal jargon and leaks
  Stripe’s internal field taxonomy.
- **Impact:** Poor UX; minor information disclosure of Stripe’s internal model.
- **Fix:** Map known requirement codes to human labels (`“government ID”`,
  `“bank account verification”`) and use a generic fallback for unknowns.

### [P3] `formatCountdown` has no hour/day tier — long lockouts render as e.g. `"120m"`

`billing-cycle.ts`:

```ts
const m = Math.floor(s / 60);
const rem = s - m * 60;
return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
```

- **Problem:** For `totalSeconds >= 3600` the label is `"${m}m"` with no hour
  rollover. A 2-hour rate-limit shows `"120m"`.
- **Impact:** Poor readability for long countdowns; not a correctness bug.
- **Fix:** Add an hour tier (`h = floor(s/3600)`), or cap the display at
  `"59m+"` / `"hours"` once `m` exceeds a threshold.

### [P3] `checkoutDisplay` / `connectedAccountDisplay` / `earningStatusLabel` / `earningStatusVariant` have no `default` — runtime returns `undefined` if union widened unsafely

`stripe-ui.ts`. Each is an exhaustive `switch` over a closed union with no
`default` and no terminal return.

- **Problem:** TypeScript enforces exhaustiveness only as long as the param
  type is the union. All these functions accept the *union* (good), but if a
  caller ever casts (`as EarningStatus`) or the union is widened without
  updating the switch, the function returns `undefined` at runtime — the
  badge/label silently disappears.
- **Impact:** Defense-in-depth; TS catches the normal case.
- **Fix:** Add `default:` that throws or returns a safe fallback, or assert
  exhaustiveness with `const _exhaustive: never = status; return _exhaustive;`
  so a union change is a compile error.

### [P3] `earningTotalsByStatus` accumulates with `+=` on `number` — no integer guard, float drift possible

`stripe-ui.ts`. If any `netCredits` is fractional (e.g. a per-call credit
divided downstream), repeated `+=` introduces IEEE-754 drift in the totals.

- **Impact:** Low — credits are integers per `CREDITS_PER_DOLLAR = 10000`, and
  nothing in these three files performs division. But the function trusts its
  input with no `Number.isInteger` check.
- **Fix:** If the ledger guarantees integer credits, assert it; otherwise
  accumulate in integer cents/credits and round at the boundary.

## Summary

- **P0:** 0 · **P1:** 1 · **P2:** 6 · **P3:** 6 — **13 findings total.**

Top 3 to fix first:
1. **P1 — `failed` earnings hidden in `pending` bucket** (`earningTotalsByStatus`): accounting misrepresentation on an operator surface; add a `failed` bucket.
2. **P2 — `truncateKeyId` `tail === 0` returns the full id** (`slice(-0)` → `slice(0)`): latent secret exposure in monospace cells; clamp/guard zero.
3. **P2 — `PaymentStatus` / `MoneyMovementStatus` exported unions are narrower than the functions that handle them**: type confusion that silently drops real Stripe statuses (`paid`, `expired`, `in_transit`, `transferred`, `canceled`) to the `default` branch.

Notes (not findings, to close out the brief):
- **UTC cycle boundary:** `formatCycleMonthLabel` is correctly UTC-only (`timeZone: "UTC"` for the month, `getUTCFullYear` for the year) — no local-tz drift. No bug.
- **`CREDITS_PER_DOLLAR = 10000`:** not referenced in any of these three files; no credit↔dollar conversion occurs here, so no conversion bug to report.
- **Off-by-one on cycle day:** no cycle-day arithmetic exists in these files; `truncateKeyId`’s `+1` threshold and `formatCountdown`’s `s < 60` strict comparison are both correct.
- **Dead code:** none found; every export has a caller or is part of the public lib surface.
