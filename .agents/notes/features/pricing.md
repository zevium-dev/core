# Pricing

> Status: #399 fixed; partial (per-call `x-zevium-cost` + daily free tier + signup credit #317 built; per-token #329 built; tiered and outcome pricing planned) · Updated: 2026-10-10
> Code: `packages/shared/src/openapi.ts`, `packages/shared/src/pricing.ts`, `apps/gateway/src/token-metering.ts`, `packages/shared/src/validate.ts`, `apps/gateway/src/pipeline.ts`, `apps/gateway/src/wallet.ts` (`consumeFreeTier`), `apps/gateway/src/discovery.ts`, `convex/accounting.ts`, `apps/web/src/components/spec-editor/rail-endpoints.tsx`, `apps/web/src/components/spec-editor/rail-endpoints.test.tsx`
> Related: [publishing-specs](publishing-specs.md), [wallet-billing](wallet-billing.md), [earnings-payouts](earnings-payouts.md), [gateway](gateway.md), [catalogue-search](catalogue-search.md), [agent-surface](agent-surface.md), [machine-payments](machine-payments.md), [decision: platform fee publisher side](../decisions/2026-10-10-platform-fee-publisher-side.md), [decision: LLM per-token pricing](../decisions/2026-10-10-llm-per-token-pricing.md)

Per-call or per-token pricing declared by the publisher in the OpenAPI spec (`x-zevium-cost`, optional `x-zevium-free-tier`). No parallel pricing tables: the published, immutable spec version is the only price source. Every charge splits 95% publisher / 5% platform at charge time, priced in credits at one global rate ($1 = 10,000 credits).

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
- **Fee side (decided 2026-10-10)**: the 5% is taken from the publisher side. Consumer tops up $10 and gets $10 of credits — no top-up surcharge (unlike OpenRouter's 5.5%). Chosen to be consumer-friendly. [decision](../decisions/2026-10-10-platform-fee-publisher-side.md)

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

**LLM endpoints (#329 built)**: spec input/output token rates; hold estimated input plus output allowance, settle observed usage, release remainder. Missing usage charges zero; actual charges never exceed the hold. Same 95/5 split. Zevium does not house-list LLMs. [Contract and rounding](../decisions/2026-10-10-llm-per-token-pricing.md#implementation-contract-329).

Roadmap ([roadmap](../product/roadmap.md)):

- P1 #11 — Free tier enforcement (publisher-funded) + tiered pricing
- P0 #329 — Per-token pricing built; P2 #21 — Outcome-based pricing remains planned

## Flow

Pricing has no screen of its own; it surfaces in other features:

- Spec editor pricing lint: warn on operations missing `x-zevium-cost`; pricing summary sidebar ("12 endpoints, 2–10 credits, free tier on 3") — [publishing-specs](publishing-specs.md)
- Catalogue filters (price range, has-free-tier), listing-card price range, API-detail pricing table with free tier highlighted — [catalogue-search](catalogue-search.md)
- Discovery index carries per-endpoint pricing metadata so agents evaluate cost **before** calling — [agent-surface](agent-surface.md)
- Gateway charges the matched endpoint's price per call; `402` on insufficient balance — [gateway](gateway.md)

## Tech

- **Inline pricing validation (#399)**: the editor checks safe non-negative integers and the shared cost/free-tier caps before write-back. Rejected text stays local and editable, with a field-linked error retained through blur; the valid JSON draft and other controls remain intact. Clearing still removes the extension; zero and the inclusive upper bound remain valid.

- **Token pricing (#329)**: `TokenPricing` is an object form of `x-zevium-cost`, carried through editor, catalogue reference, discovery, and MCP. Catalogue cards identify token pricing instead of labeling hold ceilings as per-call prices; numeric price filters use the maximum hold ceiling. Scalar editor controls cannot overwrite token rates; edit the object in the spec. Full sizing, whole-credit rounding, parser limits, fallback, response header, and budget rules are owned by the [implementation contract](../decisions/2026-10-10-llm-per-token-pricing.md#implementation-contract-329).
- `token_usage` settlement identity records the immutable spec version, admitted hold (`listedCostCredits` / `budgetReservationCredits`), and actual charged credits. Convex validates actual ≤ hold, retains per-call equality checks for scalar pricing, and uses existing whole-credit funding and exact 95/5 atom accounting.

- Repo shape: `packages/shared/` owns spec parsing, `x-zevium-*` extraction, and types shared web↔gateway (see [architecture overview](../architecture/overview.md))
- Exact 95/5 split uses accounting atoms (`10,000 atoms = 1 credit`) — see **Connect settlement** in [earnings-payouts](earnings-payouts.md)
- Upstream platform metadata cannot override gateway cost/free-tier/request-id facts — see **Gateway forwarding boundary** in [gateway](gateway.md)

### Code facts (read from source 2026-10-10, not in source docs)

- `packages/shared/src/openapi.ts` extracts per-operation `x-zevium-cost` / `x-zevium-free-tier` into `EndpointPricing { cost, token?, freeTier? }` (`packages/shared/src/pricing.ts`)
- Missing `x-zevium-cost` hides the operation from matching, catalogue, discovery, and MCP; editor lint warns that it is hidden. Explicit scalar `0` stays free.
- Scalar price and daily quota must be finite safe non-negative integers. Token object rates are validated by `parseTokenPricing`. `MAX_ENDPOINT_COST_CREDITS = 1_000_000` (no call above a $100 pack); `MAX_DAILY_FREE_TIER_CALLS = 1_000_000`
- Free tier is enforced in the wallet DO (`consumeFreeTier`): counter keyed by consumer org × project × method × path template × UTC day. Free-tier calls are rejected `insufficient_credits` when wallet balance ≤ 0
- `cost === 0` operations skip reservation but still run key authorization (`authorizeKey`)
- Signup credit uses the existing promotion funding path and advances the edge wallet checkpoint; see [wallet-billing](wallet-billing.md#implementation-notes).
- `convex/accounting.ts`: `CREDITS_PER_USD = 10_000`, `PLATFORM_FEE_BASIS_POINTS = 500`
- `apps/gateway/src/discovery.ts` exposes `freeTier` per endpoint in discovery output

## Decisions

- 2026-10-10 — Platform fee taken publisher-side: $10 top-up = $10 credits; Zevium keeps 5% of each call's spend, publisher 95%. Matches current code (flat packs, 500 bps fee). [decision](../decisions/2026-10-10-platform-fee-publisher-side.md)
- 2026-10-10 — ACCEPTED: card processing fee passed through at cost as a separate, transparent line on top-ups (OpenCode Zen style); credits stay face value; no minimum-top-up floor. [decision](../decisions/2026-10-10-card-fee-passthrough.md)
- 2026-10-10 — BUILT (#317): eligible orgs get $1 promotional credit, once per Clerk creator; see [wallet-billing](wallet-billing.md#implementation-notes) for delivery and verification limits. [decision](../decisions/2026-10-10-signup-credit.md)
- 2026-10-10 — BUILT: operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Replaces code's default of 1 credit. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)
- 2026-10-10 — BUILT (#329): LLM per-token pricing — hold estimated input + `max_tokens` (or fixed cap) at spec rates, settle actual, release rest; in-flight budget + 402 reasons copied from OpenRouter. [decision](../decisions/2026-10-10-llm-per-token-pricing.md)

## Open questions

- Doc/code conflict: PRODUCT roadmap lists free tier enforcement as P1 (planned); code already enforces daily free tier per consumer org per endpoint. Code wins; roadmap needs update. Tiered pricing half of P1 #11 is not built
- Free-tier golden path now uses signup credit (#317), subject to trusted Clerk creator delivery; zero balance still blocks. See [wallet-billing](wallet-billing.md#implementation-notes).
