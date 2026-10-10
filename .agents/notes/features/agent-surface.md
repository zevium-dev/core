# Agent surface (MCP + discovery)

> Status: partial (P1 #9 — marketplace-wide MCP + discovery index built; per-API agent tooling planned; #361 buffered-result billing fixed; #395 parameters and #396 payment recovery fixed; #330 semantic discovery built; #392 local discovery origins fixed) · Updated: 2026-10-10
> Code: `apps/gateway/src/mcp.ts`, `apps/gateway/src/mcp-call-params.ts`, `apps/gateway/src/payment-required.ts`, `apps/gateway/src/pipeline.ts`, `apps/gateway/src/forward.ts` (`prepareResponse` hook), `apps/gateway/src/finalize.ts` (settlement/refund), `apps/gateway/test/discovery-mcp.test.ts`, `apps/gateway/src/mcp-api-docs.ts`, `apps/gateway/src/discovery.ts`, `apps/gateway/wrangler.jsonc`, `apps/gateway/scripts/discovery-dev-origin.smoke.mjs`, `apps/gateway/src/catalogue-source.ts`, `apps/web/src/routes/docs/agents.tsx`, `apps/web/src/components/catalogue-detail.tsx` (`ConnectAgentPanel`), `apps/web/src/lib/landing.ts` (`buildMcpConfigSnippet`, `mcpEndpointUrl`, `discoveryEndpointUrl`), `apps/web/src/routes/llms[.]txt.ts`, `apps/web/src/lib/llms.ts`, `apps/web/src/lib/llms.test.ts`, `apps/web/src/components/agent-install.tsx`, `apps/gateway/src/catalogue-search.ts`, `convex/http.ts`, `/gateway-search`, `convex/search.ts`
> Related: [gateway](gateway.md), [machine-payments](machine-payments.md), [catalogue-search](catalogue-search.md), [quality-signals](quality-signals.md), [api-keys](api-keys.md), [mock-sandbox](mock-sandbox.md), [landing-docs](landing-docs.md), [decision: dual-rail keys + x402](../decisions/2026-10-10-dual-rail-keys-and-x402.md)

The differentiator: AI agents discover published APIs, evaluate per-endpoint cost before calling, read call docs, and execute through the same key- or wallet-session-authenticated, credit-gated gateway as human traffic. Agents are a consumer type with the same billing model as human developers.

## Product

**Agent-facing surface (the differentiator)** — items 1–3:

1. **Metered agent tooling.** Every published API is consumable as agent tools through the same key- or wallet-session-authenticated, credit-gated gateway as human traffic. Tool discovery is search-then-load (an agent searches the catalogue semantically, then loads only the tools it needs) — never a dump of every endpoint into the agent's context
2. **Machine-readable discovery index.** A crawlable index of published APIs with per-endpoint pricing metadata, so agents can evaluate cost before calling
3. **Agent-readable usage docs per listing** — connection config tells an agent _how to connect_; usage docs tell it _how to use the API well_

Item 4 (machine-native payments, x402): [machine-payments](machine-payments.md).

- Consumer type: **AI agents** — discover APIs through Zevium's machine-readable index and consume them as agent tools through the same metered gateway. Same prepaid org-scoped wallet, per-call deduction, and zero-balance block as humans.
- **Headline consumer metric: time-to-first-call.** Signup → working key → first successful metered request must take under a minute, fully self-serve. (Applies to agents as consumers too.)
- P1 #9 — Per-API agent tooling + machine-readable discovery/pricing index. [roadmap](../product/roadmap.md)
- P0 #2 — All agent tooling routes through metering — no unmetered side doors ([gateway](gateway.md)).

## Flow

### Discovery index (P1) — `GET /discovery`

- Crawlable machine-readable index of published APIs with per-endpoint pricing metadata — agents evaluate cost **before** calling

### Agent-tool endpoint — `/mcp`

- Marketplace-wide agent server: semantic catalogue search tool + execute tool — **execution routes through the same key- or wallet-session-authenticated, credit-gated gateway as human traffic; no unmetered side doors**
- Per-API agent tooling generated from the published spec (P1); compact tool surface — search-then-load, never every endpoint as a tool
- Human-visible counterpart: "Connect your agent" tab on the API detail page

### "Connect your agent" tab — `/catalogue/{org}/{api}`

- Copy-paste agent-tool config per client + agent-readable usage notes

### Current machine surface (from code)

- `/mcp`: MCP Streamable HTTP, JSON-RPC 2.0 — `initialize`, `tools/list`, `tools/call`, `ping`, `notifications/initialized`; protocol version `2024-11-05`.
- Tools: `search_apis` (catalogue search, compact pricing), `get_api_docs` (call reference + pricing + usage notes for one API), `call_api` (metered execute via the gateway pipeline).
- `call_api` auth: Zevium key or signed anonymous wallet session via MCP request `Authorization: Bearer` / `x-api-key`, or a `key` tool argument. A complete successful result settles the charge; failed or oversized results and execution timeouts release the reservation.
- `/docs/agents`: in-app guide — MCP config, discovery URL, tool list, mock URL pattern.

## Tech

- **Discovery origins (#392)**: `index.ts` supplies the request URL's origin to `discovery.ts`; forwarded-host/proto headers are ignored. Wrangler's dev-only `host: "localhost:8787"` setting supplies the advertised local gateway host and port instead of inferring the production custom route; local HTTP/HTTPS follows the dev server protocol. Custom ports need a matching `--host` override (see dev-environment). Production HTTPS requests retain HTTPS URLs. Worker tests cover local/production/custom origins; a real Wrangler dev test with fixture listings covers the configured route rewrite boundary.

**Dogfood — 2026-10-10**

- **P1 #392 (fixed):** local discovery/MCP metadata previously generated `http://gateway.zevium.dev/...` instead of the local gateway origin.
- **P1 #395:** `call_api` treats a query-bearing path as the operation pathname and returns 404; the equivalent direct request succeeds.
- **P1 #396:** MCP 402 sanitization drops the direct gateway payment reason, required/available credits and recovery actions. Zero balance still blocks execution.
- Initialization, tool listing, search/docs and a queryless paid call worked; Claude Code connected after adding the HTTP transport type to config (existing **#326**).

Evidence, workarounds and scope: [dogfood findings](../findings/dogfood-2026-10-10.md).

- Web `GET /llms.txt` is a public TanStack Start server route returning `text/plain; charset=utf-8`. Web links use the request origin; gateway links use `resolveGatewayOrigin` / endpoint builders and `VITE_GATEWAY_URL`; pricing uses shared `CREDITS_PER_DOLLAR`. Documents current 402/403/404/422/429 errors, including monthly-cap recovery and the #336 per-key request limit with `Retry-After`, keyless mocks, discovery, and example prompts. Route-contract tests check every generated URL against the generated web route tree or known gateway dispatch/parser routes. Gateway-side copy remains deferred (#322).
- `AgentInstall` is shared by the landing page, `/docs/agents`, and listing `ConnectAgentPanel`. Its Claude Code command, Cursor JSON + deeplink, and Codex TOML all use the `ak_YOUR_API_KEY` placeholder. No real key is read. All snippets and listing usage notes use `DocsCodeBlock`, which delegates copy behavior and clipboard failure feedback to the shared `CopyButton` from #375; client-specific accessible copy labels are preserved. Cursor installs a placeholder config; users replace it in their client settings.
- Cursor deeplink format checked against [official install-link docs](https://cursor.com/docs/mcp/install-links) on 2026-10-10: base64 JSON for one server, URL-encoded in `config`, server name in `name`. Codex uses `mcp_servers.zevium` + `http_headers` in `~/.codex/config.toml` ([official MCP docs](https://developers.openai.com/codex/mcp/)).
- **Semantic discovery (#330)**: `search_apis` uses `POST /gateway-search` with `GATEWAY_INTERNAL_SECRET`, then the same Convex semantic pipeline as the web. Verified header keys supply org/key attribution; tool arguments cannot override it. Anonymous discovery retains the shared anonymous limit. Search is discovery only; no Convex call is added to paid execution. Results contain at most 10 listings with relevance scores and pricing rollups, never endpoint dumps or per-result spec fetches. Embedding failure, admission refusal, or internal-route failure falls back to one bounded substring-search page with `degraded: true`, `searchMode: "keyword"`, and null scores. Blank queries browse one page. Worker search timeout is 8 seconds within the 10-second tool deadline. Ranking/cost controls are owned by [catalogue-search](catalogue-search.md).
- **Unpriced endpoints (#316)**: `endpointsFromSpec` skips missing prices, so `/discovery` and MCP `get_api_docs` expose only explicit scalar or token-rate prices. MCP `search_apis` returns catalogue pricing rollups computed from priced operations without enumerating endpoints. Docs traverse schemas only from visible endpoints; components reachable solely from hidden operations are omitted. `call_api` shares gateway route-not-found behavior. Web `/llms.txt` is a static setup guide and does not enumerate operations.

- **Per-token pricing (#329)**: built for OpenAI-compatible JSON/SSE. Spec rates are exposed in catalogue references, editor, discovery, and MCP; admission holds an estimated maximum, an asynchronous tee observer settles actual usage, and wallet settlement releases the remainder. Missing usage charges zero. Wallet budget, whole-credit rounding, stream/parser limits, and `x-zevium-hold` are defined in the [pricing contract](../decisions/2026-10-10-llm-per-token-pricing.md#implementation-contract-329). Code: `packages/shared/src/pricing.ts`, `apps/gateway/src/token-metering.ts`, `apps/gateway/src/{admit,finalize,wallet}.ts`, `convex/wallets.ts`. Unpriced operations are hidden; explicit zero-price calls remain available to funded wallets.

- **Anonymous wallet rail (#109)**: `call_api` forwards wallet-session Bearer credentials to the shared gateway pipeline. A missing credential can return the base64 `paymentRequired` offer in the tool error. Complete the top-up at the offer’s HTTP gateway resource URL, then use the returned session for MCP calls; payment settlement does not run inside MCP’s 10-second execution deadline. See [machine-payments](machine-payments.md) for configuration and sandbox limitations.

- **MCP call reference**: `search_apis` and `/discovery` stay compact. Only `get_api_docs` projects call docs from the immutable published spec through `mcp-api-docs.ts`, using shared parsed types: inherited path parameters with operation overrides keyed by `(in, name)`, request/response media types, allowlisted schemas, inline/named examples, and reachable `#/components/{schemas,parameters,requestBodies,responses,examples}/<name>` definitions. Refs stay refs; a visited worklist handles recursive components and URI fragment decoding followed by JSON Pointer name escaping without expansion or network fetches. Unsupported/external refs, servers, security schemes, extensions, response headers/links, and media encoding metadata are omitted. Missing local refs remain unresolved. Schema/data walks cap at depth 64 and 50,000 nodes and fail with generic unreadable-spec tool error. All publisher text/schema/example payloads remain under `publisherData`; example/default/enum/const JSON keys are payload data, not metadata. Trusted usage notes are static. No registry or pricing store changes.
- **Call parameters (#395)**: `call_api` accepts `pathParams` keyed by `{name}` placeholders and `query` keyed by parameter name. Path values are percent-encoded; scalar query values use `URLSearchParams`, arrays repeat the key (form/explode). Inline encoded query strings remain supported, with explicit `query` entries replacing same-name inline values. Other OpenAPI serialization styles use pre-serialized strings or inline queries. Routing uses only the canonical pathname; search is forwarded separately through the existing pipeline. Absolute URLs, host overrides, fragments, control characters, backslashes, missing/unused path parameters, malformed parameter shapes, and traversal (including nested percent encoding) fail before reservation. No new dependencies or auth changes.
- **Body handling** (MCP part): MCP `call_api` reuses the same authenticated, metered pipeline, then buffers its JSON-RPC request and upstream response in Worker memory with explicit 1 MiB limits because MCP tool results embed response text. Neither path persists payload bodies in application tables.
- **Buffered-result billing (#361)**: MCP passes a `prepareResponse` hook into `handleGatewayRequest`. The pipeline passes it into `forward`, which consumes and bounds the upstream body inside its fetch/error boundary before `finalize` settles or refunds. Oversize (declared or streamed), body-read errors, and 10s execution timeouts refund paid holds and restore free-tier allowance. Failed usage records carry zero cost. Aborted late responses cannot settle; `waitUntil` keeps refund cleanup alive after the timeout response. Once the complete result is buffered, the timeout race stops before billing finalization, so a slow settlement cannot turn a charge into a timeout tool error. Direct gateway streaming is unchanged.
- **MCP errors**: tool validation and exception paths use static human-readable messages. Non-2xx results expose status, request id, zero charged `cost`, and a static message; upstream error bodies/headers and exception text/stacks are omitted. Platform-generated 402s additionally preserve the `payment-required.ts` envelope’s `error`, `reason`, `detail`, `actions` (create key/top up/docs), and `available`; required price is exposed as `requiredCredits` to distinguish it from charged `cost: 0`. Missing/invalid-key tool guards use that same envelope. Recovery data is only exposed when the upstream preparation callback never ran, so a forged upstream 402 body/headers cannot cross the platform trust boundary. Successful `call_api` body and headers are under `publisherData`, matching the discovery/docs trust boundary.
- **Gateway CORS**: `/mcp` and `/discovery` allow wildcard origin (bearer-key auth only) — full bullet in [gateway](gateway.md).

Code limits (`mcp.ts`): request body 1 MiB, upstream response 1 MiB, JSON-RPC batch ≤100, tool execution timeout 10s through response buffering; billing finalization completes afterward.

### Findings

- [mcp-request-docs](../findings/mcp-request-docs.md) — `get_api_docs` projection contract, trust boundary (`publisherData`, static `trustedUsageNotes`), deliberate omissions, URI-encoded ref fix.
- [treg-reuse](../findings/treg-reuse.md) — what was ported from the Treg review (idempotency, header hygiene, MCP call docs) and what was rejected as unproven (CLI, plugins, onboarding, LLM search judges, demand intake, routing, query credentials).

## Decisions

- 2026-10-10 — Web distribution implementation of [P0 agent bet](../decisions/2026-10-10-p0-agent-bet.md): #326 client installs share one component; #322 serves web `/llms.txt`, with gateway-side copy deferred to avoid concurrent gateway restructuring. Catalogue changes are limited to the agent panel.

- 2026-07-11 — `/discovery` index + `/mcp` endpoint ship; agent tools execute through the metered pipeline (commit `93d259e`).
- 2026-10-07 — `get_api_docs` gains parameters/schemas/examples; `search_apis` and `/discovery` stay compact. No Treg code copied (license) (commit `e968b1e`).
- 2026-10-10 — ACCEPTED: keyless x402 wallet sessions become a second auth path beside API keys. Not built. [decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md); details in [machine-payments](machine-payments.md).
- 2026-10-10 — ACCEPTED: agent distribution promoted to P0 — `llms.txt`, OAuth on `/mcp` (claude.ai connector), Claude Connectors Directory submission, official MCP Registry listing, one-click installs (Claude Code/Cursor/Codex). [decision](../decisions/2026-10-10-p0-agent-bet.md)
- 2026-10-10 — ACCEPTED: capability routing promoted P2 #22 → P0; owned by [capability-routing](capability-routing.md). [decision](../decisions/2026-10-10-p0-agent-bet.md)
- 2026-10-10 — BUILT (#316): operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Publishing remains allowed with a warning. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)

## Open questions

- Resolved #395: documented path/query parameters are callable through explicit schema fields or inline encoded paths/queries; regression tests cover the advertised reference, encoding, repeated values, unsafe paths, and paid settlement.
- Resolved #396: missing/invalid keys and insufficient credits return machine-readable reasons and recovery actions; upstream 402s remain sanitized and refunded.
- Resolved #361: failed buffered MCP results no longer settle charges; regression coverage includes paid/free-tier refunds, size boundaries, timeout races, body/fetch exceptions, and sanitized tool errors.

- Resolved #330: MCP and web use the same semantic pipeline, embedding cache, visibility checks, and relevance/quality ranking. Paraphrase and fallback regressions cover both entry points.
- Status note: FLOW tags the discovery index P1; `/discovery` is already live in `discovery.ts` (built ahead of its tag).
- Planned: per-API agent tooling from the published spec (P1 #9 remainder; backlog Later "per-listing MCP tool surfaces beyond current global search/load/call tools").
- Backlog: production acceptance journey must also verify MCP calls against the same listing as a paid call.

### Agent distribution — P0 items accepted 2026-10-10 (llms.txt, OAuth, Connectors Directory, MCP Registry, installs); leaderboards and the rest remain ideas

Source: [research](../research/agent-api-marketplace-landscape.md). Accepted items: see Decisions. Capability routing moved to [capability-routing](capability-routing.md).

- **`llms.txt`** — Stripe's agent seller Directory asks for an `llms.txt` and example prompts ("Demand" section). Web `/llms.txt` is built (#322); gateway-side copy remains deferred.
- **Claude Connectors Directory submission** — called the highest-leverage free channel: listings are eligible for in-chat Suggested Connectors ranked by usage; self-submission reportedly opened ~2026-09-25; annotate every tool readOnly/destructive and publish a privacy policy (common rejection causes) ("Demand"). Unknown per report: whether Anthropic's directory policy allows credit-gated connectors.
- **OAuth on `/mcp`** for adding Zevium as a claude.ai connector — current `/mcp` auth accepts bearer API keys and wallet sessions. Source: [treg comparison](../research/treg-comparison.md) (treg ships an OAuth connector at `/mcp/v2/`). Verify connector auth requirements before deciding.
- **Official MCP Registry listing** — so Glama, Kong and other aggregators pick Zevium up downstream; optionally a Zevium sub-registry speaking the open registry API ("Demand"; "Priority stack: Now").
- **Claude Code plugin / skill** — source: [treg comparison](../research/treg-comparison.md) (treg ships one); landscape report lists "one-click install buttons" under Now. Note [treg-reuse](../findings/treg-reuse.md) rejected plugins as unproven for that PR.
- **Capability-level routing with fallback + max-cost** — report: category auto-routing across substitutable suppliers (OpenRouter inverse-square price weighting, 30s outage skip) needs normalized category schemas, so it waits for several suppliers ("Later"); "up to $X" variable price where the wallet DO pre-authorizes a cap and settles actual cost; max-per-call caps ("Trust"). Roadmap P2 #22 provider fallback routing.
- **Public leaderboards from app-attribution headers** — copy OpenRouter's loop: optional app headers feed public daily/weekly leaderboards plus a per-API "top apps" tab ("Demand"). Note: the gateway forwarding boundary drops inbound `x-zevium-*` request headers, so attribution headers would need explicit handling before filtering.
- Other report ideas touching this surface: rank `search_apis` by gateway-measured quality; require a "use when" line and output schema per listing; Code Mode `run_script` tool; `?tools=` pin parameter ("Trust").
