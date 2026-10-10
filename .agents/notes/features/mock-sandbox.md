# Mock sandbox

> Status: built (P1 #14; #363 shared synthesis) · Updated: 2026-10-10
> Code: `apps/gateway/src/mock.ts`, `packages/shared/src/mock.ts` (`generateMockResponse`), `packages/shared/src/openapi.ts` (`matchOperation`), `apps/web/src/components/catalogue-detail.tsx` (Try it panel), `apps/web/src/lib/landing.ts` (`tryItBaseUrl`), `apps/web/src/lib/catalogue-detail-search.ts`
> Related: [gateway](gateway.md), [catalogue-search](catalogue-search.md), [pricing](pricing.md), [agent-surface](agent-surface.md), [listing-lifecycle](listing-lifecycle.md)

Free, anonymous, spec-generated responses for any published API: exercise the API shape before spending credits or getting a key. Never executes the upstream, so it is the one deliberate exception to "every call is key-authenticated and credit-gated".

## Product

- **Playground**: in-docs test console. A playground call is a normal metered call — free when it costs nothing (mock mode generated from the spec, or the publisher's free tier covers it), charged like any other call when it hits a paid upstream. No special playground billing
- P1 #14 — Mock/sandbox mode: free spec-generated mock endpoints — try the API shape before spending credits. [roadmap](../product/roadmap.md)
- Carve-out rule (`AGENTS.md` product rules), verbatim:

  > No unmetered execution paths — every gateway/agent call is key-authenticated and credit-gated. **Stated carve-out**: `/mock/:org/:project/*` is deliberately keyless and anonymous — it never executes the upstream, only synthesizes a response from the published spec's schema at 0 credits, so the metering rule doesn't apply to it by design

## Flow

### API detail page — `/catalogue/{org}/{api}` (public)

- **Try it** panel: one-click use-my-key (or paste key), run request in-page, live response. Key held in browser session storage only; test mode visually loud
- **Mock mode**: free, anonymous spec-generated responses — exercise the API shape without spending credits or executing the upstream
- Consumer golden path: Catalogue → API detail → Try it (mock mode or free tier) → create key → top up → first real call.

### Machine surface — `/mock/{org}/{project}/{path}`

- Keyless `/mock` has no authentication or payment failure path; missing, unsafe, or unreadable projects/specs/routes return generic `404` responses (FLOW 3.4)

## Tech

- **Shared examples (#363)**: `packages/shared/src/mock.ts` exports bounded `synthesize` for gateway mocks, reference responses, and playground request bodies. Explicit examples/defaults and local component refs share one implementation; boolean/date/depth behavior no longer drifts in `lib/try-it.ts`. Realtime quality refreshes preserve playground inputs/results; selecting another operation resets its defaults. CopyButton keeps curl authorization as a placeholder.
- **Unpriced routes (#316)**: shared `matchOperation` returns no match for a missing `x-zevium-cost`; `/mock` returns its usual `404 route_not_found`. Explicit zero and positive-priced operations remain available as zero-credit, keyless mocks.

- **Payment-required errors** (mock part): `/mock` is keyless and free; project, spec, and route failures return generic `404` responses
- **Gateway CORS**: `/gateway`, `/mock`, `/discovery`, `/mcp` all allow wildcard origin. Safe because auth is bearer-key only, never cookie-based — a wildcard origin doesn't widen the attack surface for a bearer-token API

Code facts (`mock.ts`): resolves the public published spec, applies `isPublishedSpecPublicCopyAllowed`, matches method + path, returns `generateMockResponse` output with `x-zevium-mock: 1`, `x-zevium-cost: 0`, `x-zevium-request-id`. No key verifier, no wallet, no usage event. Try-it panel defaults to `mode: "mock"`; `tryItBaseUrl` switches `/mock` ↔ `/gateway`.

## Decisions

- 2026-07-11 — Mock went keyless and anonymous at 0 credits (commit `32d5c17`, "keyless mock"). Supersedes the build-plan wave 9b row that says "key-authed".
- 2026-10-10 — BUILT (#316): operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Publishing remains allowed with a warning. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)

## Open questions

- Doc/code conflict: "generic `404`" for every failure. `mock.ts` also returns `410 sunset_reached` (with `Deprecation`/`Sunset`/`Link` headers) for retired/sunset APIs and `422 invalid_spec` when pricing is invalid. Code wins.
- Stale doc: [history/build-plan.md](../history/build-plan.md) wave 9b row (frozen archive) says mock is "key-authed"; code and `AGENTS.md` say keyless.
- Backlog: production acceptance journey must also verify keyless mock against the same listing as a paid call ([roadmap](../product/roadmap.md)).
- Research idea, NOT a decision: claimable spec listings — ingest public OpenAPI specs as unclaimed, mock-only listings served through the keyless `/mock` carve-out; owner claims, sets `x-zevium-cost`, earns 95%. ToS legality unverified. Source: [research](../research/agent-api-marketplace-landscape.md) ("Supply").
