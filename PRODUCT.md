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

- Pre-pay for credits (Polar meter credits, user-scoped)
- Each call deducts credits based on the endpoint's price
- API keys are user-scoped (one key per user), rate-limited, with per-key spend limits

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
- Free tier (`x-zevium-free-tier`, optional)

Production agent-tool pricing in the market clusters at $0.002–$0.05/call equivalents. Price guidance for publishers: **assume agent traffic dominates** — an agent will loop on the cheapest useful endpoint.

Planned pricing extensions (roadmap): tiered/graduated per-call pricing, per-token cost expressions, outcome-based pricing.

## Data model mapping

| Concept                      | DB table                                    | Notes                                        |
| ---------------------------- | ------------------------------------------- | -------------------------------------------- |
| Publisher                    | `organization`                              | An org that publishes APIs                   |
| Published API                | `project`                                   | Has `status`, `visibility`, `organizationId` |
| API spec (draft + published) | `openapi_schema` + `openapi_schema_version` | 1:1 with project                             |
| Endpoint pricing             | OpenAPI `x-zevium-cost` extension           | Lives IN the spec, not a separate table      |
| Consumer credits             | Polar meter credits                         | User-scoped, prepaid via Polar checkout      |
| Consumer API keys            | `apikey` (better-auth plugin)               | User-scoped, one key per user                |
| Proxy call logging           | Polar `proxy_call` events                   | Ingested for billing + analytics             |

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

Every published project is consumable by AI agents, not just human integrators:

1. **Auto-generated MCP server per project.** Derived from the OpenAPI spec, served through the same metered proxy and billed with the same credits. Tool surface must stay compact — up to 72% of an agent's context window can be eaten by MCP tool schemas, so expose curated search-then-load tool discovery, never one tool per endpoint dump
2. **Machine-readable discovery index.** A crawlable endpoint listing published APIs with per-endpoint pricing metadata (x402-Bazaar-compatible shape) so agents can evaluate cost before calling
3. **Agent-readable usage docs per listing** (SKILL.md pattern) — connection config tells an agent *how to connect*; usage docs tell it *how to use the API well*
4. **(Later) x402 payment rail** beside prepaid credits: agents pay per-call in stablecoins with zero signup; credits remain for humans and high-volume consumers

## Consumer experience requirements

- **Catalogue with quality signals**: search + tag filters derived from spec metadata, plus latency, success rate, and freshness badges per listing (freshness-updated listings rank higher)
- **Playground**: in-docs test console hitting real endpoints in an explicit test mode (Stripe pattern: key pasted in-page, held in browser session storage only, test mode visually loud)
- **Billing transparency** (Vercel pattern): usage dashboard with current-cycle consumption + projected cost, per-key and per-endpoint breakdown; spend alerts at 50/75/100% thresholds; signed webhooks for budget events
- **Key management** (OpenRouter pattern): per-key spend limits with daily/weekly/monthly resets and auto-disable, key CRUD API for programmatic provisioning, zero-downtime rotation (roll-key with grace period)

## Publisher experience requirements

- **Self-serve end to end**: sign up, publish spec, set pricing, go live — zero platform-team involvement
- **Analytics that beat the dead incumbent**: per-endpoint p95/p99 latency, error-type breakdown, per-consumer usage, revenue trends. (RapidAPI shipped neither tail latencies nor error breakdowns)
- **Spec versioning**: draft → validate → publish with semver; published versions immutable
- **Payouts**: transparent 95/5 split, accumulated earnings visible in dashboard, settled on a published schedule

## Roadmap

### Now (P0 — a working loop is table stakes)

1. Core loop must work: publish → public catalogue listing → key issuance → paid proxied call
2. Time-to-first-call < 60s, fully self-serve
3. Consumer usage dashboard (balance, per-key, per-endpoint, projections)
4. Publisher analytics (calls, revenue, p95/p99, error breakdown)
5. Catalogue quality signals (latency, success rate, freshness)

### Next (P1 — the agent-first bet)

6. MCP gateway per project (auto-generated from spec, metered via existing proxy)
7. Machine-readable discovery/pricing index for agents
8. `x-zevium-free-tier` enforcement + tiered pricing
9. Spend caps, threshold alerts, budget webhooks
10. Key-management API with rotation

### Later (P2 — cutting edge)

11. x402 as second payment rail (agent payments, zero signup)
12. Publisher payouts (95/5, transparent)
13. Security-scan + uptime badges as listing gates
14. Per-token / outcome-based pricing extensions
15. Provider fallback routing across equivalent APIs

## What does NOT exist yet

- **Publisher payouts**: no payout system; publisher share accumulates unsettled
- **Revenue split enforcement**: full cost currently charged to consumer; platform-cut/publisher-share calculation not implemented
- **MCP gateway, discovery index, agent docs**: designed above, unbuilt
- **Free tier**: `x-zevium-free-tier` is spec'd but not enforced by the proxy
- **Spend caps/alerts/webhooks, key rotation, projections**: not built
- **x402 rail, security scanning, fallback routing**: future work

## Non-goals

- Subscription plans for API access (per-call credits only; subscriptions reintroduce the billing model the market is leaving)
- Hosting publisher API backends (Zevium proxies to publisher-owned upstreams; it is not a compute platform)
- Open unmoderated long-tail listing (curation and quality gates over catalog size — the long-tail model is what killed RapidAPI)
