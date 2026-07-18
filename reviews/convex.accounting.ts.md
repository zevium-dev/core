# Tiger-Style Review — `convex/accounting.ts`

## Verdict
NEEDS WORK — small file, but it sits at the root of every revenue-split and payout computation in the system. Two real correctness defects (silent sub-cent credit loss on payout, integer-overflow in the split math) plus several latent gaps worth closing before this is load-bearing.

## File Stats
- **Path:** `convex/accounting.ts`
- **LOC:** 43
- **Role:** Pure helpers for the credit ledger / accounting subsystem. Defines the integer-credit model (`CREDITS_PER_USD = 10_000`), the canonical 95/5 publisher/platform split (`publisherEarningSplit`), the credits→Stripe-cents conversion (`creditsToUsdCents`), and the publisher risk-hold window (`PUBLISHER_RISK_HOLD_MS`). Consumed by `convex/wallets.ts` (`recordUsage` settlement + `publisherEarnings` insert) and `convex/payouts.ts` (`preparePublisherTransfer` amount computation).
- **Callers (grep):**
  - `convex/wallets.ts:13` — `PUBLISHER_RISK_HOLD_MS`, `publisherEarningSplit` (inside `recordUsage`, per usage event).
  - `convex/payouts.ts:12` — `creditsToUsdCents` (inside `preparePublisherTransfer`, over the sum of all `available` earnings).
  - `convex/stripe-connect.test.ts:7` — `publisherEarningSplit` only. `creditsToUsdCents` has **no test**.

---

## Findings

### [SEV: P1] Sub-cent residual credits are silently destroyed on every publisher transfer

**Location:** `convex/accounting.ts:38-43` (`creditsToUsdCents`), consumed at `convex/payouts.ts:368-369`.

```ts
export function creditsToUsdCents(credits: number): number {
  if (!Number.isSafeInteger(credits) || credits < 0) {
    throw new Error("Credits must be a non-negative safe integer");
  }
  return Math.floor((credits * 100) / CREDITS_PER_USD);
}
```

**Problem:** `creditsToUsdCents` floors to whole cents. `CREDITS_PER_USD = 10_000` and `100 cents = $1`, so `1 cent = 100 credits`. For any `credits` not divisible by 100, the remainder `credits % 100` credits (up to 99 credits = $0.0099) is discarded by the floor.

The caller `preparePublisherTransfer` does:
```ts
const credits = earnings.reduce((total, earning) => total + earning.netCredits, 0);
const amount = creditsToUsdCents(credits);
// ...patches ALL those earnings to status:"allocated_to_transfer" (then later "transferred")
```

So the full `netCredits` of every earning row is marked `transferred`, but only `amount` cents (`= floor(credits/100)*100` credits worth) is actually sent to Stripe. The residual `credits % 100` credits are marked `transferred` in the ledger while never being paid out. There is no `residualCredits` field on `publisherTransfers` or `publisherEarnings`, no platform-side credit grant for the residual, no carry-forward into the next transfer. The credits simply vanish from the accounting system.

Concrete: a publisher with one `available` earning row of `netCredits = 95_001` (test-fixture scale) yields `amount = floor(95001/100) = 950` cents = $9.50. The earning is marked `transferred` for 95,001 credits; only 95,000 credits ($9.50) hit Stripe. 1 credit is unaccounted for. Over thousands of transfers across all publishers, the drift accumulates and the ledger no longer reconciles: `sum(transferred.netCredits) * 100 / 10000 ≠ sum(transfers.amount)`.

The docstring says "never round credits up when transferring" — the floor is intentional, but the *consequence* (residual credits deleted from the ledger with no audit trail) is not handled anywhere.

**Impact:** Accounting integrity violation. The `publisherEarnings` ledger claims credits were "transferred" that were never disbursed; platform implicitly retains the residual with no corresponding revenue entry. Reconciliation between `publisherEarnings.netCredits` and `publisherTransfers.amount` will never tie out. This is the kind of defect a financial audit flags immediately.

**Fix:** Track and reconcile the residual. Either (a) carry the residual forward by reducing the patched `netCredits`/adding a residual field, or (b) grant the sub-cent residual to the platform on transfer (with a `platform_grant` ledger entry) so the books balance. Minimal version:
```ts
export function creditsToUsdCents(credits: number): number {
  if (!Number.isSafeInteger(credits) || credits < 0) {
    throw new Error("Credits must be a non-negative safe integer");
  }
  return Math.floor(credits / (CREDITS_PER_USD / 100)); // = Math.floor(credits / 100)
}

// in preparePublisherTransfer, after computing amount:
const paidCredits = amount * (CREDITS_PER_USD / 100); // cents → credits
const residualCredits = credits - paidCredits; // 0..99
// record residualCredits somewhere (platform grant, or carry to next transfer)
```

---

### [SEV: P2] `publisherEarningSplit` overflows `Number.MAX_SAFE_INTEGER` in the multiplication despite validating the input

**Location:** `convex/accounting.ts:24-29`.

```ts
if (!Number.isSafeInteger(grossCredits) || grossCredits < 0) {
  throw new Error("Gross credits must be a non-negative safe integer");
}
const platformFeeCredits = Math.floor(
  (grossCredits * PLATFORM_FEE_BASIS_POINTS) / BASIS_POINTS_DENOMINATOR,
);
```

**Problem:** The guard validates `grossCredits` is a safe integer, but the computation `grossCredits * PLATFORM_FEE_BASIS_POINTS` (= `grossCredits * 500`) is *not* a safe integer once `grossCredits > Number.MAX_SAFE_INTEGER / 500 ≈ 1.8 × 10^13` (≈ $1.8B in a single earning row). Above that threshold the multiplication loses precision *before* `Math.floor`, so the platform fee can be off by one or more credits, and `grossCredits * 0.05` no longer equals `platformFeeCredits` even with flooring.

This is reachable in principle: `publisherEarningSplit` is a public, exported pure function with no caller-side cap on `grossCredits`. A batched settlement, a future migration replaying historical usage, or an admin tool could plausibly pass a large aggregate.

**Impact:** Silent incorrect 5%/95% split at extreme scale; platform-fee math drifts from the documented "exactly five percent" guarantee.

**Fix:** Use the mathematically-equivalent, overflow-safe form. `floor(g * 500 / 10000) === floor(g / 20)` and the division form stays exact for every safe-integer `g`:
```ts
const platformFeeCredits = Math.floor(grossCredits / (BASIS_POINTS_DENOMINATOR / PLATFORM_FEE_BASIS_POINTS));
// i.e. Math.floor(grossCredits / 20)
```
Or compute in `BigInt` and convert back. Either way, also assert `Number.isSafeInteger(platformFeeCredits)` before returning.

---

### [SEV: P2] `creditsToUsdCents` overflows on realistic aggregate earnings and throws a misleading error

**Location:** `convex/accounting.ts:38-43`, consumed at `convex/payouts.ts:366-369`.

```ts
return Math.floor((credits * 100) / CREDITS_PER_USD);
```

**Problem:** `credits * 100` exceeds `Number.MAX_SAFE_INTEGER` once `credits > 9.007 × 10^13` (≈ $9B). Unlike `publisherEarningSplit`, this is called against an *aggregate*: `preparePublisherTransfer` sums **all** `available` earnings for a publisher (`earnings.reduce((t, e) => t + e.netCredits, 0)`). Two problems compound:

1. The `reduce` itself overflows safe-integer range with no guard — the sum silently loses precision *before* `creditsToUsdCents` is called.
2. `creditsToUsdCents` then validates the already-corrupted sum with `Number.isSafeInteger(credits)`. If the corrupted sum happens to still be a safe integer (likely, since float rounding tends to land on representable values), no error is thrown and a wrong cent amount is sent to Stripe. If it does throw, the error message `"Credits must be a non-negative safe integer"` is surfaced through `initiatePublisherTransfer` (a `action` invoked by the publisher UI) — leaking an internal invariant as a confusing user-facing error.

**Impact:** Wrong Stripe transfer amount for whale publishers, or an opaque error thrown at the publisher boundary. Either way the 5%/95% guarantee is violated at scale.

**Fix:** Sum in `BigInt` and validate the aggregate before conversion; cap or reject transfers that exceed safe-integer cents. At minimum, guard the multiplication:
```ts
export function creditsToUsdCents(credits: number): number {
  if (!Number.isSafeInteger(credits) || credits < 0) {
    throw new Error("Credits must be a non-negative safe integer");
  }
  // credits / 100 is exact for all safe integers; credits * 100 is not.
  return Math.floor(credits / (CREDITS_PER_USD / 100));
}
```
And in `preparePublisherTransfer`, switch the reduce to a BigInt accumulator or assert each `netCredits` and the running sum stay safe.

---

### [SEV: P2] Float division `(grossCredits * 500) / 10000` can produce an off-by-one fee even below the hard overflow threshold

**Location:** `convex/accounting.ts:27-29`.

**Problem:** The current form multiplies first (`grossCredits * 500`), then divides by `10000`, then floors. For large-but-still-safe `grossCredits`, the intermediate product `grossCredits * 500` may not be exactly representable in float64 (e.g. values above 2^53 lose integer precision). When that happens, `Math.floor` operates on a value already off by ±1 from the true mathematical product, so `platformFeeCredits` can be one credit lower or higher than the true `floor(gross / 20)`. The `gross = fee + net` invariant is preserved structurally (net = gross − fee), but the fee itself is wrong, so the platform's actual take deviates from 5%.

`Math.floor(grossCredits / 20)` is exact for every safe-integer `grossCredits` because the division result stays well within float64 precision (≤ ~4.5 × 10^14, 15 significant digits).

**Impact:** Off-by-one platform fee on large settlements; platform revenue reconciliation drift.

**Fix:**
```ts
const platformFeeCredits = Math.floor(grossCredits / 20);
```
or derive the divisor from the constants to keep intent clear:
```ts
const platformFeeCredits = Math.floor(
  grossCredits / (BASIS_POINTS_DENOMINATOR / PLATFORM_FEE_BASIS_POINTS),
);
```

---

### [SEV: P3] Asymmetric rounding direction drifts publisher take away from 95%

**Location:** `convex/accounting.ts:27` (fee floored) and `convex/accounting.ts:42` (cents floored).

**Problem:** `publisherEarningSplit` floors the platform fee, which favors the publisher on the way *in* (publisher gets the rounded-down residual). `creditsToUsdCents` floors the cent amount, which disfavors the publisher on the way *out* (publisher loses the sub-cent residual — see P1). The two directions compound: a publisher's realized take is `floor(netCredits / 100) * 100` cents, while `netCredits = grossCredits - floor(grossCredits / 20)`. The effective percentage is not exactly 95% in either direction, and the asymmetry is undocumented.

**Impact:** Minor, but the product contract says "publishers keep 95%". The math realizes 94.99…% / 95.00…% depending on residuals. Worth a one-line doc note clarifying the intended rounding policy on both boundaries.

**Fix:** Document both rounding decisions in one place, or pick a single consistent direction (e.g. always floor against the platform on both split and payout) and reconcile residuals per P1.

---

### [SEV: P3] `publisherEarningSplit(0)` is accepted, enabling zero-value `publisherEarnings` rows downstream

**Location:** `convex/accounting.ts:24-29`.

**Problem:** The contract allows `grossCredits === 0` ("non-negative safe integer"). The sole caller `recordUsage` only rejects `event.credits < 0`, so a usage event with `credits === 0` flows through `publisherEarningSplit(0)` → `{0, 0, 0}` and inserts a `publisherEarnings` row with all-zero amounts and `status: "pending_risk"`. These rows transition through the full lifecycle (`pending_risk → available → …`) polluting the `by_status_available` and `by_publisher` indexes forever; `preparePublisherTransfer` will skip them only because their `netCredits` contributes 0 to the sum.

**Impact:** Ledger/index pollution; inflated row counts; wasted storage and scan cost. Not a correctness defect in `accounting.ts` itself (0 is a valid input by the stated contract), but the function is the natural place to enforce a positive minimum if zero settlements are nonsensical.

**Fix:** Either tighten the contract (`grossCredits > 0`) or document that 0 is intentionally permitted and the caller must filter. Given the product (per-call metering, a zero-credit call is a no-op), rejecting 0 here is cleaner.

---

### [SEV: P3] `creditsToUsdCents` has zero test coverage

**Location:** `convex/stripe-connect.test.ts:141-148` tests `publisherEarningSplit` only.

**Problem:** `creditsToUsdCents` is the function that determines actual Stripe transfer amounts and is where the P1 residual-loss and P2 overflow defects live. The existing test exercises the 95/5 split's rounding rule but never asserts the cents-conversion behavior at boundaries (exactly divisible, sub-cent residual, large inputs, zero).

**Impact:** The defects in P1/P2/P4 are not guarded by any test; a regression in the conversion (e.g. swapping `Math.floor` for `Math.round`) would ship undetected.

**Fix:** Add tests for `creditsToUsdCents` covering: 0 → 0, 9_999 → 99, 10_000 → 100, 10_050 → 100 (residual 50), 95_001 → 950 (residual 1), and a non-integer/negative rejection case.

---

### [SEV: P3] Bare `number` return types cannot enforce the integer-credit / integer-cent invariant

**Location:** `convex/accounting.ts:21` (`publisherEarningSplit` returns `PublisherEarningSplit` of `number`s) and `convex/accounting.ts:38` (`creditsToUsdCents: number`).

**Problem:** The integer model is enforced only by runtime `Number.isSafeInteger` checks at function entry. The return types are plain `number`, so callers can do `publisherEarningSplit(x).platformFeeCredits + 0.5` or `creditsToUsdCents(x) * 1.5` and silently break the integer-cent invariant that the rest of the ledger depends on. The schema (`v.number()`) also doesn't enforce integer-ness on `wallets.balance`, `walletEntries.amount`, `publisherEarnings.grossCredits`, etc.

**Impact:** Type system gives no help catching accidental float contamination of the ledger. A future caller passing a float `amount` to `appendWalletEntry` would store a non-integer balance with no guard.

**Fix:** Introduce a branded `Credits`/`UsdCents` type (or at minimum a `bigint`-backed type) and thread it through the ledger write path. Out of scope for a one-file fix, but worth flagging.

---

### [SEV: P3] Hardcoded USD with no guard against the `currency` field on `publisherTransfers`

**Location:** `convex/accounting.ts:38` (name and constant), consumed at `convex/payouts.ts:374` (`currency: "usd"`).

**Problem:** The function is named `creditsToUsdCents` and `CREDITS_PER_USD = 10_000` encodes a USD assumption. The `publisherTransfers` schema (`convex/schema.ts:304`) has a `currency: v.string()` field and `preparePublisherTransfer` hardcodes `currency: "usd"`. If multi-currency is ever introduced (or a non-USD Stripe account is connected), this silent assumption produces wrong amounts with no error.

**Impact:** Latent; not a bug today, but an undocumented invariant that the type system cannot enforce.

**Fix:** Either assert `currency === "usd"` at the boundary or rename/document the assumption explicitly (`// Pre-condition: publisherTransfers.currency is always "usd"`).

---

### [SEV: P3] `BASIS_POINTS_DENOMINATOR` duplicates `CREDITS_PER_USD` — two names for `10_000`

**Location:** `convex/accounting.ts:2` (`CREDITS_PER_USD = 10_000`) and `convex/accounting.ts:6` (`BASIS_POINTS_DENOMINATOR = 10_000`).

**Problem:** Both constants equal `10_000`. They represent different concepts (credits-per-dollar vs. basis-points denominator), so the duplication is "coincidental," but if either is edited independently (e.g. credits re-denominated to `1_000` per dollar, or platform fee moved to a per-mille basis) the split math breaks silently because the two constants are no longer the expected pair.

**Impact:** Footgun for future maintainers; no compile-time link between the two concepts.

**Fix:** Derive one from the other or add a static assertion:
```ts
static_assert(BASIS_POINTS_DENOMINATOR === CREDITS_PER_USD); // conceptually linked today
```
or inline `10_000` in one place and comment the relationship.

---

### [SEV: P3] No assertion that `PLATFORM_FEE_BASIS_POINTS < BASIS_POINTS_DENOMINATOR`

**Location:** `convex/accounting.ts:5-6`.

**Problem:** If someone edits `PLATFORM_FEE_BASIS_POINTS` to a value ≥ `BASIS_POINTS_DENOMINATOR` (or to a negative number), `publisherEarningSplit` will produce `platformFeeCredits ≥ grossCredits`, giving the publisher a zero or negative `netCredits` — violating the "publishers keep 95%" contract. There is no runtime guard or compile-time assertion.

**Impact:** Latent config-edit footgun.

**Fix:**
```ts
if (PLATFORM_FEE_BASIS_POINTS <= 0 || PLATFORM_FEE_BASIS_POINTS >= BASIS_POINTS_DENOMINATOR) {
  throw new Error("Platform fee basis points must be in (0, 10000)");
}
```
as a module-load invariant, or a branded nominal type.

---

### [SEV: P3] Exports leak unnecessary internal API surface

**Location:** `convex/accounting.ts:2,5,6,11`.

**Problem:** `CREDITS_PER_USD`, `PLATFORM_FEE_BASIS_POINTS`, `BASIS_POINTS_DENOMINATOR`, and the `PublisherEarningSplit` type are all `export`ed but have no external consumers (grep confirms only `publisherEarningSplit`, `creditsToUsdCents`, and `PUBLISHER_RISK_HOLD_MS` are imported outside the module). The unused exports widen the public API and invite callers to depend on implementation constants they shouldn't reach into.

**Impact:** Minor; coupling surface.

**Fix:** Drop `export` from the three constants and the type unless an external need materializes; keep only the functions and `PUBLISHER_RISK_HOLD_MS` exported.

---

### [SEV: P3] Error messages from `creditsToUsdCents` can leak to publishers through `initiatePublisherTransfer`

**Location:** `convex/accounting.ts:40` (`throw new Error("Credits must be a non-negative safe integer")`), surfaced via `convex/payouts.ts:369` → `initiatePublisherTransfer` (a public `action`).

**Problem:** If the aggregate credits overflow (see P3 overflow finding) or a future caller passes a bad value, the raw internal-invariant message reaches the publisher UI as the action's rejection reason. The product rule says "Never leak internal errors to users." The message doesn't expose secrets, but it leaks an implementation invariant (safe-integer math) that a publisher has no context for.

**Impact:** Minor UX/error-disclosure issue.

**Fix:** Map to a neutral message at the `preparePublisherTransfer` boundary (e.g. "Earnings total is too large to process; contact support") rather than letting the raw `Error` propagate.

---

## Summary

**Findings by severity:** P0: 0 · P1: 1 · P2: 3 · P3: 8

**Top 3 to fix first:**
1. **P1 — Sub-cent residual destroyed on transfer.** `creditsToUsdCents` floors and `preparePublisherTransfer` marks the full `netCredits` as `transferred` with no residual accounting. Ledger never reconciles with Stripe amounts. Fix at the conversion boundary plus a residual field/grant.
2. **P2 — Overflow + float-precision in `publisherEarningSplit` and `creditsToUsdCents`.** Input validation is insufficient; the multiplications `grossCredits * 500` and `credits * 100` exceed safe-integer range and lose precision before the floor. Switch to division-first (`Math.floor(grossCredits / 20)`, `Math.floor(credits / 100)`) which is exact for all safe-integer inputs.
3. **P2 — `creditsToUsdCents` called against an unbounded `reduce` sum** in `preparePublisherTransfer`; the sum itself can overflow before conversion, producing either a wrong Stripe amount or a leaked internal error. Bound/validate the aggregate in the caller.
