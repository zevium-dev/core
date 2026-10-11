# Edge spend authority and bounded funding lots

> Date: 2026-10-11 · Status: accepted direction; implementation pending · Decided by: owner
> Session: [owner decisions](../sessions/2026-10-11-owner-decisions.md)

## Decision

Wallet Durable Object remains the spend authority; Convex retains the durable ledger. Accept 30-second executable snapshot authority and freeze/drain before negative wallet adjustments. Fixed-price calls cannot create consumer debt. No global revoke control path is added. A lost or unreachable DO may delay refunds and close that wallet until reconciliation; this availability cost is accepted.

One call draws from at most **32 funding lots/slices**. No resumable allocator. Fragmented funding that cannot fit must fail before upstream execution.

Add dust merging: when a lot's remaining balance is below a threshold, move its remainder into the newest eligible lot with identical expiry rules. **$0.10 = 1,000 credits is the proposed threshold**, not a final constant. Org lots never expire. For expiring lots, identical rules include the same expiry boundary; sharing a one-year duration with different expiry dates is insufficient. Never extend anonymous money's life through merging.

Record an idempotent ledger move `(lot A -> lot B, amount)`. Preserve original payment provenance through repeated moves and later spending so refunds/chargebacks can still follow their source money. Preserve refundable/non-refundable source restrictions. If no compatible destination exists, leave the lot intact. Outstanding reservations and concurrent merges must conserve inventory; a 32-slice admission bound must not conceal unbounded provenance work.

## Delivery and limits

P0 #430 is part of rebuild #353 / [plan PR #394](https://github.com/zevium-dev/core/pull/394), especially wallet lots/settlement and edge snapshot work. The plan lives on `t3/convex-rebuild-plan`; this decision answers its authority and allocator questions without importing or implementing that branch.

Current machine-payment code caps funding slices at 24 and does not compact expiring lots. The accepted 32-slice/dust/freeze-drain design is pending rebuild work, not a claim about deployed behavior. Test source conservation, moves after refund/dispute, replay, expiry, and concurrent admission before cutover.

## Affects

[Wallet billing](../features/wallet-billing.md), [gateway](../features/gateway.md), [machine payments](../features/machine-payments.md).
