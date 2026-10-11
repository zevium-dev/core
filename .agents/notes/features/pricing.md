# Pricing

> Status: #399 fixed; partial (explicit per-call `x-zevium-cost`, hidden unpriced operations (#316) + daily free tier + signup credit #317 built; per-token #329 deferred/disabled; tiered and outcome pricing planned) · Updated: 2026-10-11
> Code: `packages/shared/src/openapi.ts`, `packages/shared/src/pricing.ts`, `apps/gateway/src/token-metering.ts`, `packages/shared/src/validate.ts`, `apps/gateway/src/pipeline.ts`, `apps/gateway/src/wallet.ts` (`consumeFreeTier`), `apps/gateway/src/discovery.ts`, `convex/accounting.ts`, `apps/web/src/components/spec-editor/rail-endpoints.tsx`, `apps/web/src/components/spec-editor/rail-endpoints.test.tsx`, `convex/catalogue.ts`, `convex/registrySync.ts`, `apps/web/src/lib/spec-pricing.ts`, `packages/shared/src/pricing-policy.ts`
> Related: [publishing-specs](publishing-specs.md), [wallet-billing](wallet-billing.md), [earnings-payouts](earnings-payouts.md), [gateway](gateway.md), [catalogue-search](catalogue-search.md), [agent-surface](agent-surface.md), [machine-payments](machine-payments.md), [decision: platform fee publisher side](../decisions/2026-10-10-platform-fee-publisher-side.md), [decision: LLM per-token pricing](../decisions/2026-10-10-llm-per-token-pricing.md)

Per-call pricing declared by the publisher in the OpenAPI spec (`x-zevium-cost`, optional `x-zevium-free-tier`). No parallel pricing tables: the published, immutable spec version is the only price source. Every charge splits 95% publisher / 5% platform at charge time, priced in credits at one global rate ($1 = 10,000 credits).

## Product

### Revenue model

```
Consumer pays:     100 credits / call
Zevium takes:        5 credits (5% platform cut)
Publisher earns:    95 credits (95% revenue share)
```

- **Publishers keep 95%.** Low platform fees preserve publisher economics for high-volume machine traffic and make the split easy to understand
- **Exchange rate: $1 = 10,000 credits** (1 credit = $0.0001). Market per-call pricing of $0.002–$0.05 maps to 20–500 credits. Rate is a launch default, revisitable — but one global constant, never per-API
- Credits are prepaid by consumer organizations via one-time top-up purchases
- Platform cut + publisher share are calculated per call at charge time
- Publisher earnings accumulate and are settled via payouts ([earnings-payouts](earnings-payouts.md))
- **Fee side (decided 2026-10-10)**: the 5% is taken from the publisher side. Consumer tops up $10 and gets $10 of credits — no platform top-up surcharge; a separate card-fee estimate remains legal-gated in #318. Chosen to be consumer-friendly. [decision](../decisions/2026-10-10-platform-fee-publisher-side.md)

### How pricing works

Pricing is declared **in the OpenAPI spec** as vendor extensions on each path/operation:

```yaml
openapi: 3.1.0
info:
  title: OpenAI GPT API
servers:
  - url: https://api.openai.com
paths:
  /v1/chat/completions:
    post:
      x-zevium-cost: 10 # credits per call
      x-zevium-free-tier: 5 # optional: free calls per day
      summary: Chat completion
  /v1/embeddings:
    post:
      x-zevium-cost: 2
      summary: Create embeddings
```

The spec is the single source of truth for:

- Upstream address (`servers[0].url`)
- Available endpoints (`paths`)
- Per-endpoint pricing (`x-zevium-cost` on each operation)
- Free tier (`x-zevium-free-tier`, optional) — **publisher-funded**: free-tier calls are the publisher's acquisition spend, opted in per endpoint; the platform does not subsidize them

No parallel pricing tables. Published spec versions are immutable.

Pricing guidance for publishers: production agent-tool pricing clusters at $0.002–$0.05/call equivalents, and **agent traffic dominates** — an agent will loop on the cheapest useful endpoint, so price for machine volume, not human volume.

Planned pricing extensions (roadmap): tiered/graduated per-call pricing and outcome-based pricing.

**Retained LLM implementation (#329; deferred, hide/disable #425 pending)**: spec input/output token rates; hold estimated input plus output allowance, settle observed usage, release remainder. Missing usage charges zero; actual charges never exceed the hold. Same 95/5 split. Zevium does not house-list LLMs. [Contract and rounding](../decisions/2026-10-10-llm-per-token-pricing.md#implementation-contract-329).
**LLM endpoints (#329, PR #413): deferred/disabled.** Token-priced operations are hidden and unavailable; fixed-price operations remain available. Publishing a token-priced spec is allowed with those operations unavailable. Code is retained for revival after the [future policy](#deferred-llm-pricing-and-future-policy) is approved.

Roadmap ([roadmap](../product/roadmap.md)):

- P1 #11 — Free tier enforcement (publisher-funded) + tiered pricing
- P0 #425 — Hide/disable per-token LLM listings; P2 #431 — Revival/precision policy; P2 #21 — Outcome-based pricing remains planned
- #329 — Per-token pricing deferred/disabled; P2 #21 — Outcome-based pricing remains planned

## Flow

Pricing has no screen of its own; it surfaces in other features:

- Spec editor pricing lint: warn that operations missing `x-zevium-cost` stay hidden and cannot be called; publishing remains allowed; pricing summary sidebar ("12 endpoints, 2–10 credits, free tier on 3") — [publishing-specs](publishing-specs.md)
- Catalogue filters (price range, has-free-tier), listing-card price range, API-detail pricing table with free tier highlighted — [catalogue-search](catalogue-search.md)
- Discovery index carries per-endpoint pricing metadata so agents evaluate cost **before** calling — [agent-surface](agent-surface.md)
- Gateway charges the matched endpoint's price per call; `402` on insufficient balance — [gateway](gateway.md)

## Tech

### Accepted changes — implementation pending (2026-10-11)

P0 #425 must hide and block per-token LLM listings while retaining #329 code. Token behavior below describes that retained implementation, not approval to launch it. P2 #431 owns revival, precision and unresolved usage reconciliation. Fixed-price no-debt rules and current exchange rate remain unchanged.

### Current implementation

- **Inline pricing validation (#399)**: the editor checks safe non-negative integers and the shared cost/free-tier caps before write-back. Rejected text stays local and editable, with a field-linked error retained through blur; the valid JSON draft and other controls remain intact. Clearing removes the extension and keeps the cost input blank after blur, hiding the operation; rejected text cannot restore a price. Explicit zero makes it free, and the inclusive upper bound remains valid.

### Deferred LLM pricing and future policy

- **Default-off switch:** `packages/shared/src/pricing-policy.ts:isTokenPricingEnabled()` returns false for web, Convex, and gateway. Change that single build-time switch and deploy all three together to revive; there is no per-environment toggle that can drift. `extractPricing` returns `null` for valid token rates while disabled, so public references, discovery, MCP docs/search pricing, embedding endpoint text, and registry rollups omit those operations. Most-specific route selection happens first, preventing fallback to a priced template. Direct gateway and MCP calls return `404` without upstream execution, reservation, charge, or usage; direct message: `No available priced endpoint matches this method and path`.
- **Publishing policy:** accept with warning, matching unpriced operations. `collectOpenApiSpecIssues` validates rates even while disabled and explains that the operation is hidden/not callable. The editor retains token metadata, excludes disabled rates from summaries, marks them unavailable, and prevents scalar controls from overwriting the rates. Fixed scalar prices, including explicit zero, are unchanged.
- **Projection rollout:** catalogue pricing projection version is 2 while disabled, 3 when enabled. Existing bounded spec reads take over immediately for older projections until the five-minute backfill cron rebuilds them. No immutable specs or historical settlements are rewritten. JSON/SSE metering, hold sizing, wallet budgets and settlement code from PR #413 remain; tests exercise the disabled default and enabled implementation.
- **Future policy (deferred; not implemented):** fixed approximately $0.10 hold; allow in-flight settlement toward an approximately -$1 balance floor, blocking new calls below zero; cancel upstream when the client disconnects; finer credit granularity. Negative balances conflict with the current **no-surprise-overage** product rule. Revival needs an explicit amendment and a precise floor/admission contract before enabling. The retained implementation still follows the [original hold/settlement contract](../decisions/2026-10-10-llm-per-token-pricing.md#implementation-contract-329).

- `token_usage` settlement identity records the immutable spec version, admitted hold (`listedCostCredits` / `budgetReservationCredits`), and actual charged credits. Convex validates actual ≤ hold, retains per-call equality checks for scalar pricing, and uses existing whole-credit funding and exact 95/5 atom accounting.

- Repo shape: `packages/shared/` owns spec parsing, `x-zevium-*` extraction, and types shared web↔gateway (see [architecture overview](../architecture/overview.md))
- Exact 95/5 split uses accounting atoms (`10,000 atoms = 1 credit`) — see **Connect settlement** in [earnings-payouts](earnings-payouts.md)
- Upstream platform metadata cannot override gateway cost/free-tier/request-id facts — see **Gateway forwarding boundary** in [gateway](gateway.md)

### Code facts (read from source 2026-10-10, not in source docs)

- `packages/shared/src/openapi.ts` extracts per-operation `x-zevium-cost` / `x-zevium-free-tier` into `EndpointPricing { cost, token?, freeTier? }` (`packages/shared/src/pricing.ts`)
- `extractPricing` returns `EndpointPricing | null`: missing cost is unpriced (`null`), explicit `0` is free, positive integers are paid; token-rate objects return `null` while disabled (rates and hold ceiling are retained when enabled). No default price.
- Missing cost produces a warning, not a publish blocker. The editor keeps the price input blank and the operation editable, labels it hidden, and explains that explicit `0` makes it free. Draft price ranges/free-tier counts exclude hidden operations.
- `matchOperation` selects the most specific method/path before checking pricing. An unpriced match returns `null`; it cannot fall through to a priced template. Gateway and mock return route-not-found responses without upstream execution, reservations, or usage.
- Public catalogue/reference, discovery, MCP search/docs, semantic embedding endpoint text, and catalogue/registry price rollups omit unpriced operations. An all-unpriced spec has zero visible endpoints, with no displayed price range.
- Scalar price and daily quota must be finite safe non-negative integers. Token object rates are validated by `parseTokenPricing`. `MAX_ENDPOINT_COST_CREDITS = 1_000_000` (no call above a $100 pack); `MAX_DAILY_FREE_TIER_CALLS = 1_000_000`
- Free tier is enforced in the wallet DO (`consumeFreeTier`): counter keyed by consumer org × project × method × path template × UTC day. Free-tier calls are rejected `insufficient_credits` when wallet balance ≤ 0
- `cost === 0` operations skip reservation but still run key authorization (`authorizeKey`)
- Signup credit uses the existing promotion funding path and advances the edge wallet checkpoint; see [wallet-billing](wallet-billing.md#implementation-notes).
- `convex/accounting.ts`: `CREDITS_PER_USD = 10_000`, `PLATFORM_FEE_BASIS_POINTS = 500`
- `apps/gateway/src/discovery.ts` exposes `freeTier` per endpoint in discovery output

## Decisions

- 2026-10-11 — ACCEPTED: LLMs and rounding deferred; hide/disable #425, revival P2 #431. [Decision](../decisions/2026-10-11-llm-deferred.md).
- 2026-10-11 — Owner deferred LLM per-token pricing entirely. Keep code; hide token-priced operations and block calls by default. Future credit policy requires a product-rule amendment; see [future policy](#deferred-llm-pricing-and-future-policy). Decision record is maintained separately.
- 2026-10-11 — ACCEPTED: Fee estimate and full paid-amount refund; no true-up. #318 remains legal-gated. [Decision](../decisions/2026-10-11-card-fee-and-refunds.md).
- 2026-10-11 — Owner deferred LLM per-token pricing entirely. Keep code; hide token-priced operations and block calls by default. Future credit policy requires a product-rule amendment; see [future policy](#deferred-llm-pricing-and-future-policy). Decision record is maintained separately.
- 2026-10-11 — ACCEPTED: Grant only to signup personal org once per user; P0 #426. [Decision](../decisions/2026-10-11-signup-credit-eligibility.md).
- 2026-10-11 — Owner deferred LLM per-token pricing entirely. Keep code; hide token-priced operations and block calls by default. Future credit policy requires a product-rule amendment; see [future policy](#deferred-llm-pricing-and-future-policy). Decision record is maintained separately.

- 2026-10-10 — Platform fee taken publisher-side: $10 top-up = $10 credits; Zevium keeps 5% of each call's spend, publisher 95%. Matches current code (flat packs, 500 bps fee). [decision](../decisions/2026-10-10-platform-fee-publisher-side.md)
- 2026-10-10 — ACCEPTED: card processing fee passed through at cost as a separate, transparent line on top-ups (OpenCode Zen style); credits stay face value; no minimum-top-up floor. [decision](../decisions/2026-10-10-card-fee-passthrough.md) (Historical; scope superseded 2026-10-11 above.)
- 2026-10-10 — BUILT (#317): eligible orgs get $1 promotional credit, once per Clerk creator; see [wallet-billing](wallet-billing.md#implementation-notes) for delivery and verification limits. [decision](../decisions/2026-10-10-signup-credit.md) (Historical; scope superseded 2026-10-11 above.)
- 2026-10-10 — BUILT (#316): operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Publishing remains allowed with a warning. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)
- 2026-10-10 — BUILT (#329): LLM per-token pricing — hold estimated input + `max_tokens` (or fixed cap) at spec rates, settle actual, release rest; in-flight budget + 402 reasons copied from OpenRouter. [decision](../decisions/2026-10-10-llm-per-token-pricing.md) (Historical; scope superseded 2026-10-11 above.)

## Open questions

- Doc/code conflict: PRODUCT roadmap lists free tier enforcement as P1 (planned); code already enforces daily free tier per consumer org per endpoint. Code wins; roadmap needs update. Tiered pricing half of P1 #11 is not built
- Free-tier golden path now uses signup credit (#317), subject to trusted Clerk creator delivery; zero balance still blocks. See [wallet-billing](wallet-billing.md#implementation-notes).
