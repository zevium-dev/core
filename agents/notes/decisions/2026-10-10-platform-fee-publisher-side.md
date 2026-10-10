# Platform fee comes from the publisher side

> Date: 2026-10-10 · Status: accepted · Decided by: user
> Session: [2026-10-10](../sessions/2026-10-10-competitive-research-and-docs.md)

## Decision

Consumer pays face value: a $10 top-up buys $10 of calls. No top-up surcharge. On each call Zevium keeps 5% of the spend and the publisher earns 95%.

## Why

Consumer-friendly by design. OpenRouter's model (5.5% fee on top-ups, publisher gets list price) is publisher-friendly and makes consumers pay $10.50 for $10. The user rejected that. The 5% figure was chosen by feel and may be revisited; the side it comes from is the decision.

## Consequences

- Publishers price knowing 5% is deducted; publisher pricing UI should show net (set 100 credits → earn 95).
- Payment processing cost is paid out of Zevium's 5% — see [card-fee floor](2026-10-10-card-fee-floor.md) (proposed).
- LLM endpoints follow the same rule — see [LLM per-token pricing](2026-10-10-llm-per-token-pricing.md) (proposed).

## Affects

[pricing](../features/pricing.md), [wallet-billing](../features/wallet-billing.md), [earnings-payouts](../features/earnings-payouts.md)
