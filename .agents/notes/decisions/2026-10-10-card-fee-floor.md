# Card-fee floor on top-ups

> Date: 2026-10-10 · Status: superseded by [card-fee passthrough](2026-10-10-card-fee-passthrough.md)
> Session: [2026-10-10](../sessions/2026-10-10-competitive-research-and-docs.md)

## Problem

With the fee on the publisher side ([decision](2026-10-10-platform-fee-publisher-side.md)), card processing (~2.9% + $0.30, US standard rate, not re-verified) is paid from Zevium's 5%:

| Top-up | Card fee | Zevium 5% | Net     |
| ------ | -------- | --------- | ------- |
| $10    | ~$0.59   | $0.50     | −$0.09  |
| $20    | ~$0.88   | $1.00     | ~+$0.12 |
| $50    | ~$1.75   | $2.50     | ~+$0.75 |

Connect payout fees come on top.

## Proposal

- Minimum top-up ~$20–25.
- Auto-recharge in larger chunks.
- ACH / bank transfer top-ups for enterprises (cheaper than cards).
- Consumer still never pays above face value.

## Open

Exact minimum; verify current Stripe and Connect fees on the live account before deciding.

## Affects

[wallet-billing](../features/wallet-billing.md)
