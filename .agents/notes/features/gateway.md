# Gateway (metered call path)

> Status: built; dead-layer pruning and staged call path complete (#359, #333) (P0) · Updated: 2026-10-10
> Code: `apps/gateway/src/index.ts`, `apps/gateway/src/pipeline.ts`, `apps/gateway/src/admit.ts`, `apps/gateway/src/forward.ts`, `apps/gateway/src/finalize.ts`, `apps/gateway/src/cache.ts`, `apps/gateway/src/convex-http.ts`, `apps/gateway/src/headers.ts`, `apps/gateway/src/idempotency.ts`, `apps/gateway/src/cors.ts`, `apps/gateway/src/payment-required.ts`, `apps/gateway/src/errors.ts`, `apps/gateway/src/key-verifier.ts`, `apps/gateway/src/spec-source.ts`, `apps/gateway/src/wallet.ts`, `apps/gateway/src/usage.ts`
> Related: [wallet-billing](wallet-billing.md), [api-keys](api-keys.md), [upstream-credentials](upstream-credentials.md), [pricing](pricing.md), [mock-sandbox](mock-sandbox.md), [agent-surface](agent-surface.md), [machine-payments](machine-payments.md), [listing-lifecycle](listing-lifecycle.md), [architecture](../architecture/overview.md), [decision: dual-rail keys + x402](../decisions/2026-10-10-dual-rail-keys-and-x402.md)

The gateway is the single metered call path: one URL per published API, authenticated by an API key or wallet session, credit-gated against the caller's wallet, forwarding to the publisher's upstream and streaming the response back. Human code and agent tooling both go through it, so there is no unmetered side door. It is the product's hot path and the only data-plane component.

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
- Current `/gateway` authentication and credit failures use a generic `402` actions envelope (create key, top up, docs) for the prepaid-credit flow. When the machine rail is configured, the envelope also carries x402 V2 top-up requirements. Verified payment returns a payer-bound session. (FLOW 3.4; owned by [machine-payments](machine-payments.md))

## Tech

- **Per-token pricing (#329)**: built for OpenAI-compatible JSON/SSE. Spec rates are exposed in catalogue references, editor, discovery, and MCP; admission holds an estimated maximum, an asynchronous tee observer settles actual usage, and wallet settlement releases the remainder. Missing usage charges zero. Wallet budget, whole-credit rounding, stream/parser limits, and `x-zevium-hold` are defined in the [pricing contract](../decisions/2026-10-10-llm-per-token-pricing.md#implementation-contract-329). Code: `packages/shared/src/pricing.ts`, `apps/gateway/src/token-metering.ts`, `apps/gateway/src/{admit,finalize,wallet}.ts`, `convex/wallets.ts`. Unpriced operations are hidden; explicit zero-price calls remain available to funded wallets.
- **Explicit pricing (#316)**: shared `matchOperation` rejects an unpriced match as `null` before wallet access; `admit.ts` returns the same `404 route_not_found` as an unknown route. No upstream call, charge, or usage event. Explicit zero still requires key authorization and a positive wallet balance, and charges zero.

- **MCP OAuth (#323)**: optional Clerk resource-server auth at `/mcp` resolves a trusted current-key identity before `admit`; direct gateway API-key handling and wallet code are unchanged. PR #401 rebases onto #379 with `WalletSqliteDO`, the `v4-wallet-sqlite` migration, and non-blocking control refresh preserved. Discovery, JWT/status caching, scopes, and owner activation are owned by [agent-surface](agent-surface.md#mcp-oauth-323).

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

`pipeline.ts` orchestrates three explicit stages: `admit` verifies the key, resolves the route/version, checks lifecycle/privacy/pricing, and authorizes or reserves credits; `forward` injects credentials, scopes idempotency, and fetches once with the existing timeout/abort behavior; `finalize` settles/refunds through the Wallet DO outbox and returns the response. Dependencies and admitted state are passed explicitly. Direct gateway settlement still happens on response headers. MCP passes a `prepareResponse` hook through the pipeline into `forward`, inside its fetch/error boundary: settlement waits for successful buffering, and failures refund paid holds or restore free-tier allowance in `finalize`. MCP behavior: [agent-surface](agent-surface.md). Wallet storage is unchanged.

### Implementation notes

- **Cross-org metering**: the consumer's own org wallet always pays, never the publisher's. Private projects called with a key from a foreign org 404 (`project_not_found`) rather than 401/403, so private listings never leak existence to an unauthorized caller
- **Deleted layers (#359)**: no `ControlDO` RPC or `/internal/registry/v1/*` receiver remains. Wrangler migration `v3` deletes `ControlDO`, preserving `v1`/`v2` history. Registry producers in Convex remain for separate work. Unused signed-entitlement, bootstrap, manifest, and receiver helpers were removed; web API-key projection signing and Convex-used helpers remain.
- **Usage transport**: Wallet DO settlement outbox → authenticated `/ingest-usage` is the only production write path. Discarded pipeline usage events, optional sinks, admin mutation fallback, and Worker `convex` SDK dependency are deleted. Release-challenge settlement metadata stays because release automation uses it. Wallet storage is unchanged.
- **Route caching**: one `CachedSpecSource` implementation handles private execution and credential-free public DTOs (30s TTL); catalogue uses the same bounded cache implementation (60s TTL). Parsed immutable spec bytes are reused across requests and metadata refreshes in a bounded 64-entry cache. Credential and lifecycle changes remain outside that cache. No per-call public-claims scan remains.
- **Response boundary (#333)**: one outer wrapper applies CORS/security headers and ensures `x-zevium-request-id` on every response, including discovery, MCP, preflight, fallback 404 and caught 500. Existing gateway settlement/request identity is preserved. Both spec parsing and pricing failures use `422 invalid_spec`.
- **Gateway CORS**: `/gateway`, `/mock`, `/discovery`, `/mcp` all allow wildcard origin. Safe because auth is bearer-key only, never cookie-based — a wildcard origin doesn't widen the attack surface for a bearer-token API
- **Payment-required errors**: unauthenticated, invalid-key, and insufficient-credit responses on `/gateway` return a generic `402` with machine-readable create-key, top-up, and docs actions. Configured x402 payments fund a wallet once and return a signed session; later calls use the same pipeline without payment network calls. See [machine-payments](machine-payments.md). `/mock` is keyless and free; missing projects/routes return `404`; unreadable specs or invalid pricing return `422 invalid_spec`
- **Gateway forwarding boundary**: drop fixed hop-by-hop and `Connection`-nominated fields in both directions. Requests also drop forwarded identity and reserved `x-zevium-*` metadata; upstream platform metadata cannot override gateway cost/free-tier/request-id facts. Publisher credentials inject after request filtering. Effective upstream `Idempotency-Key` becomes a stable SHA-256 digest over a versioned tuple of authenticated consumer org, project, method, concrete upstream URL (query included), and label. Rotation does not change that namespace. This partitions shared publisher accounts; it does not add gateway response replay or once-only billing. No label means no generated key.
- **Body handling** (direct gateway part): direct `/gateway` responses and ordinary per-call requests stream without application buffering. Token-priced calls read a bounded 1 MiB JSON request before admission to size the hold and request usage. Neither path persists payload bodies in application tables. (MCP part: [agent-surface](agent-surface.md).)

### Findings

- [gateway-idempotency](../findings/gateway-idempotency.md) — upstream retry-key isolation contract (`idempotency.ts`, scoped after publisher header injection).
- [header-hygiene](../findings/header-hygiene.md) — request/response filter rules; filter before stamping gateway metadata; own-property lookup for the exclusion table.

## Decisions

- 2026-07-12 — Data plane stays a thin, isolated Cloudflare Worker (future Go-port candidate). [stack decision](../decisions/2026-07-12-stack.md)
- 2026-07-11 — Consumer's own org wallet pays; foreign-org keys on private projects get `404`; wildcard CORS on public gateway surfaces (commit `32d5c17`).
- 2026-10-07 — Upstream `Idempotency-Key` scoped per consumer org/project/method/URL; forwarding identity, `Connection`-nominated and `x-zevium-*` headers stripped (commit `e968b1e`). See findings above.
- 2026-10-10 — ACCEPTED: keyless x402 wallet sessions become a second auth path beside API keys. Built behind configuration in #109. [decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md); details in [machine-payments](machine-payments.md).
- 2026-10-10 — BUILT (#316): operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Publishing remains allowed with a warning. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)
- 2026-10-10 — BUILT: operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Replaces code's default of 1 credit. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)
- 2026-10-10 — BUILT (#316): operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Publishing remains allowed with a warning. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)
- 2026-10-10 — ACCEPTED: keyless x402 wallet sessions become a second auth path beside API keys. Not built. [decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md); details in [machine-payments](machine-payments.md).
- 2026-10-10 — BUILT (#329): LLM per-token pricing — hold estimated input + `max_tokens` (or fixed cap) at spec rates, settle actual, release rest; in-flight budget + 402 reasons copied from OpenRouter. [decision](../decisions/2026-10-10-llm-per-token-pricing.md)

## Open questions

- Real machine-payment sandbox settlement remains blocked by owner setup; see [machine-payments](machine-payments.md).
- Doc/code conflict: FLOW says `429` rate/quota exceeded. `pipeline.ts` never emits `429`; disabled/untracked/cap-exceeded keys and archived orgs return `403` (`key_disabled`, `key_untracked`, `key_cap_exceeded`, `organization_archived`). Code wins.
- Doc/code conflict: "Payment-required errors" lists `/gateway` failures as `402` or generic `404`. Code also returns `503 verification_unavailable` (Clerk unreachable), `503 wallet_unavailable` (cold wallet control snapshot unavailable; warm wallets retain last-known state, [#360 storage/refresh](wallet-billing.md#wallet-storage-and-retention-360)), `410 sunset_reached`, `422 invalid_spec`/`unsafe_upstream`, `404 no_upstream`, `500 reserve_failed`/`pricing_identity_failed`.
