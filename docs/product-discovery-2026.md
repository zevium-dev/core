# Zevium Product Discovery Report — 2025-2026 Market

> Generated 2026-07-11 via multi-agent web research (30 sources fetched, 108 claims extracted, adversarially verified 3-vote-per-claim against primary sources). Confidence markers: claims quoted from primary sources (vendor docs/press releases) were verified verbatim; contested or killed claims are noted inline.

## 1. Market state: the throne is empty

**RapidAPI collapsed as the horizontal marketplace.** Peak: $1B valuation (Series D, Mar 2022), ~4M developers, ~40k APIs. Decline: founder-CEO Iddo Gino out Apr 2023, 82% staff cut across layoff rounds, active users down to "thousands" and APIs to "hundreds" by late 2024 (TechCrunch, confirmed against Nokia's own press release). Nokia acquired the technology + R&D unit (asset deal, not the company) in Nov 2024 for an undisclosed price — analysts infer well below ~$100M via stock-disclosure-threshold logic (Light Reading; never confirmed). Nokia's stated purpose: fold the tech into "Network as Code" for telco 5G API monetization. The public hub's future is ambiguous with reduced investment; the general-purpose API marketplace slot is effectively **vacated**.

Sources: [TechCrunch](https://techcrunch.com/2024/11/13/nokia-acquires-rapid-the-api-company-once-valued-at-1b/), [Rethink Research](https://rethinkresearch.biz/articles/nokia-makes-its-api-call-buys-rapid-nets-marketplace/), Nokia newsroom.

### Survivors and their strategies

| Player           | Model                                                     | Take rate                | Status                                                     |
| ---------------- | --------------------------------------------------------- | ------------------------ | ---------------------------------------------------------- |
| APILayer (Idera) | Curated, ~178 APIs, mostly first-party                    | ~15% historically        | Alive; only **4 AI/ML APIs** — asleep on the agent wave    |
| Zyla API Hub     | 8-10k APIs, unified key, 7-day trials, **MCP-compatible** | ~20%, 99.8% uptime floor | Alive, closest RapidAPI heir                               |
| AWS Marketplace  | Enterprise, consolidated billing                          | ~3-5% markup             | Alive, weak discovery UX                                   |
| Blobr            | "Shopify for APIs" portals, €5M seed 2023                 | —                        | **Dead** — pivoted to Google Ads AI agents                 |
| Kong Konnect     | Gateway, no public catalog                                | —                        | Added MCP Registry + prepaid-credits billing (GA Jul 2026) |
| Postman          | API network, zero monetization                            | —                        | Not a marketplace threat                                   |

**What killed RapidAPI:** 20-30% take rate (compounds brutally on high-volume AI workloads), unverified long-tail listings, proxy latency complaints, weak analytics (no error-type breakdown, no p95/p99). Lesson: **curation + quality signals + low take beat catalog size**.

**Market tailwind:** global API management market projected $8.77B (2026) → $37.4B (2034), 21.7% CAGR (Fortune Business Insights). Pricing industry-wide has shifted from flat-rate to usage-based metered pay-as-you-go — Zevium's model is where the market is heading, not a contrarian bet.

## 2. Cutting edge: agents are the new consumers

### MCP ate the world

- 97M monthly SDK downloads by early 2026 (from ~2M at Nov 2024 launch); 10k+ public servers indexed
- Donated to Linux Foundation's Agentic AI Foundation Dec 2025; OpenAI, Google, Microsoft, AWS aboard
- Supply side is garbage: most servers broken/abandoned; **53% use static API keys; 1,800+ publicly exposed with zero auth**
- Discovery fragmented across community directories (mcp.so, Smithery, PulseMCP)
- The MCP spec **contains no payment or metering primitives** — monetization explicitly left to third-party layers

A curated, authenticated, and metered MCP layer is an open goal, and it is exactly the shape of Zevium's existing proxy + credits architecture.

Design constraint: **up to 72% of an agent's context window can be consumed by MCP tool schemas alone**. An MCP gateway must expose a compact, curated tool surface (e.g. search-then-load tool discovery), not dump every endpoint of every spec as a tool.

### x402 machine payments went institutional

- Created by Coinbase; revives HTTP 402: server responds 402 + payment instructions, client pays USDC via signed header, facilitator settles (~2s), sub-cent granularity. CDP facilitator: 1,000 free tx/month then $0.001/tx (all verified against Coinbase docs)
- Governance moved to the x402 Foundation under the Linux Foundation (Apr 2026) with Google, Visa, Mastercard, Stripe, AWS as members; 100M+ transactions on Base — no longer a single-vendor bet
- **x402 Bazaar** (Sept 2025): "search engine for agents" — agents discover, call, and pay APIs with no keys, no signup, no prepaid credits. Coinbase itself names **discovery as x402's biggest adoption barrier** — marketplaces are the missing layer
- Stripe shipped fiat-rail **Machine Payments Protocol** Mar 2026 (session-based aggregated billing) alongside its **Agentic Commerce Protocol** (agent discovery/checkout). Card rails can't do sub-dollar (percentage + fixed fee kills unit economics); machine rails can
- Adjacent rails exist for multi-protocol agents: Google A2A, AP2; payment layers like Nevermined support x402 + A2A + MCP + AP2 simultaneously with usage/outcome/value-based pricing

Threat if ignored, rail if adopted: direct overlap with Zevium's metered-proxy model.

### Billing infra consolidated on prepaid credits

- Stripe acquired Metronome (~$1B, Jan 2026); Kong acquired OpenMeter (Sept 2025)
- **Kong Konnect prepaid credits** (GA Jul 2026, verified verbatim): three wallet funding types (promotional / invoiced / externally-settled), automatic drawdown priority (promotional first, then earliest expiry), two exhaustion modes (credits-only with block-or-go-negative, or credits-then-invoice-overage). Explicitly positioned as protection against unpredictable AI token spend
- **OpenMeter** (Apache 2.0): real-time edge gating, prepaid wallets, auto-refill, low-balance alerts; plans/credits/usage/commitments
- **Polar** (Zevium's substrate, all verified verbatim from docs):
  - Credit packs sell as one-time products and stack onto balance — matches Zevium's top-up model
  - Credits drain first; metered price kicks in only at zero (optional)
  - Per-meter isolated balances
  - **Metered prices attach to subscription products only** — structural constraint
  - **"Enforcement is yours"** — Polar never blocks usage at zero balance; if a metered price is configured, zero balance means **overage charges**, not a hard stop. Zevium's Redis gate is the only enforcement layer; keep it strict and never attach a metered price without a cap
  - Polar self-describes usage-based billing as new/evolving — maturity risk, monitor

### Pricing reality

- Production agent-tool pricing clusters at **$0.002-$0.05/call** (Apify scrapers, Ref search at $0.009)
- Practitioner rule: _"price as if 80% of calls come from agents — an agent will always find the cheapest thing to loop on"_
- Take-rate benchmarks: **Apify keeps 20%** (pays devs 80%, $4M+ paid out), MCPize keeps 15%, self-host ≈3% after Stripe fees
- Zevium's planned 30% cut is above market. 15-20% is the bar; "publishers keep 80%" is the marketing headline that works (Apify precedent)

## 3. Must-have features

### Publisher side

- Self-serve onboarding, zero engineering contact — "billing is table stakes; the real question is: can partners sign up, subscribe, and start building without your engineering team?"
- Spec management with versioning (Stripe-Version header = canonical pattern). Zevium's draft/publish flow is good bones. Precedent for spec-as-runtime: Zuplo's OpenAPI Runtime executes specs directly at the gateway — same architecture direction as Zevium's spec-driven proxy
- Multi-model pricing: per-call, tiered/graduated, credit packs, volume, free tier (`x-zevium-free-tier` is spec'd but unbuilt). Apiable ships nine models; six is the minimum bar
- Analytics that beat dead RapidAPI: per-endpoint p95/p99 latency, error-type breakdown, per-consumer usage, revenue trends/churn
- Payouts with a transparent take rate
- Uptime enforcement as a listing quality gate (Zyla: 99.8% floor)

### Consumer side

- **Time-to-first-call** as the headline onboarding metric: working key in seconds, no ticket
- One key across all marketplace APIs (Zyla pattern; Zevium's one-key-per-user already matches)
- In-docs playground hitting real test mode
- Usage dashboard: current cycle + **projected** cost, per-key and per-endpoint breakdown
- Spend alerts at 50/75/100% thresholds + signed webhooks + per-key caps with auto-disable
- Reviews, success-rate and latency badges in the catalogue; ranking rewards freshness (listings updated monthly rank higher across storefronts)

### Agent side (the differentiator)

- Every published project auto-exposed as an MCP server generated from its OpenAPI spec, metered through the existing proxy
- Machine-readable pricing metadata (x402 Bazaar discovery-spec pattern) so agents see cost before calling
- Security-scan badge per listing (Agensi runs an 8-point scan; the 53%-static-key MCP ecosystem makes this cheap differentiation)
- Agent-readable usage docs per listing (SKILL.md pattern complementing MCP connection config)

## 4. UX patterns to steal

- **Stripe docs**: three-column layout (nav / prose / runnable code), hover-sync between prose and code, paste-test-key-and-run with the key held in browser session storage only, visually loud test mode. Benchmark for Zevium's API detail + explorer pages (Scalar gets partway)
- **OpenRouter keys** (verified verbatim): management keys separated from inference keys (management keys cannot call completion endpoints), full key CRUD under `/api/v1/keys`, per-key credit `limit` with `limit_reset` daily/weekly/monthly at UTC midnight, auto-disable on exceed. Top documented use case: SaaS apps provisioning a unique key per customer. Blueprint for Zevium's `user-key` RPC evolution
- **Vercel spend management** (verified verbatim): three actions at cap (notify / webhook / pause-all), tiered alerts 50/75/100% + SMS, signed webhook payloads (`budgetAmount`, `currentSpend`, `thresholdPercent`), honest docs about enforcement lag (checks run "every few minutes" — set cap below true max). Zevium's Redis gate is real-time and therefore _stronger_ — market that
- **HuggingFace cards**: structured metadata drives hub-wide filters + rich detail pages. Zevium analog: derive tags/cost/latency filters straight from the OpenAPI spec — spec-as-source-of-truth is already the architecture
- **RapidAPI baseline** (the bar to beat): search/filter by category, pricing, popularity, success rate, latency; per-listing docs, test console, reviews, one-key subscribe

## 5. Prioritized build list

### P0 — unbreak the loop (table stakes)

1. Fix the two bugs blocking the core loop: `project.update` embedding INSERT vs `project_id UNIQUE` (kills make-public → catalogue permanently empty) and Better Auth server-only props in `userKey.create` (kills key issuance). A marketplace with zero public APIs and zero issuable keys is a landing page
2. Time-to-first-call < 60s: signup → key → playground call
3. Consumer usage dashboard: balance, per-key, per-endpoint, projections
4. Publisher analytics: calls, revenue, p95/p99, error breakdown
5. Catalogue quality signals: latency, success rate, freshness ranking

### P1 — differentiate (the bet)

6. **MCP gateway per project, auto-generated from the OpenAPI spec, metered through the existing proxy.** Biggest open gap in the market: 10k broken insecure free MCP servers, zero curated metered alternative, MCP has no native billing. Zevium's proxy + credits + spec-first architecture is already 80% of this
7. Machine-readable discovery index (pricing-metadata endpoint agents can crawl; Bazaar-spec-compatible shape)
8. `x-zevium-free-tier` + tiered pricing models
9. Spend caps, threshold alerts, webhooks (Vercel pattern)
10. OpenRouter-style key-management API, including zero-downtime key rotation (roll-key with grace period for the old key)

### P2 — cutting edge

11. x402 as a second payment rail beside prepaid credits — agents pay per-call with zero signup; credits remain for humans/high-volume
12. Publisher payouts, take rate ≤20% ("publishers keep 80%" headline; Apify precedent)
13. Security-scan + uptime badges as listing gates
14. Per-token / outcome-based pricing extensions to `x-zevium-cost`
15. Provider fallback routing across equivalent APIs (table-stakes expectation buyers now list alongside unified billing and cost alerts)

## Positioning

**"Agent-first API marketplace."** The RapidAPI slot is vacant, incumbents are asleep on AI (APILayer: 4 AI/ML APIs), MCP supply is insecure garbage, and x402 lacks a discovery layer. Zevium sits at the exact intersection: curated + metered + agent-consumable. The window is open now, not forever — Zyla already ships MCP compatibility and Kong ships prepaid credits.

## Verification caveats

- Killed in adversarial verification (do not cite): "RapidAPI still hosts 80k APIs" (competitor blog, contradicted — peak was 40k); "marketplace continues independently under Rapid" (overreach); "x402 maintained by Coinbase" (governance is Linux Foundation since Apr 2026); Polar's "only pay again when you top up" (marketing copy — overage charges apply when a metered price is configured)
- Contested: the sub-$100M Nokia deal price is analyst inference from disclosure thresholds (Light Reading), never confirmed
- Softer sources: MCP growth stats and marketplace surveys come from vendor/community blogs — directionally solid, exact numbers approximate
