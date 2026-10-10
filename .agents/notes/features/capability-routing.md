# Capability routing

> Status: planned (P0 since 2026-10-10) — design proposed in #327; nothing built · Updated: 2026-10-10
> Code: none. Would touch `apps/gateway/src/pipeline.ts`, `apps/gateway/src/mcp.ts`, `packages/shared/src/openapi.ts`, `convex/quality.ts`
> Related: [agent-surface](agent-surface.md), [quality-signals](quality-signals.md), [pricing](pricing.md), [gateway](gateway.md), [publishing-specs](publishing-specs.md), [decision](../decisions/2026-10-10-p0-agent-bet.md)

Agents ask for a job ("web search", "find work email"), not a vendor. Zevium picks one of several interchangeable listings by price, measured success, and latency, falls back on transient failure, and never exceeds the caller's cost cap. Was P2 #22 "provider fallback routing"; promoted to P0 on 2026-10-10.

## Product

- Caller names a capability and optionally a max cost per call; Zevium chooses the provider.
- Price is known before the call and never exceeds the cap. Zero balance still blocks.
- Fallback only on transient failures (429, 5xx, timeout). 429 is the sole 4xx exception; other 4xx responses stop the route.
- Caller can pin a provider or exclude providers.
- Every routed call is itemized with the provider actually used; publisher of that provider earns 95% as usual.
- House listings sourced from different aggregators (treg, RapidAPI, direct) become interchangeable providers for one capability ([house supply](../decisions/2026-10-10-house-supply-via-aggregators.md)).

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

- 2026-10-10 — ACCEPTED: capability routing promoted P2 #22 → P0. [decision](../decisions/2026-10-10-p0-agent-bet.md)

- 2026-10-10 — PROPOSED (awaiting user): curated capability contracts, normalized web search, bounded maps, and route-wide attempt budget. [decision](../decisions/2026-10-10-capability-taxonomy.md)

## Open questions

Owner approval questions and recommendations are tracked once in [the design](../design/capability-routing.md#open-questions-for-the-owner): schema scope, cap semantics, mapping approach, initial suppliers, and launch ranking/timeout defaults.
