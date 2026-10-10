# Gateway (metered call path)

> Status: built (P0) · Updated: 2026-10-10
> Code: `apps/gateway/src/index.ts`, `apps/gateway/src/pipeline.ts`, `apps/gateway/src/headers.ts`, `apps/gateway/src/idempotency.ts`, `apps/gateway/src/cors.ts`, `apps/gateway/src/payment-required.ts`, `apps/gateway/src/errors.ts`, `apps/gateway/src/key-verifier.ts`, `apps/gateway/src/spec-source.ts`, `apps/gateway/src/wallet.ts`, `apps/gateway/src/usage.ts`
> Related: [wallet-billing](wallet-billing.md), [api-keys](api-keys.md), [upstream-credentials](upstream-credentials.md), [pricing](pricing.md), [mock-sandbox](mock-sandbox.md), [agent-surface](agent-surface.md), [machine-payments](machine-payments.md), [listing-lifecycle](listing-lifecycle.md), [architecture](../architecture/overview.md), [decision: dual-rail keys + x402](../decisions/2026-10-10-dual-rail-keys-and-x402.md)

The gateway is the single metered call path: one URL per published API, key-authenticated, credit-gated against the caller's org wallet, forwarding to the publisher's upstream and streaming the response back. Human code and agent tooling both go through it, so there is no unmetered side door. It is the product's hot path and the only data-plane component.

## Product

**What happens on a call.** A consumer (human code or agent) calls a Zevium gateway URL for a published API. Zevium:

1. Identifies the API and the exact endpoint being called, and its price
2. Authenticates the caller's API key and resolves their org wallet
3. Checks the wallet covers the price — insufficient balance means the call is refused up front
4. Reserves the credits, forwards the request to the publisher's upstream (attaching the publisher's upstream credentials on their behalf), and streams the response back
5. On success: the charge settles — 95% to the publisher, 5% to the platform. On upstream failure: the reservation is refunded, the consumer pays nothing

Consumers see: one gateway URL per API, one key, one wallet, itemized charges. Publishers see: calls, revenue, and performance per endpoint — without running any billing infrastructure.

**Rules (never break):**

- **Zero balance blocks the call.** Never a surprise overage.
- No unmetered execution paths — every gateway/agent call is key-authenticated and credit-gated. Sole carve-out: keyless `/mock` (see [mock-sandbox](mock-sandbox.md)). Source: `AGENTS.md` product rules.

**Roadmap** ([roadmap](../product/roadmap.md)):

- P0 #1 — Core loop: publish → public catalogue listing → key issuance → paid metered call
- P0 #2 — All agent tooling routes through metering — no unmetered side doors

## Flow

### Gateway — `/gateway/{org}/{api}/…` (machine surface, no screens)

- The metered call path (behavior spec: Product "What happens on a call" above)
- Error semantics: `402` insufficient balance, `429` rate/quota exceeded, request-id header on every response
- Deprecation signaling on responses for sunsetting APIs (P1) — see [listing-lifecycle](listing-lifecycle.md)
- Current `/gateway` authentication and credit failures use a generic `402` actions envelope (create key, top up, docs) for the prepaid-credit flow. That envelope contains no x402 payment requirements and cannot authorize or settle a payment. (FLOW 3.4; owned by [machine-payments](machine-payments.md))

## Tech

Worker rules (hot-path budget, streaming, async metering, dependency-light): [`AGENTS.md` → Gateway (Worker) rules](../../../AGENTS.md#gateway-worker-rules). Not copied here.

### Why the proxy stays a Cloudflare Worker

- Worker placement keeps request streaming and credit authorization out of the control-plane request path
- Workers support native streaming passthrough (`fetch` → `Response` body pipe)
- Isolated data plane = the future Go-port candidate, if ever needed

Control/data-plane split and full diagram: [architecture overview](../architecture/overview.md).

### Call pipeline (architecture diagram steps 1–6)

Worker serves `/gateway/{org}/{project}/*` + `/mcp`; each call runs:

1. verify API key (edge-cached) — [api-keys](api-keys.md)
2. credit gate (Durable Object wallet) — [wallet-billing](wallet-billing.md)
3. inject publisher upstream secrets — [upstream-credentials](upstream-credentials.md)
4. stream upstream response
5. emit usage event → Convex (async) — [wallet-billing](wallet-billing.md)
6. non-2xx → refund reservation

Code order (`pipeline.ts` header): verify key → load spec → match op → free-tier or reserve → proxy → settle/refund → usage.

### Implementation notes

- **Cross-org metering**: the consumer's own org wallet always pays, never the publisher's. Private projects called with a key from a foreign org 404 (`project_not_found`) rather than 401/403, so private listings never leak existence to an unauthorized caller
- **Entitlement boundary**: execution admission returns a signed proof bound to reservation id, consumer org, project, route revision, and immutable policy revision. Settlement consumes that proof without re-reading mutable admission policy, so a call admitted under an open revision cannot be denied after upstream execution.
- **Gateway CORS**: `/gateway`, `/mock`, `/discovery`, `/mcp` all allow wildcard origin. Safe because auth is bearer-key only, never cookie-based — a wildcard origin doesn't widen the attack surface for a bearer-token API
- **Payment-required errors**: unauthenticated, invalid-key, and insufficient-credit responses on `/gateway` return a generic `402` with machine-readable create-key, top-up, and docs actions. This is prepaid-credit recovery metadata, not x402: no payment requirements, signed-payment verification, facilitator, or settlement exists in this tree. `/mock` is keyless and free; project, spec, and route failures return generic `404` responses
- **Gateway forwarding boundary**: drop fixed hop-by-hop and `Connection`-nominated fields in both directions. Requests also drop forwarded identity and reserved `x-zevium-*` metadata; upstream platform metadata cannot override gateway cost/free-tier/request-id facts. Publisher credentials inject after request filtering. Effective upstream `Idempotency-Key` becomes a stable SHA-256 digest over a versioned tuple of authenticated consumer org, project, method, concrete upstream URL (query included), and label. Rotation does not change that namespace. This partitions shared publisher accounts; it does not add gateway response replay or once-only billing. No label means no generated key.
- **Body handling** (direct gateway part): direct `/gateway` requests and responses stream without application buffering. Neither path persists payload bodies in application tables. (MCP part: [agent-surface](agent-surface.md).)

### Findings

- [gateway-idempotency](../findings/gateway-idempotency.md) — upstream retry-key isolation contract (`idempotency.ts`, scoped after publisher header injection).
- [header-hygiene](../findings/header-hygiene.md) — request/response filter rules; filter before stamping gateway metadata; own-property lookup for the exclusion table.

## Decisions

- 2026-07-12 — Data plane stays a thin, isolated Cloudflare Worker (future Go-port candidate). [stack decision](../decisions/2026-07-12-stack.md)
- 2026-07-11 — Consumer's own org wallet pays; foreign-org keys on private projects get `404`; wildcard CORS on public gateway surfaces (commit `32d5c17`).
- 2026-10-07 — Upstream `Idempotency-Key` scoped per consumer org/project/method/URL; forwarding identity, `Connection`-nominated and `x-zevium-*` headers stripped (commit `e968b1e`). See findings above.
- 2026-10-10 — ACCEPTED: keyless x402 wallet sessions become a second auth path beside API keys. Not built. [decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md); details in [machine-payments](machine-payments.md).
- 2026-10-10 — ACCEPTED (not built): operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Replaces code's default of 1 credit. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)
- 2026-10-10 — ACCEPTED (not built): LLM per-token pricing — hold estimated input + `max_tokens` (or fixed cap) at spec rates, settle actual, release rest; in-flight budget + 402 reasons copied from OpenRouter. [decision](../decisions/2026-10-10-llm-per-token-pricing.md)

## Open questions

- No-unmetered rule says "key-authenticated". After the 2026-10-10 dual-rail decision the rule wording must count a signed x402 wallet session as the credential (collision flagged in [research](../research/agent-api-marketplace-landscape.md)).
- Doc/code conflict: FLOW says `429` rate/quota exceeded. `pipeline.ts` never emits `429`; disabled/untracked/cap-exceeded keys and archived orgs return `403` (`key_disabled`, `key_untracked`, `key_cap_exceeded`, `organization_archived`). Code wins.
- Doc/code conflict: FLOW says request-id header on every response. Pipeline/mock responses carry `x-zevium-request-id`; the Worker's fallback `404 {"error":"not found"}` and `500 {"error":"internal error"}` in `index.ts` do not.
- Doc/code conflict: "Payment-required errors" lists `/gateway` failures as `402` or generic `404`. Code also returns `503 verification_unavailable` (Clerk unreachable), `410 sunset_reached`, `422 invalid_spec`/`unsafe_upstream`, `404 no_upstream`, `500 reserve_failed`/`pricing_identity_failed`.
- Doc/code conflict: "Entitlement boundary" signed proof. `signEntitlementAdmission`/`verifyEntitlementAdmission` exist only in `packages/shared/src/registry-sync.ts` (+ tests); no caller in `apps/gateway` or `convex`. Settlement in `convex/wallets.ts` re-reads `projectConsumerEntitlements` and deprecation state and can reject with "consumer became eligible after retirement freeze". Treat the bullet as target, not current behavior.
