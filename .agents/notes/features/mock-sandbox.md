# Mock sandbox

> Status: root cutover implemented; owner activation pending · Updated: 2026-10-11
> Code: `apps/gateway/src/mock.ts`, `apps/gateway/src/next/pipeline.ts`, `apps/web/src/components/catalogue-detail.tsx`, `apps/gateway/test/mock.test.ts`
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

Keyless mocks read credential-free public signed route projections, synthesize from priced-operation response schemas and charge zero without contacting upstream or wallet admission. Private, retired, malformed, token and unpriced operations fail closed. The browser playground uses the paired gateway origin. Generated-form improvements remain separate backlog.

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

## Decisions

- 2026-10-11 — ACCEPTED: Real form generated from spec parameters/request schemas; P1 #427, shared generation #428. [Decision](../decisions/2026-10-11-openapi-as-contract.md).

- 2026-07-11 — Mock went keyless and anonymous at 0 credits (commit `32d5c17`, "keyless mock"). Supersedes the build-plan wave 9b row that says "key-authed".
- 2026-10-10 — BUILT (#316): operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Publishing remains allowed with a warning. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)

## Open questions

- Doc/code conflict: "generic `404`" for every failure. `mock.ts` also returns `410 sunset_reached` (with `Deprecation`/`Sunset`/`Link` headers) for retired/sunset APIs and `422 invalid_spec` when pricing is invalid. Code wins.
- Stale doc: [history/build-plan.md](../history/build-plan.md) wave 9b row (frozen archive) says mock is "key-authed"; code and `AGENTS.md` say keyless.
- Backlog: production acceptance journey must also verify keyless mock against the same listing as a paid call ([roadmap](../product/roadmap.md)).
- Research idea, NOT a decision: claimable spec listings — ingest public OpenAPI specs as unclaimed, mock-only listings served through the keyless `/mock` carve-out; owner claims, sets `x-zevium-cost`, earns 95%. ToS legality unverified. Source: [research](../research/agent-api-marketplace-landscape.md) ("Supply").
