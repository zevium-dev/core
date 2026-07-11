# Zevium Product Specification

> Last updated: 2026-07-11
> Market research backing this direction: [docs/product-discovery-2026.md](docs/product-discovery-2026.md)

## What is Zevium

Zevium is an **agent-first, per-call API marketplace**. Publishers list APIs with OpenAPI specs; consumers — human developers **and AI agents** — pay per call via prepaid credits through a metered proxy.

The RapidAPI-style horizontal marketplace slot is vacant (RapidAPI collapsed and was sold for parts to Nokia in 2024). The consumers replacing that demand are increasingly AI agents: MCP has ~97M monthly SDK downloads, but its 10k+ public servers are largely broken, unmetered, and insecure, and the MCP spec has no payment primitives. Zevium's bet: be the **curated, metered, secured** place where both humans and agents discover and pay for APIs per call.

## Two-sided platform

### Publishers (API sellers)

- Organizations publish APIs on Zevium; each API = a `project` with an OpenAPI spec
- **The spec is the product**: upstream URL, endpoints, per-endpoint pricing, and free tier all live in the spec — no separate pricing tables
- Publishers set per-endpoint pricing (`x-zevium-cost`) and optional free tier (`x-zevium-free-tier`)
- Publishers earn revenue when consumers call their endpoints; earnings accumulate toward payouts
- Listing quality is enforced: uptime monitoring and (later) security scanning gate what stays listed

### Consumers (API buyers)

Two consumer types, one billing model:

1. **Human developers** — browse the catalogue, get a key, test in the playground, integrate
2. **AI agents** — discover APIs through Zevium's machine-readable index and consume them as MCP tools through the same metered proxy

Both:

- Pre-pay for credits — **org-scoped**: the organization owns the wallet, member keys draw from it, admins see per-member/per-key attribution. Solo devs get a personal org automatically; there is no separate personal-wallet model
- Each call deducts credits based on the endpoint's price
- API keys belong to a member (one key per user), are rate-limited, and carry per-key spend limits against the org wallet
- Polar customer `externalId = organizationId`; proxy resolves key → member → org wallet. (Current code is user-scoped — rebuild, don't migrate: pre-launch, no users, data is disposable)

**Headline consumer metric: time-to-first-call.** Signup → working key → first successful proxied request must take under a minute, fully self-serve.

## Revenue model

```
Consumer pays:     100 credits / call
Zevium takes:        5 credits (5% platform cut)
Publisher earns:    95 credits (95% revenue share)
```

- **Publishers keep 95%.** 20-30% take rates made horizontal marketplaces economically unsustainable for high-volume AI workloads. Market benchmarks: Apify keeps 20%, MCPize 15%, AWS Marketplace ~3-5%. At 5%, Zevium matches cloud-marketplace economics while offering full marketplace features — the strongest possible publisher acquisition pitch
- Credits are prepaid by consumers via Polar fixed-product top-ups
- Platform cut + publisher share are calculated at call time from ingested `proxy_call` events
- Publisher earnings accumulate and are settled via payouts (see roadmap)

## How pricing works

Pricing is stored **in the OpenAPI spec** as vendor extensions on each path/operation:

```yaml
openapi: 3.1.0
info:
  title: OpenAI GPT API
servers:
  - url: https://api.openai.com
paths:
  /v1/chat/completions:
    post:
      x-zevium-cost: 10        # credits per call
      x-zevium-free-tier: 5    # optional: free calls per day
      summary: Chat completion
  /v1/embeddings:
    post:
      x-zevium-cost: 2
      summary: Create embeddings
```

No separate pricing table. The OpenAPI spec IS the source of truth for:

- Upstream server URL (`servers[0].url`)
- Available endpoints (`paths`)
- Per-endpoint pricing (`x-zevium-cost` on each operation)
- Free tier (`x-zevium-free-tier`, optional) — **publisher-funded**: free-tier calls are the publisher's acquisition spend, opted in per endpoint; the platform does not subsidize them. (Extension is designed, not yet parsed by any code)

Production agent-tool pricing in the market clusters at $0.002–$0.05/call equivalents. Price guidance for publishers: **assume agent traffic dominates** — an agent will loop on the cheapest useful endpoint.

Planned pricing extensions (roadmap): tiered/graduated per-call pricing, per-token cost expressions, outcome-based pricing.

## Data model mapping

| Concept                      | DB table                                    | Notes                                        |
| ---------------------------- | ------------------------------------------- | -------------------------------------------- |
| Publisher                    | `organization`                              | An org that publishes APIs                   |
| Published API                | `project`                                   | Has `status`, `visibility`, `organizationId` |
| API spec (draft + published) | `openapi_schema` + `openapi_schema_version` | 1:1 with project                             |
| Endpoint pricing             | OpenAPI `x-zevium-cost` extension           | Lives IN the spec, not a separate table      |
| Consumer credits             | Polar meter credits                         | Org-scoped wallet (`externalId = orgId`)     |
| Consumer API keys            | `apikey` (better-auth plugin)               | One key per user, draws from org wallet      |
| Proxy call logging           | Polar `proxy_call` events                   | Ingested for billing + analytics             |
| Upstream auth secrets        | `project_secret` (encrypted)                | Built + UI'd, **not yet injected by proxy**  |
| Spec variables               | `project` variables (`%VAR%` substitution)  | Applied to exported spec only, **not proxy** |

Billing substrate constraints (verified against Polar docs): Polar never blocks usage on its own — **Zevium's Redis credit gate is the only enforcement layer** — and metered prices attach to subscription products only. Never configure a Polar metered price without a hard cap; zero balance must mean blocked call, not surprise overage.

## Proxy call flow

```
Consumer → POST /api/proxy/{orgSlug}/{projectSlug}/v1/chat/completions
                        ↓
  1. Resolve {orgSlug}/{projectSlug} → project record
  2. Load project's published OpenAPI spec
  3. Match request path → find operation in spec
  4. Read x-zevium-cost from the matched operation
  5. Resolve upstream server from spec's servers[0].url
  6. Verify API key → get userId
  7. Gate: creditedUnits - userConsumed >= cost?
  8. Reserve credits (cost)
  9. Forward to upstream server + path
 10. On 2xx: ingest proxy_call event (deduct from meter)
     On non-2xx: refund credits
 11. Platform cut + publisher share calculated from the ingested event
```

## Agent-facing surface (the differentiator)

A marketplace-wide MCP server **already exists** at `/mcp` with two tools: `search_zevium_api` (semantic search over the catalogue via embeddings + Cohere rerank — the search-then-load pattern, correct instinct) and `execute_api_call`. **Critical defect: `execute_api_call` is a raw passthrough fetch that bypasses the billing proxy — unmetered, unkeyed calls. It must route through the proxy (P0).**

Target surface:

1. **Metered MCP.** The existing `/mcp` server routes all execution through the billing proxy (key-authenticated, credit-gated). Tool surface stays compact — up to 72% of an agent's context window can be eaten by MCP tool schemas; search-then-load discovery, never one tool per endpoint dump
2. **Machine-readable discovery index.** A crawlable endpoint listing published APIs with per-endpoint pricing metadata (x402-Bazaar-compatible shape) so agents can evaluate cost before calling
3. **Agent-readable usage docs per listing** (SKILL.md pattern) — connection config tells an agent *how to connect*; usage docs tell it *how to use the API well*
4. **x402 payment rail (P1)** beside prepaid credits: agents pay per-call in stablecoins with zero signup; credits remain for humans and high-volume consumers

## Consumer experience requirements

- **Catalogue with quality signals**: search + tag filters derived from spec metadata, plus latency, success rate, and freshness badges per listing (freshness-updated listings rank higher)
- **Playground**: in-docs test console hitting real endpoints in an explicit test mode (Stripe pattern: key pasted in-page, held in browser session storage only, test mode visually loud)
- **Billing transparency** (Vercel pattern): usage dashboard with current-cycle consumption + projected cost, per-key and per-endpoint breakdown; spend alerts at 50/75/100% thresholds; signed webhooks for budget events
- **Key management** (OpenRouter pattern): per-key spend limits with daily/weekly/monthly resets and auto-disable, key CRUD API for programmatic provisioning, zero-downtime rotation (roll-key with grace period)

## Publisher experience requirements

- **Self-serve end to end**: sign up, publish spec, set pricing, go live — zero platform-team involvement. Publishing model: **auto-publish with automated gates** (spec valid, upstream reachable, uptime probe) + post-hoc staff review; violators get delisted. No pre-approval queue
- **Lifecycle safety**: a publisher cannot silently kill an API with active consumers — unpublish triggers a mandatory notice window (deprecation banner + email + `Deprecation`/`Sunset` headers per RFC 8594), new subscriptions freeze, existing calls honored through wind-down
- **Analytics that beat the dead incumbent**: per-endpoint p95/p99 latency, error-type breakdown, per-consumer usage, revenue trends. (RapidAPI shipped neither tail latencies nor error breakdowns)
- **Spec versioning**: draft → validate → publish with semver; published versions immutable
- **Payouts**: transparent 95/5 split, accumulated earnings visible in dashboard, settled on a published schedule

## Roadmap

### Now (P0 — a working, honest loop is table stakes)

1. Core loop must work: publish → public catalogue listing → key issuance → paid proxied call
2. **Close the MCP billing bypass**: route `execute_api_call` through the metered proxy
3. **Wire secrets + variables into the proxy**: upstream auth injection (secrets are built + UI'd but never loaded at call time; without this, no real authenticated upstream API can be listed)
4. Time-to-first-call < 60s, fully self-serve
5. Usage dashboard (org wallet balance, per-member/per-key/per-endpoint, projections); real activity log (page currently renders mock data)
6. Publisher analytics (calls, revenue, p95/p99, error breakdown)
7. Catalogue quality signals (latency, success rate, freshness) + semantic search for humans (embeddings exist, catalogue still uses SQL LIKE)

### Next (P1 — the agent-first bet + trust plumbing)

8. Org-scoped billing (org wallet, member keys draw from it, per-member attribution — rebuild from user-scoped, no data migration: pre-launch)
9. Metered per-project MCP + machine-readable discovery/pricing index
10. **x402 as second payment rail** (agent payments, zero signup)
11. `x-zevium-free-tier` enforcement (publisher-funded) + tiered pricing
12. Spend caps, threshold alerts, budget webhooks
13. Key-management API with zero-downtime rotation
14. **Mock/sandbox mode**: Prism-style mock server auto-generated from the spec — try the API shape free before spending credits
15. Deprecation/unpublish lifecycle (notice window, headers, consumer notifications)
16. Publisher webhooks (new consumer, usage spike, revenue milestone, abnormal-traffic alert)

### Later (P2 — cutting edge)

17. Publisher payouts (95/5, transparent)
18. Security-scan + uptime badges as listing gates; per-API status pages (component-level uptime, subscribable)
19. Version pinning per key (Stripe pattern: consumers stay on the spec version they integrated against) + spec-diff changelog tool
20. Dispute-a-call flow (200-but-garbage-response refunds, credits held pending review) + SLA tiers with automatic service credits
21. Per-token / outcome-based pricing extensions
22. Provider fallback routing across equivalent APIs

## What does NOT exist yet (or exists but is disconnected)

- **Publisher payouts**: no payout system; publisher share accumulates unsettled
- **Revenue split enforcement**: full cost currently charged to consumer; platform-cut/publisher-share calculation not implemented
- **Org-scoped billing**: credits are user-scoped today; rebuild as org-scoped (pre-launch, data disposable, no migration needed)
- **Secrets/variables in proxy**: fully built with UI, but the proxy never loads secrets nor substitutes variables at call time — zombie features until wired (P0)
- **MCP metering**: `/mcp` exists but `execute_api_call` bypasses billing (P0 fix); per-project MCP + discovery index unbuilt
- **Free tier**: `x-zevium-free-tier` appears only in this document — no code parses it
- **Activity UI**: settings page renders hardcoded mock data; audit rows exist in DB with no read API
- **Semantic search for humans**: embeddings + vector search exist but only the MCP tool uses them; catalogue is SQL LIKE
- **Spend caps/alerts/webhooks, key rotation, projections, mock mode, deprecation lifecycle, status pages, disputes**: not built
- **Emails**: only verification, password-reset, and org-invitation templates exist — no billing/usage/lifecycle notifications

## Non-goals

- Subscription plans for API access (per-call credits only; subscriptions reintroduce the billing model the market is leaving)
- Hosting publisher API backends (Zevium proxies to publisher-owned upstreams; it is not a compute platform)
- Open unmoderated long-tail listing (curation and quality gates over catalog size — the long-tail model is what killed RapidAPI)
