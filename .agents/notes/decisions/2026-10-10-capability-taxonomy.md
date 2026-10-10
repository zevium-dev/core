# Curated capability taxonomy and normalized web search

> Date: 2026-10-10 · Status: proposed (awaiting user)
> Design issue: [#327](https://github.com/zevium-dev/core/issues/327) · Implementation: [#328](https://github.com/zevium-dev/core/issues/328)

## Recommendation

Use a Zevium-curated repo registry of exact-version capability contracts, starting with `web.search@1.0.0`. Publishers opt operations in through an immutable OpenAPI extension containing capability identity and bounded declarative request/response maps. The published spec remains the only source of provider membership and price; unpriced operations cannot route.

Start with a first-page search contract and safe read-only operations. Require a caller cap across the sum of listed attempt prices, even when a failed attempt is refunded. Rank conforming providers using price and measured operation quality; permit at most two sequential attempts, falling back only on native 429/5xx/timeout. Validate normalized results before settling, refund failures, and charge the successful provider's price with the existing 95/5 split.

Serve selection, credentials, admission, and schemas from signed edge projections; no synchronous Convex or Clerk fallback. Extend the existing MCP search/docs/call flow. Publisher-hosted adapters can supply shapes that the small mapping grammar cannot express.

## Rationale and contract owner

A curated schema gives a capability one meaning across providers. Declarative projections keep simple integrations portable to a future Go gateway; a bounded first-page contract avoids incompatible pagination and supplier-specific features.

The [design](../design/capability-routing.md) owns all exact shapes, proposed limits, tradeoffs, code gaps, and the smallest implementation slice. This stub records a recommendation, not owner approval; merging the docs does not accept the policy or close #327 automatically.

## Awaiting owner

Approve contract governance and schema scope, mandatory cap and gross-attempt semantics, mapping approach, initial supplier pair with sourcing permission, and launch score/freshness/deadline defaults. See the [owner questions](../design/capability-routing.md#open-questions-for-the-owner).

## Affects

[capability-routing](../features/capability-routing.md), [gateway](../features/gateway.md), [pricing](../features/pricing.md), [quality-signals](../features/quality-signals.md), [publishing-specs](../features/publishing-specs.md), [agent-surface](../features/agent-surface.md)
