# Pricing

> Status: root cutover implemented; owner activation pending · Updated: 2026-10-11
> Code: `packages/shared/src/{openapi,pricing-policy}.ts`, `convex/{billing,accounting}.ts`, `convex/money/`
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

**LLM endpoints: unavailable.** Per-token execution is deleted. Publishers cannot save/publish token-priced drafts in the canonical control plane; existing token operations remain hidden and non-callable on read surfaces. Scalar per-call APIs remain available. Revival requires the [future policy](#deferred-llm-pricing-and-future-policy) and a new implementation review.

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

Only explicit scalar per-call prices (including zero) are executable. Zero wallet balance still blocks free operations; mocks never execute upstream. Exact 95/5 atoms, source-backed lots and test-mode principal top-ups are canonical. Per-token schema/execution is deleted/deferred; shared parsing retains rejection/editor compatibility only. Card fee collection stays disabled until #318; quoted/charged/actual fee facts and full-paid-amount refund conservation are implemented.

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

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
