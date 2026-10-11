# Estimated checkout card fee and full paid-amount refunds

> Date: 2026-10-11 · Status: accepted direction; implementation pending · Decided by: owner
> Session: [owner decisions](../sessions/2026-10-11-owner-decisions.md)

## Decision

Show the customer an estimated card-processing fee at checkout, separate from purchased credits. Zevium absorbs the difference between that estimate and the actual Stripe fee. **No post-payment true-up.** Credit only the purchased principal; the fee buys no credits.

Refunds return exactly what the customer paid, **card-fee component included**. Zevium absorbs the fee Stripe keeps. For a full refund of $10 principal plus the displayed fee, return that entire original total. Partial-refund fee allocation must conserve the same cumulative total; its precise allocation rule remains implementation work.

Supersedes exact-cost/gross-up and unresolved-refund language in [card-fee passthrough](2026-10-10-card-fee-passthrough.md). Publisher/platform call split remains 95/5.

## Delivery and gate

P0 #318 owns implementation and the legal check. **Card surcharge launch remains gated on legal review in #318.** This decision does not approve a surcharge in any jurisdiction or payment method. Rebuild #353 / PR #394 should preserve principal, quoted fee and actual processor cost separately without a later customer debit. No payment settings or code change here.

## Affects

[Wallet billing](../features/wallet-billing.md), [pricing](../features/pricing.md).
