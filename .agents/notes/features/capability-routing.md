# Capability routing

> Status: planned (P0 since 2026-10-10) — nothing built · Updated: 2026-10-10
> Code: none. Would touch `apps/gateway/src/pipeline.ts`, `apps/gateway/src/mcp.ts`, `packages/shared/src/openapi.ts`, `convex/quality.ts`
> Related: [agent-surface](agent-surface.md), [quality-signals](quality-signals.md), [pricing](pricing.md), [gateway](gateway.md), [publishing-specs](publishing-specs.md), [decision](../decisions/2026-10-10-p0-agent-bet.md)

Agents ask for a job ("web search", "find work email"), not a vendor. Zevium picks one of several interchangeable listings by price, measured success, and latency, falls back on transient failure, and never exceeds the caller's cost cap. Was P2 #22 "provider fallback routing"; promoted to P0 on 2026-10-10.

## Product

- Caller names a capability and optionally a max cost per call; Zevium chooses the provider.
- Price is known before the call and never exceeds the cap. Zero balance still blocks.
- Fallback only on transient failures (429, 5xx, timeout). Never retry a 4xx elsewhere — the request itself is wrong.
- Caller can pin a provider or exclude providers.
- Every routed call is itemized with the provider actually used; publisher of that provider earns 95% as usual.
- House listings sourced from different aggregators (treg, RapidAPI, direct) become interchangeable providers for one capability ([house supply](../decisions/2026-10-10-house-supply-via-aggregators.md)).

## Flow

Planned, not designed in detail:

- Gateway: a capability route (shape TBD, e.g. `/c/{capability}/…`) beside `/gateway/{org}/{project}/…`.
- MCP: `search_apis` returns capabilities as well as listings; `call_api` accepts a capability + max cost.
- Response headers name the provider used and the cost charged.
- Catalogue: capability pages listing providers with price, success rate, p50 latency, last success (treg/OpenRouter pattern).

## Tech

Design inputs only (from research, not decided):

- Publishers tag operations with a capability in the spec (e.g. `x-zevium-capability: email.find`). Spec stays source of truth — no parallel routing table.
- Interchangeable providers need a normalized request/response schema per capability; raw OpenAPI shapes differ. This is the hard part.
- Selection signals come from [quality-signals](quality-signals.md) (gateway-measured success/latency) and [pricing](pricing.md).
- OpenRouter reference: skip providers with an outage in the last 30s; weight cheap providers by inverse square of price; fallback on by default; `max_price` cap ([routers notes](../research/agent-api-marketplace-landscape/routers_and_agent_data_apis.md)).
- treg reference: `treg.<capability>` routed tools choose provider, fall back on errors/misses, stay within cost cap ([treg comparison](../research/treg-comparison.md)).
- Hot-path rule: selection must run from edge-cached data, no Convex call per request.

## Decisions

- 2026-10-10 — ACCEPTED: capability routing promoted P2 #22 → P0. [decision](../decisions/2026-10-10-p0-agent-bet.md)

## Open questions

- Capability taxonomy: who defines capabilities and their normalized schemas (Zevium-curated list vs publisher-declared)?
- Retry billing: a failed first provider is refunded (existing non-2xx refund); confirm total cost cap covers all attempts.
- Idempotency across providers for non-idempotent operations — restrict routing to safe/idempotent capabilities first?
- Which first capability: web search / scraping are the most substitutable (research recommendation).
