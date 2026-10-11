# Capability routing

> Status: deferred (P2 #327/#328); design #372 retained, nothing built · Updated: 2026-10-11
> Code: none. Would touch `apps/gateway/src/pipeline.ts`, `apps/gateway/src/mcp.ts`, `packages/shared/src/openapi.ts`, `convex/quality.ts`
> Related: [agent-surface](agent-surface.md), [quality-signals](quality-signals.md), [pricing](pricing.md), [gateway](gateway.md), [publishing-specs](publishing-specs.md), [decision](../decisions/2026-10-10-p0-agent-bet.md)

Agents ask for a job ("web search", "find work email"), not a vendor. Zevium picks one of several interchangeable listings by price, measured success, and latency, falls back on transient failure, and never exceeds the caller's cost cap. Promoted to P0 on 2026-10-10, then deferred back to P2 on 2026-10-11.

## Product

Current scope: one listing routes to exactly one upstream; publisher owns multi-provider failover. The following product ideas are deferred. Keep any future ranking small and deterministic.

- Caller names a capability and optionally a max cost per call; Zevium chooses the provider.
- Price is known before the call and never exceeds the cap. Zero balance still blocks.
- Fallback only on transient failures (429, 5xx, timeout). 429 is the sole 4xx exception; other 4xx responses stop the route.
- Caller can pin a provider or exclude providers.
- Every routed call is itemized with the provider actually used; publisher of that provider earns 95% as usual.
- House listings sourced from different aggregators (permitted aggregators or direct suppliers; RapidAPI excluded) become interchangeable providers for one capability ([house supply](../decisions/2026-10-10-house-supply-via-aggregators.md)).

## Flow

Planned product flow; the proposed wire contracts are owned by the design linked under Tech:

- Consumers can call a capability or select an individual listing.
- Agents discover capabilities alongside listings and request a job with a cost cap.
- Response headers name the provider used and the cost charged.
- Catalogue: capability pages listing providers with price, success rate, p50 latency, last success (treg/OpenRouter pattern).

## Tech

[Capability routing design](../design/capability-routing.md) is the single owner of the proposed taxonomy, operation extension, normalized `web.search` schemas, mapping grammar, routing/billing algorithm, MCP contracts, edge snapshots, and implementation acceptance for [#328](https://github.com/zevium-dev/core/issues/328). Design review: [#327](https://github.com/zevium-dev/core/issues/327).

The proposal is not accepted or implemented. It recommends a mandatory cap for routed calls, narrowing the optional-cap product sketch above. Current-code gaps and rollout prerequisites are recorded in the design; existing direct gateway behavior remains unchanged by this docs-only work.

## Decisions

- 2026-10-11 — ACCEPTED: defer routing, budgets, mapping, ranking and supplier pair; #327/#328 P2. Preserve #372 design. [Decision](../decisions/2026-10-11-capability-routing-deferred.md).

- 2026-10-10 — HISTORICAL (superseded 2026-10-11): capability routing promoted P2 #22 → P0. [decision](../decisions/2026-10-10-p0-agent-bet.md)

- 2026-10-10 — DEFERRED (P2; not approved): curated capability contracts, normalized web search, bounded maps, and route-wide attempt budget. [decision](../decisions/2026-10-10-capability-taxonomy.md)

## Open questions

Deferred questions for revival are tracked once in [the design](../design/capability-routing.md#open-questions-for-the-owner): schema scope, cap semantics, mapping approach, initial suppliers, and launch ranking/timeout defaults.
