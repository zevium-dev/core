# Publisher OpenAPI is the contract for every surface

> Date: 2026-10-11 · Status: accepted direction; implementation pending · Decided by: owner
> Session: [owner decisions](../sessions/2026-10-11-owner-decisions.md)

## Decision

The publisher's immutable published **OpenAPI spec IS the contract**. An automated converter generates every consumer surface from it, including MCP tools, CLI and docs. There is no separate hand-maintained contract per surface. For official/house listings, Zevium writes the OpenAPI specs as publisher.

The “Try it” playground must become a real form generated from spec parameters and request schemas, replacing raw-text-only input. Preserve parameter location, types, required fields, defaults/examples and validation; unsupported shapes must be explicit. Paid execution still uses the normal authenticated credit gate; free mocks remain spec-only synthesis.

This does not approve capability normalization or cross-provider mapping. One listing routes to one upstream under the [routing deferral](2026-10-11-capability-routing-deferred.md).

## Delivery

- P0 #428: shared spec converter plus CLI/docs, supporting agent distribution.
- Existing P1 #110 already covers listing-scoped MCP tool/schema generation; link its work, do not duplicate it.
- P1 #427: generated Try it form.
- Existing P2 #350 remains the generated SDK follow-up; it does not cover the missing shared CLI/docs pipeline.

Existing issues were checked before #428 was created. Current partial generation is not evidence that all surfaces already share a converter.

## Affects

[Publishing](../features/publishing-specs.md), [agent surface](../features/agent-surface.md), [mock sandbox/playground](../features/mock-sandbox.md), [landing/docs](../features/landing-docs.md).
