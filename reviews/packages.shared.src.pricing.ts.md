# Tiger Review — `packages/shared/src/pricing.ts`

## Verdict

**INCORRECT.** The `EndpointPricing` type is the contract that flows across the
gateway→wallet billing boundary, and its sole producer (`extractPricing` in
`openapi.ts`) silently rewrites values the publish-time validator explicitly
accepts. The headline defect: `x-zevium-cost: 0` passes validation (validator
rule is `>= 0`) but `extractPricing` treats `0` identically to "missing" and
defaults to `1`, silently charging consumers 1 credit per call for an endpoint
the publisher published as free. The same validator/extractor disagreement also
silently floors non-integer costs (`3.9 → 3`, a 23% undercharge) and
`x-zevium-free-tier` is never validated at all — invalid values are silently
floored or dropped at the gateway with zero publish-time feedback. The type
itself (`cost: number`, `freeTier?: number`) encodes none of the integer-credit
invariants the rest of the system (`convex/accounting.ts`:
`Number.isSafeInteger` guards everywhere) relies on.

---

## File Stats

- **File:** `packages/shared/src/pricing.ts`
- **LOC:** 6 (the `EndpointPricing` interface only — the extraction logic that
  produces `EndpointPricing` values lives in `packages/shared/src/openapi.ts`
  `extractPricing`, lines 176–184, which the assignment directed as required
  context and which is the sole producer of this type's values on the gateway
  hot path).
- **Role:** The pricing contract for every metered gateway call. `MatchedOperation.pricing`
  (`openapi.ts:58`) carries this type into `apps/gateway/src/pipeline.ts:115–116`,
  where `cost` is passed straight into `wallet.reserve(reservationId, cost, …)`
  and `freeTier` into `wallet.consumeFreeTier(keyId, freeTier, …)`. The wallet
  Durable Object debits real credits against these numbers.
- **Callers (grep):**
  - `apps/gateway/src/pipeline.ts:115–116` — `cost`/`freeTier` → wallet
    reserve/consumeFreeTier (the actual charge).
  - `apps/gateway/src/discovery.ts:64` — `pricing.cost` → `DiscoveryEndpoint.credits`.
  - `apps/web/src/lib/spec-pricing.ts:34` — draft pricing summary (pre-publish).
  - `apps/web/src/lib/spec-endpoints.ts:35` — endpoint list UI.
  - `apps/web/src/routes/catalogue/$orgSlug.$projectSlug.tsx:119` — catalogue detail.
  - `convex/catalogue.ts:51` — `minCost`/`maxCost` index fields.
  - `packages/shared/src/openapi.ts:168` — produced inside `matchOperation`.
- **Cross-boundary dispatch point checked:** `packages/shared/src/validate.ts:139–149`
  (`collectOpenApiSpecIssues`, the publish gate that decides which `x-zevium-cost`
  values reach the gateway). The validator and `extractPricing` **disagree** on
  what is a valid cost — see Finding 1 and Finding 3.

---

## Findings

### [SEV: P1] `extractPricing` silently rewrites `x-zevium-cost: 0` to `1` — free endpoints are overcharged against the published spec

**Location:** `packages/shared/src/openapi.ts:176–178` (extraction) crossed with
the publish validator `packages/shared/src/validate.ts:141–149`, and the type
contract `packages/shared/src/pricing.ts:2–3` (JSDoc "default 1").

```ts
// packages/shared/src/openapi.ts:176-178
export function extractPricing(op: OpenApiOperation): EndpointPricing {
  const costRaw = asNumber(op["x-zevium-cost"]);
  const cost = costRaw !== undefined && costRaw > 0 ? Math.floor(costRaw) : 1;
```

```ts
// packages/shared/src/pricing.ts:1-6
export interface EndpointPricing {
  /** Credits per call — `x-zevium-cost`, default 1 */
  cost: number;
  /** Free calls per day — `x-zevium-free-tier`, publisher-funded */
  freeTier?: number;
}
```

```ts
// packages/shared/src/validate.ts:141-149  (the publish gate)
} else if (
  typeof cost !== "number" ||
  !Number.isFinite(cost) ||
  cost < 0
) {
  issues.push({
    level: "error",
    path: `$.paths["${pathKey}"].${lower}.x-zevium-cost`,
    message: "x-zevium-cost must be a number ≥ 0",
  });
}
```

**Problem:** The validator accepts any finite `cost >= 0` as valid — `0` passes
the publish gate with no error and no warning. The natural reading of
`x-zevium-cost: 0` (and the validator's explicit `≥ 0` bound) is "this endpoint
is free." But `extractPricing` uses `costRaw > 0` as the guard, so `0` falls
into the `else` branch and is rewritten to `1` — identical to the
missing/undefined case. The JSDoc on `EndpointPricing.cost` ("default 1")
encodes and reinforces this conflation of "zero" with "missing."

The test `openapi.test.ts:135–138` even pins the behavior as intended:
```ts
it("defaults invalid/zero cost to 1", () => {
  expect(extractPricing({ "x-zevium-cost": 0 }).cost).toBe(1);
```
— so two deliberately-authored layers contradict each other: the validator says
`0` is a legitimate published price; the extractor says `0` is invalid and
substitutes `1`.

**Trigger / impact:** A publisher publishes an operation with
`"x-zevium-cost": 0` (free endpoint, no daily free-tier quota, just free per
call). The spec passes `validateOpenApiSpec` with zero errors and zero warnings
(`saveDraft`/`publish` in `convex/specs.ts:80–112` only block on
`level === "error"`). At runtime, `matchOperation` → `extractPricing` returns
`{ cost: 1 }`, and `pipeline.ts:152` calls `wallet.reserve(reservationId, 1, …)`.
Every single call to that "free" endpoint charges the consumer 1 credit and
accrues 1 credit of publisher gross earnings (`publisherEarningSplit` in
`convex/wallets.ts:435`). The publisher's published intent is silently
violated on every call, with no signal at publish time that `0` will not be
honored. This is a billing-correctness defect: charged price ≠ published price,
in the overcharge direction, on every call to every endpoint a publisher marks
`x-zevium-cost: 0`.

The mock carve-out (`/mock/:org/:project/*`) is keyless/0-credit by design, so
this bug is specifically about *real* gateway routes through a published spec.

**Fix:** The two layers must agree. The minimal, semantically correct fix is to
honor `0` as a real (free) cost and let the existing wallet reserve path handle
a 0-credit charge as a no-op reserve + 0-credit settle (the pipeline already
emits `cost: 0` usage rows on the free path, so the usage sink is fine):

```ts
// packages/shared/src/openapi.ts
export function extractPricing(op: OpenApiOperation): EndpointPricing {
  const costRaw = asNumber(op["x-zevium-cost"]);
  const cost = costRaw === undefined ? 1
    : (Number.isFinite(costRaw) && costRaw >= 0) ? Math.floor(costRaw) : 1;

  const freeRaw = asNumber(op["x-zevium-free-tier"]);
  const freeTier =
    freeRaw !== undefined && freeRaw > 0 ? Math.floor(freeRaw) : undefined;

  return freeTier !== undefined ? { cost, freeTier } : { cost };
}
```

and confirm `wallet.reserve(id, 0, …)` is a no-op that returns
`{ status: "reserved" | "duplicate" }` without debiting. If 0-credit reserves
are undesirable, the alternative is to make the validator reject `cost < 1`
(see Finding 3) so `0` can never reach `extractPricing` — but then the
`"must be a number ≥ 0"` message and the missing-cost warning's "defaults to 1
at gateway" wording must both be updated, and the test pinning `0 → 1` removed.

Either way, the JSDoc on `EndpointPricing.cost` should distinguish "missing →
default 1" from "0 → free."

---

### [SEV: P2] `x-zevium-free-tier` is never validated; `extractPricing` silently floors or drops invalid values with zero publish-time feedback

**Location:** `packages/shared/src/openapi.ts:180–181` (extraction) +
`packages/shared/src/pricing.ts:4–5` (type field), crossed with
`packages/shared/src/validate.ts:118–154` (the validator never touches
`x-zevium-free-tier`).

```ts
// packages/shared/src/openapi.ts:180-181
  const freeRaw = asNumber(op["x-zevium-free-tier"]);
  const freeTier =
    freeRaw !== undefined && freeRaw > 0 ? Math.floor(freeRaw) : undefined;
```

```ts
// packages/shared/src/pricing.ts:4-5
  /** Free calls per day — `x-zevium-free-tier`, publisher-funded */
  freeTier?: number;
```

**Problem:** `x-zevium-free-tier` is a first-class pricing field — it gates the
publisher-funded free-tier path in `pipeline.ts:128–146`
(`wallet.consumeFreeTier(verified.keyId, freeTier, …)`), is surfaced in the
catalogue (`convex/catalogue.ts:54`, `hasFreeTier`), and in the web summary
(`apps/web/src/lib/spec-pricing.ts:38`). Yet `collectOpenApiSpecIssues`
(`validate.ts:118–154`) iterates every operation and checks **only**
`x-zevium-cost`; `x-zevium-free-tier` receives no validation whatsoever.
Meanwhile `extractPricing` silently normalizes invalid values:

| `x-zevium-free-tier` value | Validator | `extractPricing` result | Gateway behavior |
|---|---|---|---|
| `2.7` | (no check) | `freeTier: 2` | 2 free/day (silent floor, 26% under intent) |
| `-5` (typo) | (no check) | `freeTier: undefined` | free tier silently disabled |
| `"10"` (string) | (no check) | `freeTier: 10` | 10 free/day (silent string coercion via `asNumber`) |
| `1e15` | (no check) | `freeTier: 1e15` | effectively unlimited free calls — publisher-funded |
| `"abc"` | (no check) | `freeTier: undefined` | free tier silently disabled |

Because the free tier is **publisher-funded** (per the JSDoc and PRODUCT.md),
the `1e15` row is especially dangerous: a publisher typo or copy-paste error
silently makes the endpoint free for an effectively unlimited daily volume at
the publisher's expense, with no validation error at publish.

**Trigger / impact:** A publisher publishes `"x-zevium-free-tier": 2.7`
(thinking in fractional terms, or a typo) or `"-5"` (sign typo) or a huge
number. `validateOpenApiSpec` returns zero errors and zero warnings for the
free-tier field in all cases. The gateway then either silently floors (under
the publisher's intended daily quota), silently disables (when the publisher
intended a free tier), or silently grants a near-unlimited publisher-funded
free tier. The publisher sees no signal at publish that their free-tier value
was rewritten.

**Fix:** Validate `x-zevium-free-tier` in `collectOpenApiSpecIssues` alongside
`x-zevium-cost` — require a positive integer (`Number.isInteger(v) && v >= 1`)
and emit an error otherwise — so the floor in `extractPricing` is never
load-bearing for this field. At minimum, reject non-integer and non-positive
values at publish.

---

### [SEV: P2] `extractPricing` floors non-integer `x-zevium-cost` (e.g. `3.9 → 3`) while the validator accepts any finite `≥ 0` — published price silently diverges from charged price

**Location:** `packages/shared/src/openapi.ts:177–178`.

```ts
// packages/shared/src/openapi.ts:177-178
  const costRaw = asNumber(op["x-zevium-cost"]);
  const cost = costRaw !== undefined && costRaw > 0 ? Math.floor(costRaw) : 1;
```

**Problem:** The validator (`validate.ts:141–149`) accepts any finite
`cost >= 0`, including non-integers like `3.9` — no `Number.isInteger` check.
`extractPricing` then `Math.floor`s, so `x-zevium-cost: 3.9` becomes `cost: 3`
on the gateway. The publisher publishes at "3.9 credits," the catalogue
(`convex/catalogue.ts:51–52`) shows `minCost`/`maxCost` computed from the
floored `3`, and `pipeline.ts:152` charges `3` credits per call. The published
price and the charged price silently differ by up to ~1 credit per call (the
floor can undercharge by up to 0.999… credits, i.e. up to ~33% for a `2.9`
cost), with no validation error and no warning.

The test `openapi.test.ts:126–133` pins this as intended:
```ts
it("floors positive costs and free tier", () => {
  expect(
    extractPricing({ "x-zevium-cost": 3.9, "x-zevium-free-tier": 2.2 }),
  ).toEqual({ cost: 3, freeTier: 2 });
```
— but the floor is only safe if the validator guarantees integers upstream,
which it does not. As written, the floor is load-bearing for correctness and
the publisher gets no feedback that their published fractional price will not
be honored.

**Trigger / impact:** Any publisher who sets a non-integer `x-zevium-cost`
(decimal point, locale comma, unit confusion) publishes successfully and is
silently undercharged relative to their published intent on every call. The
catalogue listing price and the gateway charge also disagree (catalogue uses
the same floored `pricing.cost` from `extractPricing`, so they happen to match
each other — but both diverge from the literal value in the published spec).

**Fix:** Make the validator require `Number.isInteger(cost)` for
`x-zevium-cost` (reject `3.9` at publish with a clear error), so the
`Math.floor` in `extractPricing` becomes a defensive no-op rather than a
load-bearing silent rewrite. If fractional costs are ever to be supported
(unlikely for integer credits), the floor must be replaced with an explicit
error at the extraction boundary, not a silent undercharge.

---

### [SEV: P3] `EndpointPricing` types `cost`/`freeTier` as bare `number`, encoding none of the integer-credit invariants the billing path depends on

**Location:** `packages/shared/src/pricing.ts:1–6`.

```ts
export interface EndpointPricing {
  /** Credits per call — `x-zevium-cost`, default 1 */
  cost: number;
  /** Free calls per day — `x-zevium-free-tier`, publisher-funded */
  freeTier?: number;
}
```

**Problem:** The system's integrity rests on integer credits —
`convex/accounting.ts` guards every write with `Number.isSafeInteger` and
documents "Credits are integer units; $1 is 10,000 credits." But the type that
crosses the gateway→wallet boundary — `MatchedOperation.pricing`
(`openapi.ts:58`) → `pipeline.ts:115–116` → `wallet.reserve(reservationId, cost, …)`
/ `wallet.consumeFreeTier(keyId, freeTier, …)` — is bare `number`. Today
`extractPricing` is the sole producer and it floors, so the runtime is safe,
but nothing in the type contract prevents a future producer from emitting
`3.5`, `NaN`, `-1`, or `1e21` (an unsafe integer) and having it flow straight
into a wallet debit. The JSDoc says "default 1" but the type admits `0` and
negatives, which is exactly the ambiguity Finding 1 exploits.

Note `x-zevium-cost: 1e21` is reachable: `asNumber` (`openapi.ts:29–35`)
accepts it (`Number.isFinite(1e21)` is `true`), the validator accepts it
(finite, `>= 0`), and `Math.floor(1e21) === 1e21` flows into
`wallet.reserve(id, 1e21, …)`. The wallet will (correctly) return
`insufficient`, so this is not corruption — but it shows the type places no
upper or integer-domain bound on what reaches the debit path.

**Trigger / impact:** Latent. No current producer violates the invariant
beyond Findings 1 and 3. The risk is future: any new code path that constructs
`EndpointPricing` without `extractPricing` (e.g. a future mock-server or admin
tool) can silently emit non-integer/unsafe credits into the wallet.

**Fix (optional, low priority given house style):** This is consistent with the
codebase's use of `number` for credits in `accounting.ts`, so it is not a
strict regression — but at minimum, add a runtime assertion at the wallet
reserve boundary (`pipeline.ts:152`) that `Number.isSafeInteger(cost) &&
cost >= 0` before debiting, so a bad producer cannot silently corrupt the
ledger. A branded `Credits` type would be the fuller fix but is out of
proportion to the current risk.

---

## Summary

- **Findings:** 4 (P1: 1, P2: 2, P3: 1)
- **Top 3:**
  1. **[P1]** `extractPricing` rewrites `x-zevium-cost: 0 → 1`, contradicting the
     publish validator's `≥ 0` acceptance — every call to a publisher's
     intentionally-free endpoint is silently overcharged 1 credit, accruing
     publisher earnings against intent. (`openapi.ts:176–178` ↔ `validate.ts:141–149`)
  2. **[P2]** `x-zevium-free-tier` is never validated; `extractPricing` silently
     floors (`2.7 → 2`), drops (`-5`, `"abc"`), or accepts absurd magnitudes
     (`1e15` = effectively unlimited publisher-funded free tier) with zero
     publish-time feedback. (`openapi.ts:180–181` ↔ `validate.ts`)
  3. **[P2]** `extractPricing` floors non-integer `x-zevium-cost` (`3.9 → 3`)
     while the validator accepts any finite `≥ 0` — charged price silently
     diverges from the published spec by up to ~1 credit/call. (`openapi.ts:177–178`)

**Cross-boundary note:** The root cause of Findings 1 and 3 is a
validator↔extractor disagreement — the publish gate (`validate.ts`) is the
dispatch point that decides which `x-zevium-cost` values reach the gateway, and
it accepts values (`0`, `3.9`) that `extractPricing` silently rewrites. Both
layers are deliberately authored (both have pinning tests), so neither is
obviously "the bug" in isolation; the defect is their disagreement, which
produces charged-price ≠ published-price on every affected call. The fix
belongs on whichever side the team chooses as the source of truth — but the two
must agree, and today they do not.
