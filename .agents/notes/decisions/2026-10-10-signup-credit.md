# Every new org gets a small default credit

> Date: 2026-10-10 · Status: accepted direction, not built · Decided by: user ("we can top up every like $1 or something by default")
> Session: [2026-10-10](../sessions/2026-10-10-competitive-research-and-docs.md)

## Decision

New organizations start with about $1 of promotional credit (10,000 credits) by default. This resolves the free-tier conflict: code refuses free-tier calls at zero balance, and the golden path wants a real free call before any payment. With a starting balance, free-tier and cheap paid calls work immediately after signup.

Confirmed by user (same session): $1 once per organization.

## Design notes

- Use the existing non-refundable promotional funding lot (consumed first, never refundable) — see [wallet-billing](../features/wallet-billing.md) Tech.
- Spend on paid listings still pays publishers 95%: Zevium funds it as acquisition cost.
- Abuse: grant once per verified account/org (treg grants $1 once per verified eligible team). Define "verified" before launch.

## Open

- Eligibility/verification rule and anti-farming limits.
- Does the grant also apply to anonymous x402 wallet sessions? Assumed no.

## Affects

[wallet-billing](../features/wallet-billing.md), [pricing](../features/pricing.md), [accounts-orgs](../features/accounts-orgs.md)
