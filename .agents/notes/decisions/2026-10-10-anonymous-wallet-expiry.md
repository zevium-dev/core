# Anonymous wallet balance expires after one year

> Date: 2026-10-10 · Status: accepted for now (user: "we can change it later")
> Session: [2026-10-10](../sessions/2026-10-10-competitive-research-and-docs.md)

## Decision

Unused balance in keyless (x402 wallet-session) wallets expires **per top-up, one year after that top-up**. Example: $1 topped up today expires one year from today; another $1 topped up one week later expires one year plus one week from today. Fits the existing per-payment funding-lot model (each top-up = one lot with its own expiry; spend draws oldest lot first).

## Open

- Whether expiry notice is possible for an anonymous payer.
- Accounting treatment of expired balance (breakage) and any jurisdictional limits — check before launch.
- Org (keyed) wallets are not affected by this decision.

## Affects

[machine-payments](../features/machine-payments.md), [wallet-billing](../features/wallet-billing.md)
