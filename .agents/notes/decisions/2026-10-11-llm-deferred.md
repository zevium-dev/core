# Defer LLM listings and preserve revival policy

> Date: 2026-10-11 · Status: accepted; deferral effective, enforcement tracked separately · Decided by: owner
> Session: [owner decisions](../sessions/2026-10-11-owner-decisions.md)

## Decision now

Defer LLM per-token support entirely: “forget about LLMs for now.” Hide per-token LLM listings and make them non-callable; retain code and historical accounting. P0 #425 enforces this across public discovery and execution surfaces. #329's implementation remains present until that issue lands; this documentation does not switch it off.

Supersedes active LLM scope and hold sizing in [2026-10-10 per-token pricing](2026-10-10-llm-per-token-pricing.md). Rounding and credit precision are deferred too; owner is open to finer-grained credits when LLMs return. No change to today's exchange rate.

## Future direction, not current permission

P2 #431 records revival:

- Small fixed hold, approximately **$0.10 per call**, instead of a maximum-cost hold.
- Balance may go negative to an approximate **-$1 floor**; any balance below zero blocks further calls. Existing zero-balance block still applies. Exact hold, floor and concurrent exposure policy are unresolved.
- Cancel upstream when the client disconnects.
- Aborted streams usually do not deliver the final usage chunk. Cancellation alone cannot establish the bill. A streamed-byte estimate or provider usage lookup, with reconciliation, is still needed; neither method is selected here.

This future debt policy **conflicts with the product rule “Never surprise-overage”**. Amend that rule explicitly in AGENTS.md and product documentation before revival, with agreed disclosure and floor enforcement. This decision does not amend it now. Fixed-price calls retain no consumer debt.

## Affects

[Pricing](../features/pricing.md), [gateway](../features/gateway.md), [wallet billing](../features/wallet-billing.md), [publishing](../features/publishing-specs.md), [agent surface](../features/agent-surface.md).
