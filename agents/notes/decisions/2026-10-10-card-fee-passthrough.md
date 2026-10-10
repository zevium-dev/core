# Card processing fee passed through at cost, shown transparently

> Date: 2026-10-10 · Status: accepted direction, not built · Decided by: user
> Supersedes: [card-fee floor](2026-10-10-card-fee-floor.md) (proposal)
> Session: [2026-10-10](../sessions/2026-10-10-competitive-research-and-docs.md)

## Decision

Top-ups show the payment processor's fee as a separate, at-cost line item on top of the credit amount. Credits stay face value: buy $10 of credits, pay $10 + the processing fee. Zevium adds no markup on that fee. The 5% platform fee stays on the publisher side ([fee decision](2026-10-10-platform-fee-publisher-side.md)).

## Why

User wants transparency over hiding costs, modeled on OpenCode Zen: users buy because the integration is good and the fee is honest. Rejects both a minimum-top-up floor and OpenRouter's percentage fee folded into the top-up.

Reference (secondary sources, not verified against OpenCode's own page): OpenCode Zen passes card fees at cost (reported 4.4% + $0.30); a $20 top-up is reported as $20 + $1.23 processing fee; default auto-reload adds $20 when balance drops below $5. [codeagentswarm](https://www.codeagentswarm.com/en/guides/opencode-plans-and-pricing), [qcode.cc](https://qcode.cc/en/opencode-zen-vs-go), [standardcompute](https://standardcompute.com/opencode-pricing).

## Consequences

- Checkout must compute and display the fee before payment; the fee is not credited.
- Fee amount should be grossed up so the net received covers the credits exactly (fee charged on the total).
- Auto-reload (OpenCode-style) fits naturally: bigger, rarer reloads mean fewer per-transaction $0.30 charges.

## Open

- **Legal check before launch:** card-network surcharge rules (e.g. caps, debit-card prohibition, disclosure) and US state restrictions may treat a card fee as a surcharge. Confirm with Stripe whether a separate "processing fee" line on a credit purchase is permitted per region, or model it as a service fee.
- Fee per payment method (card vs ACH vs Link vs stablecoin) — likely differs; show each at cost.
- Refund handling: is the processing fee refunded when credits are refunded?

## Affects

[wallet-billing](../features/wallet-billing.md), [pricing](../features/pricing.md)
