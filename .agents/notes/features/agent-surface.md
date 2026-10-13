# Agent surface (MCP + discovery)

> Status: shared MCP/CLI/docs converter #428 and single-file CLI distribution #451 built; owner release/activation pending · Updated: 2026-10-13
> Code: `packages/shared/src/spec-generation/`, `packages/cli/{src,scripts/build.mjs,package.json,README.md}`, `apps/web/scripts/build.mjs`, `apps/web/src/server{,.test}.ts`, `apps/web/src/routes/docs/agents.tsx`, `apps/web/src/lib/llms.ts`, `apps/gateway/src/generated-contract.ts`, `apps/gateway/src/{mcp,mcp-oauth,discovery,mcp-api-docs,mcp-call-params}.ts`, `apps/gateway/src/next/`, `convex/{search,http,keySettings}.ts`
> Related: [gateway](gateway.md), [machine-payments](machine-payments.md), [catalogue-search](catalogue-search.md), [quality-signals](quality-signals.md), [api-keys](api-keys.md), [mock-sandbox](mock-sandbox.md), [landing-docs](landing-docs.md), [decision: dual-rail keys + x402](../decisions/2026-10-10-dual-rail-keys-and-x402.md)

The differentiator: AI agents discover published APIs, evaluate per-endpoint cost before calling, read call docs, and execute through the same API-key- or verified-MCP-OAuth-authenticated, credit-gated gateway as human traffic. Agents are a consumer type with the same billing model as human developers.

## Product

**Agent-facing surface (the differentiator)** — items 1–3:

1. **Metered agent tooling.** Every published API is consumable as agent tools through the same API-key- or verified-MCP-OAuth-authenticated, credit-gated gateway as human traffic. Tool discovery is search-then-load (an agent searches the catalogue semantically, then loads only the tools it needs) — never a dump of every endpoint into the agent's context
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

- Marketplace-wide agent server: semantic catalogue search tool + execute tool — **execution routes through the same API-key- or verified-MCP-OAuth-authenticated, credit-gated gateway as human traffic; no unmetered side doors**
- Per-API agent tooling generated from the published spec (P1); compact tool surface — search-then-load, never every endpoint as a tool
- Human-visible counterpart: "Connect your agent" tab on the API detail page

### "Connect your agent" tab — `/catalogue/{org}/{api}`

- Copy-paste agent-tool config per client + agent-readable usage notes

### Current machine surface (from code)

- `/mcp`: MCP Streamable HTTP, JSON-RPC 2.0 — `initialize`, `tools/list`, `tools/call`, `ping`, `notifications/initialized`; protocol versions `2024-11-05`, `2025-03-26`, `2025-06-18`, and `2025-11-25` (latest fallback).
- Tools: `search_apis` (catalogue search, compact pricing), `get_api_docs` (call reference + pricing + usage notes for one API), `call_api` (metered execute via the gateway pipeline).
- With OAuth enabled, connect at the canonical `/mcp` URL, sign in through Clerk, choose the funded organization, and consent to API spending. Create a current API key in that org first at `/app/settings/keys`; OAuth shares its cap and lifecycle.
- `call_api` auth: Zevium key via MCP request `Authorization: Bearer` / `x-api-key`, or a `key` tool argument for API-key clients; OAuth binds the consented user/org to their current key and rejects `key` overrides. A complete successful result settles the charge; failed or oversized results and execution timeouts release the reservation.
- `/docs/agents`: in-app guide — MCP config, discovery URL, tool list, mock URL pattern.

## Tech

Discovery, MCP docs and calls use published scalar OpenAPI and paired signed authority. Semantic search preserves gateway org/key budgets. OAuth verification runs in its bounded coordinator and maps a verified session to an active org key; provider activation is owner-only. Direct API keys remain the default. MCP prepares bounded results before finalization; rejected buffering yields zero debit. No wallet sessions, x402 or token execution exist. Real workerd/Convex acceptance covers cold OAuth, negative caching and signed settlement.

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

### Shared published-contract conversion (#428)

- `packages/shared/src/spec-generation/` owns pure `generateSpecContract({ spec, version })`: one ordered operation model renders MCP definitions, CLI flags and Markdown. Explicit scalar prices only; zero is free, missing prices and disabled token pricing stay hidden. Published version label wins over `info.version`.
- `get_api_docs` adds `publisherData.generated` without changing `tools/list` or execution. Each operation supplies `tool`, `command`, fixed `call` routing fields, price, identity and input schema. Shared `generatedToolArguments` binds generated inputs to `call_api`, including Content-Type and JSON string/null body serialization; CLI uses the same binding. These definitions are not independently registered tools. Existing #110 owns listing-scoped URLs, registration and client acceptance; #350 remains P2 SDK scope.
- Parameters merge by location/name; operation overrides path-level values. Local refs inline with cycle detection; enums, composition (including `oneOf`), defaults/examples, JSON bodies and response schemas carry through. OpenAPI 3.0 nullable/exclusive bounds normalize to JSON Schema. External refs, recursion, unsupported serialization/media/schema keywords and reserved headers produce visible operation diagnostics and no generated command/tool. Legacy call reference remains available. No fetching, evaluation, timestamps, upstream URLs, auth metadata or vendor-extension projection.
- Resource limits: existing 384 KiB spec cap; 256 priced operations, depth 32, 12,000 work units (nodes, inspected/copied fields, array slots and reference resolution), 192 KiB expanded strings and final artifact. Fields and reference hops consume budget before copying/merging; parameters drop unknown fields and extensions before merges, and schemas project supported fields while rejecting unsupported constraints. Wide maps and arrays reserve work before expansion. Limit violations fail the artifact visibly (`complexity_limit`), including anonymous docs requests. `apps/gateway/src/generated-contract.ts` caches frozen results/failures for 16 immutable spec-byte/version keys; visibility is checked before cache access, lifecycle metadata never cached there. No new hot-path network calls or Worker dependencies.
- Gateway `GET /docs/:publisher/:project` returns generated Markdown for public listings. Dynamic route visibility uses no-store HTTP caching; immutable artifacts stay cached inside the isolate. `get_api_docs` checks the escaped tool-result size with envelope headroom under the existing 1 MiB adapter limit; if the generated block alone pushes it over, only `generated` degrades to `{ error: "generation_unavailable", reason: "response_size_limit" }` and the legacy reference plus `/docs` Markdown stay available.
- `packages/cli` entry `zevium <publisher> <project> [command] [flags]` loads this model through `get_api_docs` and executes only through existing authenticated/metered `call_api`. No direct upstream or automatic retries. Single-file distribution is built in #451; deployment and npm publication remain owner actions. `ZEVIUM_API_KEY` supplies auth; HTTPS gateway origins or HTTP loopback only, redirects rejected, 15-second timeout and 1 MiB request/response caps. Required/known flags and JSON syntax validate locally; payload semantics remain upstream-owned.
- Command names use sanitized operationId (method/path fallback) plus ordinal in deterministic sorted order. Names are stable for an immutable spec version, not across revisions. Docs identify that version; current gateway routes still execute the currently published version, without execution pinning.
- Golden artifacts live in `packages/shared/src/spec-generation/fixtures/`; standard shared tests compare them without updates. Adversarial projector tests count source reads/enumeration for wide objects, repeated refs and deep chains; CLI tests verify generated binding/auth, terminal-control escaping and failure behavior; gateway tests verify docs equivalence, caching, visibility, bounds and compatibility.

### CLI distribution (#451)

- `@zevium/cli` 0.1.0 is npm-publishable with `files: ["dist/zevium.mjs"]`, `bin.zevium` pointing to that artifact, `engines.node: >=24.15.0`, and zero runtime dependencies. Shared code, zod and esbuild are dev dependencies. Private `@zevium/shared` carries version 0.0.0 so pnpm can serialize its dev-only workspace reference when packing; it remains private. Root tooling may still use tsx; the CLI does not.
- `packages/cli/scripts/build.mjs` bundles `src/main.ts` with esbuild 0.28.2 (already resolved in the workspace), targets Node 24.15.0 from the package engine, prepends the shebang and early runtime guard, invokes `main`, and sets 0755. Build rejects external non-builtin imports. Output is gitignored.
- Turbo's workspace dependency graph orders CLI before web. `apps/web/scripts/build.mjs` rebuilds/copies the artifact even when invoked directly, before Vite copies public assets. Stable download: `/cli/zevium.mjs`, explicitly allowed through the web Worker asset boundary in `apps/web/src/server.ts`. Web builds generate both the public file and final client asset; neither is committed. No deployment is implied by a local build.
- `/docs/agents`, `/llms.txt`, and CLI README document curl/chmod, Node minimum, Windows Node invocation, environment-only credentials, generated commands, re-download updates, and authenticated credit gating. llms.txt uses the incoming web origin for downloads.
- Compatibility: `GENERATOR_VERSION` is a positive integer wire-format major, independent of package semver and published listing versions. The CLI pins supported major 1 independently of the producer constant. Additive optional fields remain compatible; required-field, flag-encoding or call-binding changes require a new major and explicit client review. Missing/malformed/unknown majors stop before execution with an upgrade message. Release the compatible CLI before changing the gateway's producer major.
- Verification: CLI tests copy the bundle into `.tmp/` and block external module resolution, run `--help`, check shebang/executable mode and renamed invocation, and exercise runtime minimum/version-policy acceptance and rejection. `build:ci` checks the final web asset matches the tested CLI bytes. Existing auth/binding/no-retry tests remain.

Owner release steps (not executed by this implementation):

1. Choose the next package version in `packages/cli/package.json`; keep package semver independent of generator major. Review compatibility and changelog, then run `mkdir -p .tmp` and `TMPDIR="$PWD/.tmp" VITEST_MAX_WORKERS=2 pnpm ci:pr` on the release commit.
2. Run `pnpm --filter @zevium/cli build`, then `pnpm --dir packages/cli pack --out ../../.tmp/zevium-cli.tgz`. Inspect with `tar -tzf .tmp/zevium-cli.tgz`: only package manifest, README, inherited LICENSE and `dist/zevium.mjs` should ship. Confirm no runtime dependencies or workspace references in the packed runtime dependency fields. Run the packed script's `--help` from a clean directory with supported Node.
3. For web release, use the normal owner-approved web deployment process. Verify `curl -fsSLo .tmp/zevium https://<site>/cli/zevium.mjs`, then `chmod +x .tmp/zevium` and `.tmp/zevium --help`. Check `/docs/agents` and `/llms.txt` reference that path. Re-download replaces an older local CLI.
4. Optional npm release, **owner only**: confirm ownership of the `@zevium` npm scope and intended version, then `pnpm publish .tmp/zevium-cli.tgz --access public`. Do not run this as part of CI or normal builds. Only after a confirmed release advertise `pnpm add -g @zevium/cli` as an install option. This task does not publish or change registry visibility.

## Decisions

- 2026-10-13 — ACCEPTED: CLI ships as one plain Node script, stable web download, optional owner-only npm publication; explicit generator-major compatibility. [Decision](../decisions/2026-10-13-cli-node-script.md).

- 2026-10-11 — ACCEPTED: Generate MCP/CLI/docs from publisher OpenAPI; P0 #428 links existing #110, P2 #350. [Decision](../decisions/2026-10-11-openapi-as-contract.md).
- 2026-10-11 — ACCEPTED: Routing #327/#328 moves to P2; preserve #372. Agent distribution stays P0. [Decision](../decisions/2026-10-11-capability-routing-deferred.md).
- 2026-10-11 — ACCEPTED: x402 off; enforcement #424 pending and activation #109 P2. [Decision](../decisions/2026-10-11-x402-disabled.md).
- 2026-10-11 — ACCEPTED: Per-token LLM listings must leave discovery and callable tools in #425; revival #431 P2. [Decision](../decisions/2026-10-11-llm-deferred.md).

- 2026-10-10 — Web distribution implementation of [P0 agent bet](../decisions/2026-10-10-p0-agent-bet.md): #326 client installs share one component; #322 serves web `/llms.txt`, with gateway-side copy deferred to avoid concurrent gateway restructuring. Catalogue changes are limited to the agent panel.

- 2026-10-10 — #323 implementation: use Clerk as authorization server, hosted org consent, JWT/JWKS validation plus cached opaque-token verification for revocable grants, and the existing current member key for billing. Production activation and live claude.ai acceptance remain owner actions.

- 2026-07-11 — `/discovery` index + `/mcp` endpoint ship; agent tools execute through the metered pipeline (commit `93d259e`).
- 2026-10-07 — `get_api_docs` gains parameters/schemas/examples; `search_apis` and `/discovery` stay compact. No Treg code copied (license) (commit `e968b1e`).
- 2026-10-10 — ACCEPTED: keyless x402 wallet sessions become a second auth path beside API keys. Not built. [decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md); details in [machine-payments](machine-payments.md). (Historical; scope superseded 2026-10-11 above.)
- 2026-10-10 — ACCEPTED: agent distribution promoted to P0 — `llms.txt`, OAuth on `/mcp` (claude.ai connector), Claude Connectors Directory submission, official MCP Registry listing, one-click installs (Claude Code/Cursor/Codex). [decision](../decisions/2026-10-10-p0-agent-bet.md)
- 2026-10-10 — HISTORICAL (superseded 2026-10-11): capability routing promoted P2 #22 → P0; owned by [capability-routing](capability-routing.md). [decision](../decisions/2026-10-10-p0-agent-bet.md)
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
- **OAuth on `/mcp`** (implemented in #323; activation above) enables claude.ai custom connectors alongside bearer API keys; live acceptance requires owner configuration above.
- **Official MCP Registry listing** — so Glama, Kong and other aggregators pick Zevium up downstream; optionally a Zevium sub-registry speaking the open registry API ("Demand"; "Priority stack: Now").
- **Claude Code plugin / skill** — source: [treg comparison](../research/treg-comparison.md) (treg ships one); landscape report lists "one-click install buttons" under Now. Note [treg-reuse](../findings/treg-reuse.md) rejected plugins as unproven for that PR.
- **Capability-level routing with fallback + max-cost** — report: category auto-routing across substitutable suppliers (OpenRouter inverse-square price weighting, 30s outage skip) needs normalized category schemas, so it waits for several suppliers ("Later"); "up to $X" variable price where the wallet DO pre-authorizes a cap and settles actual cost; max-per-call caps ("Trust"). Roadmap P2 #22 provider fallback routing.
- **Public leaderboards from app-attribution headers** — copy OpenRouter's loop: optional app headers feed public daily/weekly leaderboards plus a per-API "top apps" tab ("Demand"). Note: the gateway forwarding boundary drops inbound `x-zevium-*` request headers, so attribution headers would need explicit handling before filtering.
- Other report ideas touching this surface: rank `search_apis` by gateway-measured quality; require a "use when" line and output schema per listing; Code Mode `run_script` tool; `?tools=` pin parameter ("Trust").
