# Seed supply with Zevium house listings, sourced from aggregators first

> Date: 2026-10-10 · Status: accepted direction, not built · Decided by: user
> Session: [2026-10-10](../sessions/2026-10-10-competitive-research-and-docs.md)

## Decision

Zevium becomes its own first publisher to break cold start:

- **House listings**: Zevium publishes listings itself and eats the losses for now (sell below cost or at cost while building demand).
- **Sourcing order**: use treg as the upstream provider for what it covers; RapidAPI for what treg lacks; then replace sources one by one with Zevium-built or direct-vendor integrations.
- No single launch vertical chosen; breadth comes from aggregators.

## Label

House listings show **"Operated by Zevium"** — Zevium bears the upstream charge and the risk (user, same session).

## Why

Two-sided cold start: zero listings means zero agents means zero publishers. treg solved supply by holding vendor accounts ([treg comparison](../research/treg-comparison.md)); Zevium gets breadth on day one by reselling through aggregators while the third-party publisher side grows.

## Hard gates before any house listing goes live

- **Terms of service**: confirm treg's and RapidAPI's terms (and each underlying API's terms) allow resale/redistribution through another marketplace. If not, the listing does not ship. Note: treg's software license already blocks reusing its code ([findings/treg-reuse.md](../findings/treg-reuse.md)); calling its paid API is a separate question.
- **Credentials**: upstream aggregator keys are Zevium's own publisher credentials ([upstream-credentials](../features/upstream-credentials.md)); per-call cost from the aggregator must be tracked against what consumers pay.
- **Loss budget**: set a monthly cap on subsidy spend.

## Open

- Pricing rule for house listings (at aggregator cost, below cost, or small markup).
- Does the 95/5 split apply internally (Zevium-as-publisher), or are house listings booked separately?
- Fit with capability routing: house listings from different sources become interchangeable providers for one capability.

## Affects

[publishing-specs](../features/publishing-specs.md), [capability-routing](../features/capability-routing.md), [upstream-credentials](../features/upstream-credentials.md), [product overview](../product/overview.md)
