# Gateway (metered call path)

> Status: root cutover implemented; owner activation pending · Updated: 2026-10-11
> Code: `apps/gateway/src/{index,pipeline,forward}.ts`, `apps/gateway/src/next/`, `packages/shared/src/edge/`, `convex/{edgeSnapshots,edgeMaintenance,http,wallets}.ts`, `apps/gateway/scripts/next-acceptance.mjs`
> Related: [wallet-billing](wallet-billing.md), [api-keys](api-keys.md), [upstream-credentials](upstream-credentials.md), [pricing](pricing.md), [mock-sandbox](mock-sandbox.md), [agent-surface](agent-surface.md), [machine-payments](machine-payments.md), [listing-lifecycle](listing-lifecycle.md), [architecture](../architecture/overview.md), [decision: dual-rail keys + x402](../decisions/2026-10-10-dual-rail-keys-and-x402.md)

The gateway is the single metered call path: one URL per published API, authenticated by an API key (or verified MCP OAuth for agent calls), credit-gated against the caller's wallet, forwarding to the publisher's upstream and streaming the response back. Human code and agent tooling both go through it, so there is no unmetered side door. It is the product's hot path and the only data-plane component.

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
- Error semantics: `402` insufficient balance, `402` monthly spending cap exceeded, `429` request rate exceeded with `Retry-After`, request-id header on every response
- Deprecation signaling on responses for sunsetting APIs (P1) — see [listing-lifecycle](listing-lifecycle.md)
- Current `/gateway` authentication and credit failures use a generic `402` actions envelope (create key, top up, docs) for the prepaid-credit flow. Machine payment offers and wallet sessions are unavailable; revival requires a new implementation and owner approval. (FLOW 3.4; owned by [machine-payments](machine-payments.md))

## Tech

Admission and settlement contracts require `admissionKeyId`; missing IDs fail validation as non-retryable before any ledger write. The 402 recovery map and CORS exposed headers no longer advertise x402. Code: `packages/shared/src/edge/settlement.ts`, `apps/gateway/src/{payment-required,cors}.ts`; regression coverage in `tests/{contracts,money}.test.ts`.

Only the reviewed signed v2 authority path executes. Cold scopes use bounded single-flight coordinator fills; warm execution uses local 30-second authority. SQLite wallet admission reserves at most 32 original sources before upstream, preserves holds through checkpoint renewal, and emits contiguous signed finals/ACKs asynchronously. Refunds, archive, admin decreases and dust require durable freeze/drain. MCP buffers at most 1 MiB before finalization; HTTP streams directly. x402/token execution and legacy grant/sync routes are deleted. v6-control-plane-cutover deletes WalletSqliteDO storage; owner must drain/export/reconcile before deployment. NextWalletDO and its v5 namespace remain unchanged.

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

## Decisions

- 2026-10-11 — ACCEPTED and built in PR #441: bounded synchronous single-flight cold fills; 1s issuance-only clock skew. Negative results do not retain polling identities; idle state cleanup and per-isolate cold budgets bound abuse. [Decision](../decisions/2026-10-11-edge-cold-fill-and-clock-skew.md).

- 2026-10-11 — ACCEPTED: DO spend authority and 30s snapshot design; freeze/drain before negative adjustments, no fixed-price consumer debt. #353/#430. [Decision](../decisions/2026-10-11-edge-authority-and-lots.md).
- 2026-10-11 — ACCEPTED: Exactly one upstream per listing; publisher owns multi-provider failover. #327/#328 P2. [Decision](../decisions/2026-10-11-capability-routing-deferred.md).
- 2026-10-11 — ACCEPTED: Rail off by policy; P1 #424 gate pending, activation P2 #109. [Decision](../decisions/2026-10-11-x402-disabled.md).
- 2026-10-11 — ACCEPTED: Hide/non-callable per-token LLMs #425; future debt policy #431 P2 is not authorized now. [Decision](../decisions/2026-10-11-llm-deferred.md).

- 2026-07-12 — Data plane stays a thin, isolated Cloudflare Worker (future Go-port candidate). [stack decision](../decisions/2026-07-12-stack.md)
- 2026-07-11 — Consumer's own org wallet pays; foreign-org keys on private projects get `404`; wildcard CORS on public gateway surfaces (commit `32d5c17`).
- 2026-10-07 — Upstream `Idempotency-Key` scoped per consumer org/project/method/URL; forwarding identity, `Connection`-nominated and `x-zevium-*` headers stripped (commit `e968b1e`). See findings above.
- 2026-10-10 — ACCEPTED: keyless x402 wallet sessions become a second auth path beside API keys. Built behind configuration in #109. [decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md); details in [machine-payments](machine-payments.md). (Historical; scope superseded 2026-10-11 above.)
- 2026-10-10 — BUILT (#316): operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Publishing remains allowed with a warning. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)
- 2026-10-10 — BUILT: operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Replaces code's default of 1 credit. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)
- 2026-10-10 — BUILT (#316): operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Publishing remains allowed with a warning. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)
- 2026-10-10 — ACCEPTED: keyless x402 wallet sessions become a second auth path beside API keys. Not built. [decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md); details in [machine-payments](machine-payments.md). (Historical; scope superseded 2026-10-11 above.)
- 2026-10-10 — BUILT (#329): LLM per-token pricing — hold estimated input + `max_tokens` (or fixed cap) at spec rates, settle actual, release rest; in-flight budget + 402 reasons copied from OpenRouter. [decision](../decisions/2026-10-10-llm-per-token-pricing.md) (Historical; scope superseded 2026-10-11 above.)

## Open questions

- Machine payments are deferred; gate/enablement work is #424 (activation P2 #109); see [machine-payments](machine-payments.md).
- Doc/code conflict: "Payment-required errors" lists `/gateway` failures as `402` or generic `404`. Code also returns `503 verification_unavailable` (Clerk unreachable), `503 wallet_unavailable` (cold wallet control snapshot unavailable; warm wallets retain last-known state, [#360 storage/refresh](wallet-billing.md#wallet-storage-and-retention-360)), `410 sunset_reached`, `422 invalid_spec`/`unsafe_upstream`, `404 no_upstream`, `500 reserve_failed`/`pricing_identity_failed`.
