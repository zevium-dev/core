# Defer capability routing; keep one upstream per listing

> Date: 2026-10-11 · Status: accepted; deferral effective, enforcement tracked separately · Decided by: owner
> Session: [owner decisions](../sessions/2026-10-11-owner-decisions.md)

## Decision

Capability routing remains important future work, but provider selection, budgets, normalized mapping, ranking and initial supplier pair are all **deferred to P2/later**. #327 and #328 leave P0. Keep any ranking small and deterministic when this work resumes; no score weights or proposed supplier pair are approved.

For now, one listing routes to exactly one upstream. Multi-provider failover is the publisher's own concern. The publisher's OpenAPI remains the contract; generated surfaces are covered by [their own decision](2026-10-11-openapi-as-contract.md).

Preserve [design PR #372](https://github.com/zevium-dev/core/pull/372) and [capability-routing design](../design/capability-routing.md) as the future reference. Mark the [taxonomy stub](2026-10-10-capability-taxonomy.md) deferred; merging its design never approved its limits or governance.

## Priority

Supersedes the capability-routing portion of [2026-10-10 P0 agent bet](2026-10-10-p0-agent-bet.md). **Agent distribution remains P0.** x402 leaves P0 under its [separate decision](2026-10-11-x402-disabled.md).

## Affects

[Capability routing](../features/capability-routing.md), [gateway](../features/gateway.md), [agent surface](../features/agent-surface.md), [roadmap](../product/roadmap.md).
