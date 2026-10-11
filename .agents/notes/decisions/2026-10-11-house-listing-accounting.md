# House listings use ordinary publisher accounting

> Date: 2026-10-11 · Status: accepted direction; implementation pending · Decided by: owner
> Session: [owner decisions](../sessions/2026-10-11-owner-decisions.md)

## Decision

Zevium is an ordinary publisher organization. House listings use the same **95% publisher / 5% platform ledger** as every other publisher. Zevium writes their OpenAPI specs and bears upstream costs. No separate house earnings ledger or special split.

A **$100/month total subsidy cap across all house listings** is optional, only if simple to build. Otherwise skip it; owner accepts losses. It is not a launch gate. P2 #429 owns that optional follow-up; #314 retains ordinary house-listing delivery.

The [2026-10-10 resale research](../research/house-listing-resale-terms.md) found RapidAPI standard terms prohibit resale. **RapidAPI cannot be a house-listing source.** #313 still owns rights checks for other sources and each underlying upstream. This decision clears no supplier's resale rights.

Supersedes the RapidAPI sourcing fallback, mandatory monthly cap and unresolved internal split in [2026-10-10 house supply](2026-10-10-house-supply-via-aggregators.md). The “Operated by Zevium” label remains. Capability routing stays deferred.

## Affects

[Publishing](../features/publishing-specs.md), [earnings and payouts](../features/earnings-payouts.md), [product overview](../product/overview.md).
