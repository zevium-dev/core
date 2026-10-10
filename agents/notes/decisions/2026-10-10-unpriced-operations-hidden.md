# Unpriced operations are not visible and not callable

> Date: 2026-10-10 · Status: accepted, not built (code still defaults to 1 credit) · Decided by: user
> Session: [2026-10-10](../sessions/2026-10-10-competitive-research-and-docs.md)

## Decision

- An operation without `x-zevium-cost` is **not listed and not callable**.
- Free only when the publisher explicitly sets `x-zevium-cost: 0`.
- Never infer a price. Replaces current code behavior: gateway charges a default 1 credit when the extension is missing.

## Consequences

- Gateway: unpriced operation → not routable (generic not-found class, same as unknown route).
- Catalogue, discovery, MCP `get_api_docs`, mock: omit unpriced operations.
- Spec editor: pricing lint becomes a publish-blocking issue, or publish succeeds with those operations hidden — pick in implementation; visibility rule holds either way.
- Spec stays source of truth; no parallel table.

## Affects

[pricing](../features/pricing.md), [gateway](../features/gateway.md), [publishing-specs](../features/publishing-specs.md), [catalogue-search](../features/catalogue-search.md), [agent-surface](../features/agent-surface.md), [mock-sandbox](../features/mock-sandbox.md)
