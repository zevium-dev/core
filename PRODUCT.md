# Zevium Product Specification

> Last updated: 2026-07-11
> Companions: [FLOW.md](FLOW.md) (screens), [DESIGN.md](DESIGN.md) (feel), [TECH.md](TECH.md) (implementation). Market research: [docs/product-discovery-2026.md](docs/product-discovery-2026.md).
> This doc describes **what Zevium is and what it solves** — no implementation details.

## What is Zevium

Zevium is an **agent-first, per-call API marketplace**. Publishers list APIs described by OpenAPI specs; consumers — human developers **and AI agents** — pay per call via prepaid credits through a metered gateway.

**The problem.** Selling API access is broken in both directions. Publishers who want to charge per call must build metering, billing, key management, and payout plumbing themselves. Consumers — increasingly AI agents — have no trustworthy place to discover, evaluate, and pay for APIs: the incumbent horizontal marketplace collapsed (RapidAPI, sold for parts in 2024), and the agent-tool ecosystem that replaced the demand is a mess of thousands of broken, unmetered, insecure community servers with no payment layer at all.

**The bet.** Be the curated, metered, secured place where both humans and agents discover and pay for APIs per call — and where publishing a paid API takes minutes, not a billing-infrastructure project.

## Two-sided platform

### Publishers (API sellers)

- Organizations publish APIs; each API is a project with an OpenAPI spec
- **The spec is the product**: upstream address, endpoints, per-endpoint pricing, and free tier all live in the spec — no separate pricing configuration
- Publishers earn revenue when consumers call their endpoints; earnings accumulate toward payouts
- Listing quality is enforced: uptime monitoring and (later) security scanning gate what stays listed

### Consumers (API buyers)

Two consumer types, one billing model:

1. **Human developers** — browse the catalogue, get a key, test in the playground, integrate
2. **AI agents** — discover APIs through Zevium's machine-readable index and consume them as agent tools through the same metered gateway

Both:

- Pre-pay for credits — **org-scoped**: the organization owns the wallet, member keys draw from it, admins see per-member and per-key attribution. Solo devs get a personal org automatically; there is no separate personal-wallet model
- Each call deducts credits based on the endpoint's price
- API keys belong to a member (one key per user), are rate-limited, and carry per-key spend limits against the org wallet
- **Zero balance blocks the call.** Never a surprise overage

**Headline consumer metric: time-to-first-call.** Signup → working key → first successful metered request must take under a minute, fully self-serve.

## Revenue model

```
Consumer pays:     100 credits / call
Zevium takes:        5 credits (5% platform cut)
Publisher earns:    95 credits (95% revenue share)
```

- **Publishers keep 95%.** 20-30% take rates made horizontal marketplaces economically unsustainable for high-volume AI workloads. Market benchmarks: Apify keeps 20%, MCPize 15%, AWS Marketplace ~3-5%. At 5%, Zevium matches cloud-marketplace economics while offering full marketplace features — the strongest possible publisher acquisition pitch
- **Exchange rate: $1 = 10,000 credits** (1 credit = $0.0001). Market per-call pricing of $0.002–$0.05 maps to 20–500 credits. Rate is a launch default, revisitable — but one global constant, never per-API
- Credits are prepaid by consumer organizations via one-time top-up purchases
- Platform cut + publisher share are calculated per call at charge time
- Publisher earnings accumulate and are settled via payouts (see roadmap)

## How pricing works

Pricing is declared **in the OpenAPI spec** as vendor extensions on each path/operation:

```yaml
openapi: 3.1.0
info:
  title: OpenAI GPT API
servers:
  - url: https://api.openai.com
paths:
  /v1/chat/completions:
    post:
      x-zevium-cost: 10 # credits per call
      x-zevium-free-tier: 5 # optional: free calls per day
      summary: Chat completion
  /v1/embeddings:
    post:
      x-zevium-cost: 2
      summary: Create embeddings
```

The spec is the single source of truth for:

- Upstream address (`servers[0].url`)
- Available endpoints (`paths`)
- Per-endpoint pricing (`x-zevium-cost` on each operation)
- Free tier (`x-zevium-free-tier`, optional) — **publisher-funded**: free-tier calls are the publisher's acquisition spend, opted in per endpoint; the platform does not subsidize them

Pricing guidance for publishers: production agent-tool pricing clusters at $0.002–$0.05/call equivalents, and **agent traffic dominates** — an agent will loop on the cheapest useful endpoint, so price for machine volume, not human volume.

Planned pricing extensions (roadmap): tiered/graduated per-call pricing, per-token cost expressions, outcome-based pricing.

## What happens on a call

A consumer (human code or agent) calls a Zevium gateway URL for a published API. Zevium:

1. Identifies the API and the exact endpoint being called, and its price
2. Authenticates the caller's API key and resolves their org wallet
3. Checks the wallet covers the price — insufficient balance means the call is refused up front
4. Reserves the credits, forwards the request to the publisher's upstream (attaching the publisher's upstream credentials on their behalf), and streams the response back
5. On success: the charge settles — 95% to the publisher, 5% to the platform. On upstream failure: the reservation is refunded, the consumer pays nothing

Consumers see: one gateway URL per API, one key, one wallet, itemized charges. Publishers see: calls, revenue, and performance per endpoint — without running any billing infrastructure.

## Agent-facing surface (the differentiator)

1. **Metered agent tooling.** Every published API is consumable as agent tools through the same key-authenticated, credit-gated gateway as human traffic. Tool discovery is search-then-load (an agent searches the catalogue semantically, then loads only the tools it needs) — never a dump of every endpoint into the agent's context
2. **Machine-readable discovery index.** A crawlable index of published APIs with per-endpoint pricing metadata, so agents can evaluate cost before calling
3. **Agent-readable usage docs per listing** — connection config tells an agent _how to connect_; usage docs tell it _how to use the API well_
4. **Machine-native payments (x402)** beside prepaid credits: agents pay per-call with zero signup; credits remain for humans and high-volume consumers

## Consumer experience requirements

- **Catalogue with quality signals**: semantic search + tag filters derived from spec metadata, plus latency, success rate, and freshness badges per listing (recently-updated listings rank higher)
- **Playground**: in-docs test console. A playground call is a normal metered call — free when it costs nothing (mock mode generated from the spec, or the publisher's free tier covers it), charged like any other call when it hits a paid upstream. No special playground billing
- **Billing transparency**: usage dashboard with current-cycle consumption + projected cost, per-key and per-endpoint breakdown; spend alerts at 50/75/100% thresholds; budget webhooks
- **Key management**: per-key spend limits with daily/weekly/monthly resets and auto-disable, programmatic key provisioning, zero-downtime rotation (roll-key with grace period)

## Publisher experience requirements

- **Self-serve end to end**: sign up, publish spec, set pricing, go live — zero platform-team involvement. Publishing model: **auto-publish with automated gates** (spec valid, upstream reachable, uptime probe) + post-hoc staff review; violators get delisted. No pre-approval queue
- **Lifecycle safety**: a publisher cannot silently kill an API with active consumers — unpublish triggers a mandatory notice window (deprecation notices to consumers, standard deprecation signaling on responses), new subscriptions freeze, existing calls honored through wind-down
- **Analytics that beat the dead incumbent**: per-endpoint tail latency (p95/p99), error-type breakdown, per-consumer usage, revenue trends
- **Spec versioning**: draft → validate → publish with semver; published versions immutable
- **Payouts**: transparent 95/5 split, accumulated earnings visible in dashboard, settled on a published schedule

## Roadmap

### Now (P0 — a working, honest loop is table stakes)

1. Core loop: publish → public catalogue listing → key issuance → paid metered call
2. All agent tooling routes through metering — no unmetered side doors
3. Publisher upstream credentials attached to forwarded calls (without this, no real authenticated API can be listed)
4. Time-to-first-call < 60s, fully self-serve
5. Usage dashboard (org wallet balance, per-member/per-key/per-endpoint, projections) + real activity log
6. Publisher analytics (calls, revenue, p95/p99, error breakdown)
7. Catalogue quality signals (latency, success rate, freshness) + semantic search

### Next (P1 — the agent-first bet + trust plumbing)

8. Org-scoped wallets (member keys draw from org balance, per-member attribution)
9. Per-API agent tooling + machine-readable discovery/pricing index
10. x402 machine-native payments as second rail
11. Free tier enforcement (publisher-funded) + tiered pricing
12. Spend caps, threshold alerts, budget webhooks
13. Key-management API with zero-downtime rotation
14. Mock/sandbox mode: free spec-generated mock endpoints — try the API shape before spending credits
15. Deprecation/unpublish lifecycle (notice window, response signaling, consumer notifications)
16. Publisher webhooks (new consumer, usage spike, revenue milestone, abnormal-traffic alert)

### Later (P2 — cutting edge)

17. Publisher payouts (95/5, transparent)
18. Security-scan + uptime badges as listing gates; per-API status pages (component-level uptime, subscribable)
19. Version pinning per key (consumers stay on the spec version they integrated against) + spec-diff changelog tool
20. Dispute-a-call flow (successful-but-garbage-response refunds, credits held pending review) + SLA tiers with automatic service credits
21. Per-token / outcome-based pricing extensions
22. Provider fallback routing across equivalent APIs

## Non-goals

- Subscription plans for API access (per-call credits only; subscriptions reintroduce the billing model the market is leaving)
- Hosting publisher API backends (Zevium forwards to publisher-owned upstreams; it is not a compute platform)
- Open unmoderated long-tail listing (curation and quality gates over catalog size — the long-tail model is what killed RapidAPI)
