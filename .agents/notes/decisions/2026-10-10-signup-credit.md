# Every new org gets a small default credit

> Date: 2026-10-10 · Status: built (#317) · Decided by: user ("we can top up every like $1 or something by default")
> Session: [2026-10-10](../sessions/2026-10-10-competitive-research-and-docs.md)

## Decision

New organizations start with about $1 of promotional credit (10,000 credits) by default. This resolves the free-tier conflict: code refuses free-tier calls at zero balance, and the golden path wants a real free call before any payment. With a starting balance, free-tier and cheap paid calls work immediately after signup.

Confirmed by user (same session): $1 once per organization.

## Design notes

- Use the existing non-refundable promotional funding lot (consumed first, never refundable) — see [wallet-billing](../features/wallet-billing.md) Tech.
- Spend on paid listings still pays publishers 95%: Zevium funds it as acquisition cost.
- Abuse: grant once per verified account/org (treg grants $1 once per verified eligible team). Define "verified" before launch.

## Implementation — 2026-10-10

- Exact grant: 10,000 credits through the existing non-refundable promotion ledger/funding path, idempotency key `promo:signup:{clerkOrgId}`.
- Authorized fallback: no creator verified-email signal is available in the current org mirror payload/claims. Grant once per Clerk creator user ID across all organizations, using server-trusted `created_by`; never infer creator from an invited member's JWT. Durable org/creator claims survive user-mirror deletion.
- Anonymous x402 wallets are excluded. Multiple Clerk accounts remain an anti-farming gap.
- Browser-first mirrors receive the grant when trusted creator data arrives through the webhook. This dependency on delivery remains; the DO sees the grant through its normal authoritative checkpoint refresh.
- Tests cover replay, second org, late creator proof, deletion, edge checkpoint, successful free-tier settlement/review, promotion-first spending, and card refunds excluding promotion.

## Open

- Stronger account verification and multi-account abuse controls before launch.

## Affects

[wallet-billing](../features/wallet-billing.md), [pricing](../features/pricing.md), [accounts-orgs](../features/accounts-orgs.md)
