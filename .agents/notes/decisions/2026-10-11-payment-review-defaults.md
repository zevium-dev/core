# PR 4 payment review defaults

Status: proposed — implemented parent defaults, pending owner sign-off.
Date: 2026-10-11.
Scope: isolated Convex rebuild PR #439; production behavior unchanged.

- A: Across publishers, claw back pending earning buckets newest-first, then released buckets newest-first. Original payment remains the boundary. This avoids creating publisher debt while newer held earnings remain available for recovery.
- B: A payment reconciliation in `needs_review` keeps the whole consumer wallet frozen. PR 6 owns operator case UI. P1 [#440](https://github.com/zevium-dev/core/issues/440) tracks quarantining only affected original sources and reopening unrelated funds without consumer debt or synthetic credits.
- C: Accept the residual window where released earnings for a refunded payment can transfer out before clawback applies. The seven-day hold covers most exposure; an already-paid publisher clawback can make available balance negative.

These defaults were explicitly authorized for this implementation by the parent task. They do not claim final owner approval or change the accepted 95/5, seven-day hold, full-paid-amount refund, fee-variance, or nonrefundable-promo policies.

Implementation and regression evidence: [rebuild plan](../architecture/convex-rebuild.md#pr-4-implementation-and-handoff--2026-10-11), [wallet](../features/wallet-billing.md), [publisher](../features/earnings-payouts.md).
