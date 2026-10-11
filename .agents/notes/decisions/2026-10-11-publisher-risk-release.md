# Accept daily publisher risk-release buckets

> Date: 2026-10-11 · Status: accepted direction; implementation pending · Decided by: owner
> Session: [owner decisions](../sessions/2026-10-11-owner-decisions.md)

## Decision

Publisher earnings may release in daily buckets after the seven-day risk hold. Accept up to approximately **24 additional hours** before availability. Do not promise availability exactly seven days after each call, and never release before the hold has elapsed.

## Delivery

Part of P0 rebuild #353 / plan PR #394. Use source-aware earning buckets and preserve 95/5 conservation, reversals and isolated retry behavior. This approves the plan's release timing, not a new payout schedule or a completed implementation. No separate issue duplicates rebuild scope.

## Affects

[Earnings and payouts](../features/earnings-payouts.md).
