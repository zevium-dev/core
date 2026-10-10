# Pricing

> Status: partial (per-call `x-zevium-cost` + daily free tier built; tiered, per-token, outcome pricing planned) · Updated: 2026-10-10
> Code: `packages/shared/src/openapi.ts`, `packages/shared/src/pricing.ts`, `packages/shared/src/validate.ts`, `apps/gateway/src/pipeline.ts`, `apps/gateway/src/wallet.ts` (`consumeFreeTier`), `apps/gateway/src/discovery.ts`, `convex/accounting.ts`
> Related: [publishing-specs](publishing-specs.md), [wallet-billing](wallet-billing.md), [earnings-payouts](earnings-payouts.md), [gateway](gateway.md), [catalogue-search](catalogue-search.md), [agent-surface](agent-surface.md), [machine-payments](machine-payments.md), [decision: platform fee publisher side](../decisions/2026-10-10-platform-fee-publisher-side.md), [decision: LLM per-token pricing (proposed)](../decisions/2026-10-10-llm-per-token-pricing.md)

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

Planned pricing extensions (roadmap): tiered/graduated per-call pricing, per-token cost expressions, outcome-based pricing.

**LLM endpoints (PROPOSED 2026-10-10, not accepted, not built)**: same 5% rule; per-token pricing in the spec (input/output rates + per-call max); reserve the max, settle actual; Zevium does not house-list LLMs itself. [decision](../decisions/2026-10-10-llm-per-token-pricing.md)

Roadmap ([roadmap](../product/roadmap.md)):

- P1 #11 — Free tier enforcement (publisher-funded) + tiered pricing
- P2 #21 — Per-token / outcome-based pricing extensions

## Flow

Pricing has no screen of its own; it surfaces in other features:

- Spec editor pricing lint: warn on operations missing `x-zevium-cost`; pricing summary sidebar ("12 endpoints, 2–10 credits, free tier on 3") — [publishing-specs](publishing-specs.md)
- Catalogue filters (price range, has-free-tier), listing-card price range, API-detail pricing table with free tier highlighted — [catalogue-search](catalogue-search.md)
- Discovery index carries per-endpoint pricing metadata so agents evaluate cost **before** calling — [agent-surface](agent-surface.md)
- Gateway charges the matched endpoint's price per call; `402` on insufficient balance — [gateway](gateway.md)

## Tech

- Repo shape: `packages/shared/` owns spec parsing, `x-zevium-*` extraction, and types shared web↔gateway (see [architecture overview](../architecture/overview.md))
- Exact 95/5 split uses accounting atoms (`10,000 atoms = 1 credit`) — see **Connect settlement** in [earnings-payouts](earnings-payouts.md)
- Upstream platform metadata cannot override gateway cost/free-tier/request-id facts — see **Gateway forwarding boundary** in [gateway](gateway.md)

### Code facts (read from source 2026-10-10, not in source docs)

- `packages/shared/src/openapi.ts` extracts per-operation `x-zevium-cost` / `x-zevium-free-tier` into `EndpointPricing { cost, freeTier? }` (`packages/shared/src/pricing.ts`)
- Missing `x-zevium-cost` defaults to 1 credit at the gateway; `validate.ts` emits a warning ("Missing x-zevium-cost (defaults to 1 at gateway)")
- Both extensions must be finite safe non-negative integers. `MAX_ENDPOINT_COST_CREDITS = 1_000_000` (no call above a $100 pack); `MAX_DAILY_FREE_TIER_CALLS = 1_000_000`
- Free tier is enforced in the wallet DO (`consumeFreeTier`): counter keyed by consumer org × project × method × path template × UTC day. Free-tier calls are rejected `insufficient_credits` when wallet balance ≤ 0
- `cost === 0` operations skip reservation but still run key authorization (`authorizeKey`)
- `convex/accounting.ts`: `CREDITS_PER_USD = 10_000`, `PLATFORM_FEE_BASIS_POINTS = 500`
- `apps/gateway/src/discovery.ts` exposes `freeTier` per endpoint in discovery output

## Decisions

- 2026-10-10 — Platform fee taken publisher-side: $10 top-up = $10 credits; Zevium keeps 5% of each call's spend, publisher 95%. Matches current code (flat packs, 500 bps fee). [decision](../decisions/2026-10-10-platform-fee-publisher-side.md)
- 2026-10-10 — ACCEPTED: card processing fee passed through at cost as a separate, transparent line on top-ups (OpenCode Zen style); credits stay face value; no minimum-top-up floor. [decision](../decisions/2026-10-10-card-fee-passthrough.md)
- 2026-10-10 — ACCEPTED: new orgs get ~$1 default promotional credit so free-tier and first calls work at signup. [decision](../decisions/2026-10-10-signup-credit.md)
- 2026-10-10 — ACCEPTED (not built): operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Replaces code's default of 1 credit. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)
- 2026-10-10 — ACCEPTED (not built): LLM per-token pricing — hold estimated input + `max_tokens` (or fixed cap) at spec rates, settle actual, release rest; in-flight budget + 402 reasons copied from OpenRouter. [decision](../decisions/2026-10-10-llm-per-token-pricing.md)

## Open questions

- Doc/code conflict: PRODUCT roadmap lists free tier enforcement as P1 (planned); code already enforces daily free tier per consumer org per endpoint. Code wins; roadmap needs update. Tiered pricing half of P1 #11 is not built
- Doc/code conflict: FLOW consumer golden path tries the API via "mock mode or free tier" before top-up; code rejects free-tier calls when wallet balance ≤ 0, so a fresh unfunded org cannot use free tier. Confirm intended behavior Direction 2026-10-10: resolved by default signup credit ([decision](../decisions/2026-10-10-signup-credit.md)); not built.
