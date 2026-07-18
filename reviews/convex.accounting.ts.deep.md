# Tiger-Style Deep Review — `convex/accounting.ts`

## Verdict
NEEDS WORK — verified and expanded. The file is 43 lines and pure, but it sits at the root of every revenue-split and payout computation in Zevium. The prior review's 1 P1 + 3 P2 are all **confirmed** by direct trace through `convex/wallets.ts` and `convex/payouts.ts`. This deep-dise additionally surfaces a **second P1** the prior review missed: `publisherEarningSplit` is invoked **per single usage event** in `recordUsage`, so for the platform's own default 1-credit call cost (`extractPricing` in `packages/shared/src/openapi.ts:178` defaults `cost = 1`), the platform fee floors to **zero on every micro-call** — the platform takes 0% revenue from the most common call price. The "exactly five percent" docstring is a lie at the realized granularity. Also adds P2/P3 findings on schema-level float contamination, missing invariant assertions, magic constants, and zero direct unit-test coverage.

## File Stats
- **Path:** `convex/accounting.ts`
- **LOC:** 43 (smallest load-bearing file in the repo)
- **Role:** Pure helpers for the credit-ledger / accounting subsystem:
  - `CREDITS_PER_USD = 10_000` — integer-credit model ($1 = 10,000 credits).
  - `PLATFORM_FEE_BASIS_POINTS = 500`, `BASIS_POINTS_DENOMINATOR = 10_000` — canonical 95/5 publisher/platform split.
  - `PUBLISHER_RISK_HOLD_MS = 7 * 24 * 60 * 60 * 1000` — payout fraud/refund risk window.
  - `publisherEarningSplit(grossCredits)` — the single source of truth for "publishers keep 95%".
  - `creditsToUsdCents(credits)` — credit → Stripe-cent conversion.
- **Callers (verified by grep):**
  - `convex/wallets.ts:13` imports `PUBLISHER_RISK_HOLD_MS`, `publisherEarningSplit`. Used inside `recordUsage` at `wallets.ts:435` — **per single usage event**, not per aggregated batch.
  - `convex/payouts.ts:12` imports `creditsToUsdCents`. Used in `preparePublisherTransfer` at `payouts.ts:369` against the `reduce` sum of all `available` earnings.
  - `convex/stripe-connect.test.ts:7` imports `publisherEarningSplit`. **Only one test case** at lines 141–148. `creditsToUsdCents` has **zero tests**.
- **Schema coupling:** `usageEvents.credits`, `walletEntries.amount`, `wallets.balance`, `publisherEarnings.{grossCredits,platformFeeCredits,netCredits}`, `publisherTransfers.amount`, `payments.{grantedCredits,reversedCredits}` are all declared `v.number()` in `convex/schema.ts` — none are `v.int64()`. The integer-credit invariant is enforced only at runtime by these two functions, and only at their entry points. Persisted values can be floats if any code path bypasses the helpers.

---

## Findings

### [SEV: P1] Sub-cent residual credits are silently destroyed on every publisher transfer — VERIFIED

**Location:** `convex/accounting.ts:38-43` (`creditsToUsdCents`), consumed at `convex/payouts.ts:366-388` and `convex/payouts.ts:426-455` (`markPublisherTransferSucceeded`).

```ts
export function creditsToUsdCents(credits: number): number {
  if (!Number.isSafeInteger(credits) || credits < 0) {
    throw new Error("Credits must be a non-negative safe integer");
  }
  return Math.floor((credits * 100) / CREDITS_PER_USD);  // = floor(credits/100)
}
```

```ts
// convex/payouts.ts:366-388
const credits = earnings.reduce((total, earning) => total + earning.netCredits, 0);
const amount = creditsToUsdCents(credits);
if (amount <= 0) throw new Error("Available earnings are below one cent");
// ...
for (const earning of earnings) {
  await ctx.db.patch(earning._id, {
    status: "allocated_to_transfer",
    transferId,
    updatedAt: now,
  });
}

// convex/payouts.ts:426-456  markPublisherTransferSucceeded
for (const earning of earnings) {
  await ctx.db.patch(earning._id, { status: "transferred", updatedAt: now });
}
```

**Problem (verified):** `creditsToUsdCents` floors to whole cents; `1 cent = 100 credits` so any `credits % 100 ≠ 0` discards up to 99 credits ($0.0099) per transfer. The caller marks **every** earning row's full `netCredits` as `transferred` while only `amount * 100` credits worth ($X.XX) is sent to Stripe. There is no `residualCredits` field on `publisherTransfers`, no platform-side ledger entry recording the untransferred residual, no carry-forward into the next transfer, no audit trail. The credits simply vanish from the accounting system.

Concrete: a publisher with one `available` row of `netCredits = 95_001` (the exact fixture used by `stripe-connect.test.ts:142`) yields `amount = floor(95001/100) = 950` cents = $9.50. The earning is marked `transferred` for 95,001 credits; only 95,000 credits ($9.50) reach Stripe. **1 credit is unaccounted for, on a single transfer of a single fixture-scale earning.**

**Reconciliation invariant violated:** `Σ(transferred.netCredits) × 100 / 10_000 ≠ Σ(transfers.amount)` for any publisher whose total transferred credits is not divisible by 100 — i.e., essentially every publisher who has ever withdrawn. The ledger cannot tie out to Stripe.

**Impact:** Accounting-integrity defect. The platform implicitly retains sub-cent residuals with no corresponding revenue entry; an audit or finance reconciliation will flag this immediately. Compounds with the per-event flooring P1 below — the platform already under-collects on the way in, then loses residual on the way out.

**Fix (minimal, at the boundary):**
```ts
// convex/accounting.ts — keep the floor (never overpay Stripe), but expose the residual
export function creditsToUsdCents(credits: number): number { /* unchanged */ }
export function paidCreditsForCents(cents: number): number {
  return cents * (CREDITS_PER_USD / 100); // inverse, exact
}
// convex/payouts.ts preparePublisherTransfer, after computing amount:
const residualCredits = credits - amount * (CREDITS_PER_USD / 100); // 0..99
// persist residualCredits on publisherTransfers; on success, grant to platform
// ledger (platform_grant walletEntry) or carry forward to next transfer.
```

---

### [SEV: P1] NEW — `publisherEarningSplit` is applied per-event, so the platform takes **0%** on every default-priced (1-credit) call

**Location:** `convex/accounting.ts:21-35` (`publisherEarningSplit`), invoked at `convex/wallets.ts:435` inside the per-event loop of `recordUsage`; default call cost from `packages/shared/src/openapi.ts:178` (`extractPricing`).

```ts
// convex/accounting.ts:27-29
const platformFeeCredits = Math.floor(
  (grossCredits * PLATFORM_FEE_BASIS_POINTS) / BASIS_POINTS_DENOMINATOR,
);  // = Math.floor(grossCredits / 20)
```

```ts
// convex/wallets.ts:435  — inside `for (const event of args.events)`
const split = publisherEarningSplit(event.credits);  // PER SINGLE EVENT
// ...
await ctx.db.insert("publisherEarnings", {
  grossCredits: split.grossCredits,
  platformFeeCredits: split.platformFeeCredits,
  netCredits: split.publisherNetCredits,
  // ...
});
```

```ts
// packages/shared/src/openapi.ts:176-178
export function extractPricing(op: OpenApiOperation): EndpointPricing {
  const costRaw = asNumber(op["x-zevium-cost"]);
  const cost = costRaw !== undefined && costRaw > 0 ? Math.floor(costRaw) : 1;  // DEFAULT = 1 credit
  // ...
}
```

**Problem (verified):** `publisherEarningSplit` is mathematically correct for a single integer input, but `recordUsage` invokes it once per usage event, not once per aggregated batch. The platform fee is `Math.floor(grossCredits / 20)`. For any `event.credits < 20` — i.e., any call priced below 20 credits ($0.002) — the fee is **exactly zero**. The publisher receives 100% of the credits and the platform receives 0%.

The platform's **own default** call price (`extractPricing` when `x-zevium-cost` is omitted/invalid) is **1 credit**. So every publisher who does not explicitly set a `≥ 20-credit` price on every operation generates **zero platform revenue** while the docstring claims "exactly five percent."

**Asymptotic vs realized 5%:** The "5% floored" formula only realizes 5% in aggregate **if the split is applied to an aggregate**. Applied per-event and summed, `Σ floor(gᵢ/20) ≤ floor(Σ gᵢ / 20)`, with strict inequality whenever any gᵢ < 20. Concrete: 1000 calls of 1 credit each →
- per-event: `Σ floor(1/20) = 0` platform fee.
- aggregate: `floor(1000/20) = 50` credits platform fee.

The platform loses 50 credits per 1000 default-priced calls. At 1M calls/day of default-priced APIs, that is 50,000 credits/day of foregone platform revenue (~$5/day at the platform's own pricing; the proportion matters more than the absolute — 0% vs 5% of GMV).

**The prior review's P3 ("`publisherEarningSplit(0)` is accepted")** gestures at the same family but misses that the under-collection is **structural for every sub-20-credit call**, not just the degenerate zero case. The default 1-credit call price makes this the common case, not an edge case.

**Impact:** Direct platform-revenue leak on the platform's own default pricing. The "publishers keep 95%" contract is realized as "publishers keep 100% on micro-calls, ~95% asymptotically." Likely the single highest-impact defect in this file.

**Fix:** Apply the split at the batch boundary, not the event boundary. Either:
- (a) In `recordUsage`, accumulate `event.credits` per `(publisherOrg, projectId)` within the batch, call `publisherEarningSplit` once on the sum, and insert one `publisherEarnings` row per (publisher, project) per batch. Breaks the 1:1 mapping between `usageEvents` and `publisherEarnings` rows — requires the `by_settlement` index key to be the batch ref, not the event ref.
- (b) Floor against the aggregate at payout time: store grossCredits per-event, compute `platformFeeCredits = floor(Σ gross / 20) - Σ floor(grossᵢ/20)` residual and attribute it on the first earning of each transfer. More complex.
- (c) If 1-credit calls are intentionally free-tier / loss-leader, set a **hard floor** on the fee (`Math.max(1, floor(g/20))` for `g > 0`) and document that the platform takes a minimum 1 credit per call. This changes the economic contract; requires product sign-off.

The minimum-viable fix is to **stop applying the split per-event**: `recordUsage` should batch by publisher and call `publisherEarningSplit` on the aggregate. Tag this as an accounting-contract change, not just a caller refactor, because the `publisherEarnings` row shape becomes "per-batch" rather than "per-event."

---

### [SEV: P2] `publisherEarningSplit` overflows `Number.MAX_SAFE_INTEGER` in the multiplication — VERIFIED

**Location:** `convex/accounting.ts:24-29`.

```ts
if (!Number.isSafeInteger(grossCredits) || grossCredits < 0) {
  throw new Error("Gross credits must be a non-negative safe integer");
}
const platformFeeCredits = Math.floor(
  (grossCredits * PLATFORM_FEE_BASIS_POINTS) / BASIS_POINTS_DENOMINATOR,
);  // grossCredits * 500
```

**Problem (verified):** The guard validates `grossCredits ≤ 2^53 − 1` but the computation `grossCredits * 500` exceeds `Number.MAX_SAFE_INTEGER` once `grossCredits > Number.MAX_SAFE_INTEGER / 500 ≈ 1.801 × 10^13` (≈ $1.8B in a single earning row). Above that threshold the multiplication loses integer precision *before* `Math.floor`, so `platformFeeCredits` can be off by one or more credits and the "exactly five percent" guarantee silently breaks. The structural invariant `gross = fee + net` still holds (net is computed by subtraction), but the fee itself is wrong.

**Reachability:** `publisherEarningSplit` is exported and pure. The sole live caller (`recordUsage`) passes a per-event `event.credits` which is realistically small, but the function has no caller-side cap. A batched replay migration, an admin grant tool, a future aggregate-settlement path, or a direct call from a script can plausibly pass a large aggregate. The function's own validator gives false confidence that the input range is bounded.

**Impact:** Silent incorrect 5%/95% split at extreme scale; platform-fee math drifts from the documented guarantee. No error is thrown.

**Fix (overflow-safe, mathematically equivalent for all safe integers):**
```ts
// floor(g * 500 / 10000) === floor(g / 20) for every safe integer g
const platformFeeCredits = Math.floor(
  grossCredits / (BASIS_POINTS_DENOMINATOR / PLATFORM_FEE_BASIS_POINTS),
);
// also assert the result is itself a safe integer
if (!Number.isSafeInteger(platformFeeCredits)) {
  throw new Error("Platform fee overflow");
}
```

---

### [SEV: P2] `creditsToUsdCents` overflows on realistic aggregate earnings — VERIFIED

**Location:** `convex/accounting.ts:38-43`, consumed at `convex/payouts.ts:366-369`.

```ts
return Math.floor((credits * 100) / CREDITS_PER_USD);  // credits * 100
```

**Problem (verified):** `credits * 100` exceeds `Number.MAX_SAFE_INTEGER` once `credits > 9.007 × 10^13` (≈ $9B). Unlike `publisherEarningSplit`, this is called against an **aggregate**: `preparePublisherTransfer` sums **all** `available` earnings for a publisher (`earnings.reduce((t, e) => t + e.netCredits, 0)` at `payouts.ts:366`). Two compounding defects:

1. The `reduce` itself can overflow safe-integer range with no guard — the sum silently loses precision *before* `creditsToUsdCents` is called.
2. `creditsToUsdCents` validates the already-corrupted sum with `Number.isSafeInteger(credits)`. If the corrupted sum happens to still be a safe integer (likely, since float rounding tends to land on representable values), no error is thrown and a wrong cent amount is sent to Stripe.

**Impact:** Wrong Stripe transfer amount for whale publishers at extreme scale, or an opaque `"Credits must be a non-negative safe integer"` error thrown at the publisher boundary (see leaked-error P3).

**Fix:**
```ts
export function creditsToUsdCents(credits: number): number {
  if (!Number.isSafeInteger(credits) || credits < 0) {
    throw new Error("Credits must be a non-negative safe integer");
  }
  // credits / 100 is exact for all safe integers; credits * 100 is not.
  return Math.floor(credits / (CREDITS_PER_USD / 100));
}
```
And in `preparePublisherTransfer`, switch the reduce to a `BigInt` accumulator or assert each `netCredits` and the running sum stay safe-integer throughout.

---

### [SEV: P2] Unbounded `reduce` sum in `preparePublisherTransfer` — VERIFIED (cross-file, accounting-boundary)

**Location:** `convex/payouts.ts:366-369` (caller of `creditsToUsdCents`); root cause is the accounting contract that `creditsToUsdCents` accepts any safe integer.

```ts
const credits = earnings.reduce((total, earning) => total + earning.netCredits, 0);
const amount = creditsToUsdCents(credits);
```

**Problem (verified):** No bound on `earnings.length` (the `by_publisher` + `status: "available"` filter is `.collect()` — unbounded). A publisher with millions of available earning rows (every micro-call creates one per the per-event P1) accumulates a sum that can overflow safe-integer range silently. The accounting helper cannot detect this because by the time `creditsToUsdCents` sees the value, it has already been corrupted by the reduce. This is the **caller-side manifestation** of the P2 above; the fix belongs in both `accounting.ts` (overflow-safe conversion) and `payouts.ts` (safe accumulation + bound).

**Impact:** At extreme scale, wrong Stripe payout or opaque error. Compounds with the per-event P1: more events = more rows = faster overflow.

**Fix:** Accumulate in `BigInt`, validate the aggregate before conversion, and/or page the sum.

---

### [SEV: P2] Prior P3 upgraded — `publisherEarningSplit(0)` is accepted, inserting zero-value `publisherEarnings` rows that pollute every payout/earnings query

**Location:** `convex/accounting.ts:24-29` (accepts 0); `convex/wallets.ts:366` (only rejects `event.credits < 0`); `convex/wallets.ts:435-456` (inserts the row).

**Problem (verified):** The contract permits `grossCredits === 0`. `recordUsage` only rejects `event.credits < 0`, so a usage event with `credits === 0` flows through `publisherEarningSplit(0)` → `{0, 0, 0}` and inserts a `publisherEarnings` row with all-zero amounts and `status: "pending_risk"`. These rows then transition through the full lifecycle (`pending_risk → available → allocated_to_transfer → transferred`) for zero value, polluting:
- the `by_publisher` and `by_status_available` indexes (every payout scan reads them),
- `earnings.forOrg`'s `byProject` map (zero-value entries appear in the publisher statement),
- `getPayoutState`'s 100-row `.take(100)` window (zero-value rows displace real ones — see `payouts.ts:640` cap).

The free-tier path (`apps/gateway/src/wallet.ts:657 enqueueFreeUsage`) explicitly enqueues `credits: 0` usage rows, so **zero-credit events are a first-class supported flow**, not an edge case. The accounting layer's tolerance of 0 propagates them into the publisher earnings ledger instead of short-circuiting.

**Upgraded from P3 to P2** because the free-tier path makes zero-credit events common, not rare, and the pollution is cumulative and unbounded.

**Impact:** Ledger/index pollution; inflated row counts; displaced `take(100)` windows in `getPayoutState`; reconciliation noise. Not a correctness defect in `accounting.ts` itself (0 is valid by the stated contract), but the function is the natural place to enforce a positive minimum if zero settlements are nonsensical — or `recordUsage` should skip the publisherEarning insert when `event.credits === 0`.

**Fix:** In `accounting.ts`, tighten the contract:
```ts
if (!Number.isSafeInteger(grossCredits) || grossCredits <= 0) {
  throw new Error("Gross credits must be a positive safe integer");
}
```
And in `recordUsage`, skip the `publisherEarning` insert (and arguably the `walletEntry` insert — it currently increments `sequence` without mutating `balance`) when `event.credits === 0`.

---

### [SEV: P2] NEW — Schema uses `v.number()` for all credit/cent fields; the integer invariant is enforced only at function entry, not at the persistence boundary

**Location:** `convex/schema.ts:48-78` (`wallets`, `walletEntries`), `convex/schema.ts:204-225` (`publisherEarnings`), `convex/schema.ts:300-318` (`publisherTransfers`); `convex/accounting.ts:21,38` (entry-only validation).

**Problem (verified):** Every credit/cent field is declared `v.number()`:
- `wallets.balance: v.number()`, `wallets.sequence: v.number()`
- `walletEntries.amount: v.number()`
- `publisherEarnings.{grossCredits,platformFeeCredits,netCredits}: v.number()`
- `publisherTransfers.amount: v.number()`
- `payments.{grantedCredits,reversedCredits}: v.number()`
- `usageEvents.credits: v.number()`

`v.number()` accepts floats. `accounting.ts` validates `Number.isSafeInteger` only at function entry, on inputs. The return values, the persisted values, and any future code path that writes to these tables without going through `publisherEarningSplit` / `creditsToUsdCents` can store non-integer balances with no guard. `appendWalletEntry` (wallets.ts:107-108) computes `balance = args.wallet.balance + args.amount` and patches it without re-checking safe-integerness. A single float `amount` stored in `walletEntries.amount` propagates into `wallets.balance` forever, and every downstream split/payout on that wallet inherits the corruption.

This is partly captured in the prior "bare `number` return types" P3, but the **schema-level gap** is separate: even a branded-type fix in `accounting.ts` does nothing if the schema persists `v.number()`.

**Impact:** The integer-credit invariant — the foundation of the entire ledger — is unenforced at the persistence layer. Float contamination is silent and unrecoverable.

**Fix:** Switch credit/cent fields to `v.int64()` (Convex's integer validator) at the schema level, and introduce a branded `Credits` / `UsdCents` nominal type threaded through the write path. Schema migration required.

---

### [SEV: P3] Asymmetric rounding direction drifts publisher take away from the documented 95%

**Location:** `convex/accounting.ts:27` (fee floored) and `convex/accounting.ts:42` (cents floored).

**Problem (verified):** `publisherEarningSplit` floors the platform fee, favoring the publisher on the way *in*. `creditsToUsdCents` floors the cent amount, disfavoring the publisher on the way *out* (and the residual is destroyed — see P1). The two directions compound: a publisher's realized take is `floor(netCredits / 100) * 100` cents while `netCredits = grossCredits − floor(grossCredits / 20)`. The effective percentage is not exactly 95% in either direction, and the asymmetry is undocumented. Compounds with the per-event P1.

**Impact:** Minor, but the product contract says "publishers keep 95%"; the math realizes 0–95% depending on call granularity and residual. Worth a one-line doc note clarifying the intended rounding policy on both boundaries.

**Fix:** Document both rounding decisions in one place, or pick a single consistent direction (e.g. always floor against the platform on both split and payout) and reconcile residuals per the P1 fix.

---

### [SEV: P3] `creditsToUsdCents` has zero test coverage; `publisherEarningSplit` has only one assertion — VERIFIED, expanded

**Location:** `convex/stripe-connect.test.ts:141-148`; no `convex/accounting.test.ts` file exists (confirmed by glob).

```ts
it("uses the single integer 95/5 rounding rule", () => {
  expect(publisherEarningSplit(100_001)).toEqual({
    grossCredits: 100_001,
    platformFeeCredits: 5_000,
    publisherNetCredits: 95_001,
  });
  expect(() => publisherEarningSplit(-1)).toThrow("non-negative");
});
```

**Problem (verified):** One assertion for `publisherEarningSplit` (only `100_001`), zero for `creditsToUsdCents`. No dedicated test file. No boundary tests for `0`, `1`, `19`, `20`, `21`, `MAX_SAFE_INTEGER`, `MAX_SAFE_INTEGER / 20`, non-integer inputs, negative inputs. The P1 (per-event flooring under-collection on 1-credit calls) is not asserted; the P2 overflow thresholds are not asserted; the P1 residual-loss on `creditsToUsdCents` is not asserted.

**Impact:** Every defect in P1/P2 above is unguarded. A regression (e.g. swapping `Math.floor` → `Math.round`, or changing the split granularity) ships undetected.

**Fix:** Create `convex/accounting.test.ts` with: split at `0`, `1`, `19`, `20`, `21`, `100_001`, `MAX_SAFE_INTEGER`; rejection of `-1`, `0.5`, `NaN`, non-safe-integers; `creditsToUsdCents` at `0`, `99`, `100`, `9_999`, `10_000`, `10_050`, `95_001`, `MAX_SAFE_INTEGER`; and the reconciliation invariant `Σ floor(gᵢ/20) ≤ floor(Σ gᵢ/20)`.

---

### [SEV: P3] NEW — No defensive assertion that `gross = fee + net` invariant holds before returning

**Location:** `convex/accounting.ts:30-34`.

```ts
return {
  grossCredits,
  platformFeeCredits,
  publisherNetCredits: grossCredits - platformFeeCredits,  // structurally safe today
};
```

**Problem:** Today the invariant `gross = fee + net` holds by construction (net is `gross − fee`). But if a future refactor computes `net` independently (e.g. `Math.floor(gross * 0.95)` for "symmetry"), the invariant can silently break and downstream reconciliation (which assumes `gross = fee + net`) will diverge. The `publisherEarnings` schema stores all three fields independently — nothing prevents an inconsistent triple from being persisted.

**Impact:** Latent footgun; no defense-in-depth at the single chokepoint that defines the split.

**Fix:**
```ts
const result = { grossCredits, platformFeeCredits, publisherNetCredits: grossCredits - platformFeeCredits };
if (result.platformFeeCredits + result.publisherNetCredits !== result.grossCredits) {
  throw new Error("Split invariant violated: fee + net != gross");
}
return result;
```

---

### [SEV: P3] NEW — No upper bound on `grossCredits`; a $900B single settlement is accepted

**Location:** `convex/accounting.ts:24-26`.

**Problem:** The validator accepts any `Number.isSafeInteger` up to `2^53 − 1 ≈ 9.007 × 10^15` credits ≈ $900B for a single earning row. The product has no business reason to accept such a value, and accepting it pushes the multiplication into the overflow zone (P2). A sane upper bound (e.g. 10^12 credits = $100M per single settlement, still absurdly generous) would also bound the overflow risk.

**Impact:** Latent. The validator gives false confidence that the input range is bounded for the multiplication that follows.

**Fix:** Add a product-sensible upper bound:
```ts
const MAX_SINGLE_SETTLEMENT_CREDITS = 10_000_000_000_000; // $100M
if (grossCredits > MAX_SINGLE_SETTLEMENT_CREDITS) {
  throw new Error("Settlement exceeds per-row maximum");
}
```

---

### [SEV: P3] NEW — No assertion that `CREDITS_PER_USD % 100 === 0`; latent residual-loss footgun

**Location:** `convex/accounting.ts:2` (`CREDITS_PER_USD = 10_000`).

**Problem:** `creditsToUsdCents` assumes `1 cent = CREDITS_PER_USD / 100 = 100` credits is an exact integer. If `CREDITS_PER_USD` is ever edited to a non-multiple-of-100 value (e.g. `1_000` for a finer model — still gives 10 credits per cent, OK; or `7_500` — gives 75 credits per cent, OK; or `3_333` — gives 33.33 credits per cent, NOT OK), `Math.floor(credits / (CREDITS_PER_USD / 100))` silently produces a non-integer divisor and the residual computation in the P1 fix breaks. There is no module-load assertion guarding this invariant.

**Impact:** Latent config-edit footgun; the P1 residual fix depends on this invariant.

**Fix:**
```ts
if (CREDITS_PER_USD % 100 !== 0) {
  throw new Error("CREDITS_PER_USD must be a multiple of 100");
}
```
as a module-load assertion.

---

### [SEV: P3] NEW — No assertion that `0 < PLATFORM_FEE_BASIS_POINTS < BASIS_POINTS_DENOMINATOR`

**Location:** `convex/accounting.ts:5-6`.

**Problem (verified, expanded from prior P3):** If `PLATFORM_FEE_BASIS_POINTS` is edited to ≥ `BASIS_POINTS_DENOMINATOR` or to a negative number, `publisherEarningSplit` produces `platformFeeCredits ≥ grossCredits` (publisher gets zero or negative `netCredits`) — violating the "publishers keep 95%" contract. There is no runtime guard or compile-time assertion. The prior P3 noted this; expanded here to note that the validator on `grossCredits` does not catch a malformed constant.

**Fix:**
```ts
if (PLATFORM_FEE_BASIS_POINTS <= 0 || PLATFORM_FEE_BASIS_POINTS >= BASIS_POINTS_DENOMINATOR) {
  throw new Error("Platform fee basis points must be in (0, 10000)");
}
```
as a module-load invariant.

---

### [SEV: P3] `BASIS_POINTS_DENOMINATOR` coincidentally equals `CREDITS_PER_USD` — VERIFIED

**Location:** `convex/accounting.ts:2,6`.

**Problem (verified):** Both constants equal `10_000`. They represent different concepts (credits-per-dollar vs. basis-points denominator), so the equality is coincidental. If either is edited independently (e.g. credits re-denominated to `1_000` per dollar, or platform fee moved to a per-mille basis with denominator `1_000`), the split math breaks silently because the two constants are no longer the expected pair.

**Impact:** Footgun for future maintainers; no compile-time link between the two concepts.

**Fix:** Add a module-load assertion: `if (BASIS_POINTS_DENOMINATOR !== 10_000) { throw }` and inline-comment the relationship, or derive one from the other.

---

### [SEV: P3] Hardcoded USD with no guard against the `currency` field on `publisherTransfers` — VERIFIED

**Location:** `convex/accounting.ts:2,38` (`CREDITS_PER_USD`, function name), consumed at `convex/payouts.ts:374` (`currency: "usd"`); schema `publisherTransfers.currency: v.string()` (`convex/schema.ts:307`).

**Problem (verified):** The function is named `creditsToUsdCents` and `CREDITS_PER_USD = 10_000` encodes a USD assumption. `publisherTransfers.currency` is a free `v.string()` and `preparePublisherTransfer` hardcodes `"usd"`. If multi-currency is ever introduced (or a non-USD Stripe account is connected), this silent assumption produces wrong amounts with no error.

**Impact:** Latent; not a bug today, but an undocumented invariant the type system cannot enforce.

**Fix:** Assert `currency === "usd"` at the boundary, or rename/document the assumption explicitly.

---

### [SEV: P3] Bare `number` return types cannot enforce the integer-credit / integer-cent invariant — VERIFIED

**Location:** `convex/accounting.ts:21,38`.

**Problem (verified):** The integer model is enforced only by runtime `Number.isSafeInteger` checks at function entry. The return types are plain `number`, so callers can do `publisherEarningSplit(x).platformFeeCredits + 0.5` or `creditsToUsdCents(x) * 1.5` and silently break the integer-cent invariant the rest of the ledger depends on. The schema gap (P2 above) is the persistence-side manifestation.

**Impact:** Type system gives no help catching accidental float contamination of the ledger.

**Fix:** Introduce a branded `Credits`/`UsdCents` type (or `bigint`-backed) and thread it through the ledger write path. Larger refactor; out of scope for a one-file fix but worth flagging.

---

### [SEV: P3] Exports leak unnecessary internal API surface — VERIFIED

**Location:** `convex/accounting.ts:2,5,6,11`.

**Problem (verified):** `CREDITS_PER_USD`, `PLATFORM_FEE_BASIS_POINTS`, `BASIS_POINTS_DENOMINATOR`, and the `PublisherEarningSplit` type are all `export`ed but have no external consumers (grep confirms only `publisherEarningSplit`, `creditsToUsdCents`, and `PUBLISHER_RISK_HOLD_MS` are imported outside the module). The unused exports widen the public API and invite callers to depend on implementation constants they shouldn't reach into.

**Impact:** Minor; coupling surface; future callers could read `CREDITS_PER_USD` and bake in the `10_000` assumption elsewhere.

**Fix:** Drop `export` from the three constants and the type unless an external need materializes; keep only the functions and `PUBLISHER_RISK_HOLD_MS` exported.

---

### [SEV: P3] Error messages from `creditsToUsdCents` can leak to publishers through `initiatePublisherTransfer` — VERIFIED

**Location:** `convex/accounting.ts:40` (`throw new Error("Credits must be a non-negative safe integer")`), surfaced via `convex/payouts.ts:369` → `initiatePublisherTransfer` (a public `action` at `payouts.ts:607`).

**Problem (verified):** If the aggregate credits overflow (P2) or a future caller passes a bad value, the raw internal-invariant message reaches the publisher UI as the action's rejection reason. The product rule says "Never leak internal errors to users." The message doesn't expose secrets, but it leaks an implementation invariant (safe-integer math) that a publisher has no context for.

**Impact:** Minor UX/error-disclosure issue; violates the "never leak internal errors" rule.

**Fix:** Map to a neutral message at the `preparePublisherTransfer` boundary (e.g. "Earnings total is too large to process; contact support") rather than letting the raw `Error` propagate.

---

### [SEV: P3] NEW — Generic `Error` throws, not a domain-typed error; callers cannot distinguish invalid-input from other failures

**Location:** `convex/accounting.ts:26,40`.

**Problem:** Both functions throw `new Error("...")`. Callers (`recordUsage`, `preparePublisherTransfer`) cannot programmatically distinguish "invalid input to accounting helper" from any other `Error` thrown during the surrounding transaction. The validation errors are also conflated with overflow errors (which don't currently throw, but should per the P2 fix). A `Result<T, E>` return or a branded `AccountingError` subclass would let callers translate to user-facing messages (per the leaked-error P3) without string-matching the message.

**Impact:** Minor; poor error taxonomy at a critical boundary.

**Fix:** Throw a branded `AccountingError` with a `code` field (`"INVALID_INPUT" | "OVERFLOW" | "INVARIANT_VIOLATION"`) so callers can map to user-facing messages without parsing strings.

---

### [SEV: P3] NEW — `PUBLISHER_RISK_HOLD_MS` is a magic constant with no test and no parameterization path

**Location:** `convex/accounting.ts:8` (`PUBLISHER_RISK_HOLD_MS = 7 * 24 * 60 * 60 * 1000`), consumed at `convex/wallets.ts:444` (`availableAt: now + PUBLISHER_RISK_HOLD_MS`).

**Problem:** The 7-day risk window is hardcoded. If risk policy needs to change (per-region, per-publisher risk tier, regulatory change), the constant can't be parameterized without a code deploy. The value `7 * 24 * 60 * 60 * 1000 = 604_800_000` is correct (verified) but has no test asserting it equals 7 days, so a typo like `7 * 24 * 60 * 60 * 100` would silently shorten the window 1000× and no test would catch it.

**Impact:** Latent operational inflexibility; no regression guard on the value.

**Fix:** Either lift to a config table / env var with a default, or add a unit test asserting `PUBLISHER_RISK_HOLD_MS === 7 * 24 * 60 * 60 * 1000`. At minimum, derive the constant from named sub-constants (`DAYS = 7`, `HOURS_PER_DAY = 24`, etc.) for readability.

---

### [SEV: P3] NEW — No inverse `usdCentsToCredits` helper; the P1 residual fix and any future admin correction have no canonical inverse

**Location:** `convex/accounting.ts:38-43`.

**Problem:** `creditsToUsdCents` is lossy by design (floors). The inverse `usdCentsToCredits(cents) = cents * (CREDITS_PER_USD / 100)` is exact (since `CREDITS_PER_USD % 100 === 0`), but it is not defined in this module. The P1 residual fix requires computing `paidCreditsForCents(amount)`, which is exactly this inverse. Any future admin correction based on a Stripe payout amount (in cents) also needs the inverse. Defining it inline at each caller site risks divergence.

**Impact:** Latent; the P1 fix cannot be implemented cleanly without it.

**Fix:**
```ts
export function usdCentsToCredits(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error("Cents must be a non-negative safe integer");
  }
  return cents * (CREDITS_PER_USD / 100);
}
```
and use it in `preparePublisherTransfer` to compute `paidCredits` and `residualCredits`.

---

### [SEV: P3] Prior "float precision below overflow threshold" P2 is overstated — the math is exact below the overflow threshold

**Location:** `convex/accounting.ts:27-29,42`.

**Problem (clarification of prior review):** The prior review listed a separate P2 claiming "for large-but-still-safe `grossCredits`, the intermediate product `grossCredits * 500` may not be exactly representable in float64 (e.g. values above 2^53 lose integer precision)." This conflates two regimes:

- For `grossCredits ≤ 2^53 / 500 ≈ 1.801 × 10^13`, the product `grossCredits * 500` is **exactly** representable (it fits in 53 bits). The division by `10_000 = 2^4 × 5^4` introduces rounding bounded by float64 ULP, far smaller than the 0.05 granularity of `floor(g/20)`, so `Math.floor((g*500)/10000) === Math.floor(g/20)` exactly. No off-by-one.
- For `grossCredits > 1.801 × 10^13`, the product overflows safe-integer range — this is the **same** as the overflow P2, not a separate concern.

The same holds for `creditsToUsdCents`: `(credits * 100) / 10_000` is exact for `credits ≤ 9.007 × 10^13` and overflow above. The prior P2 "float precision" finding is the same issue as the overflow P2 at the same threshold; the suggested division-first fix (`Math.floor(g/20)`, `Math.floor(credits/100)`) does not change behavior below the overflow threshold (it was already exact) — it only extends the exact range up to `MAX_SAFE_INTEGER` itself.

**Impact:** The prior review counted one underlying defect as two P2s. The overflow fix (division-first form) subsumes both.

**Fix:** Consolidate the two P2s into one; keep the division-first rewrite as the fix.

---

## Summary

**Findings by severity:** P0: 0 · P1: 2 · P2: 4 · P3: 14

**Prior review verification:**
- ✅ P1 sub-cent residual loss — VERIFIED, trace confirmed end-to-end through `payouts.ts:366-455`.
- ✅ P2 integer overflow in `publisherEarningSplit` — VERIFIED at threshold `grossCredits > 1.801 × 10^13`.
- ✅ P2 `creditsToUsdCents` overflow — VERIFIED at threshold `credits > 9.007 × 10^13`.
- ✅ P2 unbounded `reduce` sum in caller — VERIFIED at `payouts.ts:366`.
- ⚠️ Prior P2 "float precision below overflow threshold" — overstated; same threshold as overflow, math is exact below it. Consolidated.
- ✅ All 8 prior P3s — VERIFIED, expanded where applicable.

**New findings (deep-dive):**
- 🆕 **P1** — `publisherEarningSplit` applied per-event in `recordUsage`; platform takes 0% on the platform's own default 1-credit call cost. The "exactly five percent" docstring is a lie at the realized granularity.
- 🆕 **P2** — Schema uses `v.number()` for all credit/cent fields; integer invariant enforced only at function entry, not at the persistence boundary. Float contamination silent and unrecoverable.
- 🆕 **P2** (upgraded from prior P3) — `publisherEarningSplit(0)` accepted; free-tier `credits: 0` events insert zero-value `publisherEarnings` rows that pollute every payout/earnings query.
- 🆕 **P3** — No dedicated `accounting.test.ts`; only one split assertion, zero `creditsToUsdCents` assertions.
- 🆕 **P3** — No defensive assertion that `gross = fee + net` invariant holds before returning.
- 🆕 **P3** — No upper bound on `grossCredits`; $900B single settlement accepted.
- 🆕 **P3** — No assertion `CREDITS_PER_USD % 100 === 0`; latent residual-loss footgun for the P1 fix.
- 🆕 **P3** — Generic `Error` throws, not domain-typed; callers cannot distinguish failure modes.
- 🆕 **P3** — `PUBLISHER_RISK_HOLD_MS` is a magic constant with no test, no parameterization path.
- 🆕 **P3** — No inverse `usdCentsToCredits` helper; P1 residual fix and any future admin correction have no canonical inverse.

**Top 3 to fix first:**
1. **P1 — Per-event flooring under-collects platform fee.** `recordUsage` calls `publisherEarningSplit` per single usage event; for the platform's default 1-credit call cost, the platform takes 0% on every micro-call. Stop applying the split per-event; batch by publisher and split on the aggregate. Highest-impact defect in this file.
2. **P1 — Sub-cent residual destroyed on transfer.** `creditsToUsdCents` floors and `preparePublisherTransfer` marks the full `netCredits` as `transferred` with no residual accounting. Ledger never reconciles with Stripe amounts. Fix at the conversion boundary plus a residual field/grant; requires the new `usdCentsToCredits` inverse helper.
3. **P2 — Integer overflow in `publisherEarningSplit` and `creditsToUsdCents` + unbounded `reduce`.** Input validation is insufficient; the multiplications `grossCredits * 500` and `credits * 100` exceed safe-integer range and lose precision before the floor. Switch to division-first (`Math.floor(grossCredits / 20)`, `Math.floor(credits / 100)`) which is exact for all safe-integer inputs, and bound the aggregate in the caller.
