# PR 4 payment review defaults

Status: proposed — implemented parent defaults, pending owner sign-off.
Date: 2026-10-11.
Scope: Convex rebuild PR #439 and scoped review follow-up #440; no deployment or production activation authorized.

- A: Across publishers, claw back pending earning buckets newest-first, then released buckets newest-first. Original payment remains the boundary. This avoids creating publisher debt while newer held earnings remain available for recovery.
- B: A payment reconciliation in `needs_review` freezes only that payment, not the wallet. The wallet is drained once, the payment's original funding sources are locked (including balances that dust merges moved into shared lots), and the wallet reopens. Other paid, admin and promotional credits stay spendable. Locks create no ledger debit, consumer debt or synthetic credit, and dust merges never move locked balances. Partial reversals and the operator case remain. Operator retry, or new provider facts, run a fresh freeze/drain generation that restores and reapplies canonical adjustments; sources unlock only when that generation completes. An unreachable or lost DO still keeps the wallet closed until a real drain is recovered. This replaces the earlier whole-wallet freeze ([#440](https://github.com/zevium-dev/core/issues/440)); owner sign-off is still required before activation.
- C: Accept the residual window where released earnings for a refunded payment can transfer out before clawback applies. The seven-day hold covers most exposure; an already-paid publisher clawback can make available balance negative.

These defaults were explicitly authorized for this implementation by the parent task. They do not claim final owner approval or change the accepted 95/5, seven-day hold, full-paid-amount refund, fee-variance, or nonrefundable-promo policies.

Implementation and regression evidence: [rebuild plan](../architecture/convex-rebuild.md#pr-4-implementation-and-handoff--2026-10-11), [wallet](../features/wallet-billing.md), [publisher](../features/earnings-payouts.md).
