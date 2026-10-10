# Two consumer rails: API keys and keyless x402

> Date: 2026-10-10 · Status: built behind configuration (#109); sandbox activation pending · Decided by: user
> Session: [2026-10-10](../sessions/2026-10-10-competitive-research-and-docs.md)

## Decision

Support both:

|          | Enterprise / teams           | Individuals / agents                    |
| -------- | ---------------------------- | --------------------------------------- |
| Auth     | API key                      | x402 payment (no key)                   |
| Wallet   | Org wallet                   | Ephemeral wallet bound to payer address |
| Funding  | Card / invoice / ACH top-ups | x402 payment, e.g. $1 once              |
| Controls | SSO, audit, per-key caps     | Zero balance blocks                     |

Enterprises do not want x402-style payment; individuals and agents want zero signup.

## Design direction

- Do **not** settle each call on-chain. Research: Stripe minimum settlement 0.01 USDC, $0.50 for cards; Zevium calls are $0.002–$0.05.
- An x402 payment funds an ephemeral wallet session; later calls draw from it in the wallet DO with no chain step.
- Zero balance still blocks. Same 95/5 split.
- Recommended first rail (research): Stripe-hosted x402 + MPP as a top-up rail into the existing ledger — one vendor, unchanged Connect payouts.

## Rule change

AGENTS.md product rule "every gateway/agent call is key-authenticated" becomes "authenticated by an API key or a verified wallet session". Updated in AGENTS.md on 2026-10-10.

## Related

[anonymous wallet expiry](2026-10-10-anonymous-wallet-expiry.md). Feature: [machine-payments](../features/machine-payments.md). Research: [landscape](../research/agent-api-marketplace-landscape.md).

## Implementation

Built in #109. See [machine-payments](../features/machine-payments.md) for anonymous accounting ownership, top-up/session contract, per-lot expiry, and required sandbox setup.
