# Zevium product overview

> Updated: 2026-10-10 (split from former root `PRODUCT.md`, last updated 2026-08-12, and `FLOW.md` personas/golden paths)
> Product language only. Implementation lives in `../architecture/` and each feature's Tech section.
> Product rules (never violate): [AGENTS.md → Product rules](../../../AGENTS.md#product-rules-never-violate).

## What is Zevium

Zevium is an **agent-first, per-call API marketplace**. Publishers list APIs described by OpenAPI specs; consumers — human developers **and AI agents** — pay per call via prepaid credits through a metered gateway.

**The problem.** Selling API access is broken in both directions. Publishers who want to charge per call must build metering, billing, key management, and payout plumbing themselves. Consumers — increasingly AI agents — lack one curated place to discover, evaluate, and pay for APIs. Existing catalogues and agent-tool directories do not combine consistent discovery, prepaid per-call pricing, quality signals, and one metered call path.

**The bet.** Be the curated, metered place where both humans and agents discover and pay for APIs per call — and where publishing a paid API takes minutes, not a billing-infrastructure project.

**Headline consumer metric: time-to-first-call.** Signup → working key → first successful metered request must take under a minute, fully self-serve.

## Two-sided platform

| Side           | Who                                                        | Gets                                                                                        | Feature notes                                                                                                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Publishers** | Orgs selling API access; each API is a project with a spec | The spec is the product. 95% of call spend. Analytics, payouts, no billing infra to run     | [publishing-specs](../features/publishing-specs.md), [pricing](../features/pricing.md), [listing-lifecycle](../features/listing-lifecycle.md), [publisher-analytics](../features/publisher-analytics.md), [earnings-payouts](../features/earnings-payouts.md) |
| **Consumers**  | Human devs + AI agents, one billing model                  | One wallet across every API, one key, itemized charges, zero balance blocks (never overage) | [catalogue-search](../features/catalogue-search.md), [wallet-billing](../features/wallet-billing.md), [api-keys](../features/api-keys.md), [agent-surface](../features/agent-surface.md), [mock-sandbox](../features/mock-sandbox.md)                         |

Two consumer rails (decided 2026-10-10, [dual-rail decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md)):

- **Enterprise / teams** — org-scoped wallet, member API keys, prepaid top-ups, per-key caps, attribution. Built.
- **Individuals / agents** — keyless x402 payment funds an ephemeral wallet session. Planned: [machine-payments](../features/machine-payments.md).

## Personas

| Persona            | Who                                      | Primary surface                                                              |
| ------------------ | ---------------------------------------- | ---------------------------------------------------------------------------- |
| **Visitor**        | Anonymous browser                        | Landing, public catalogue, auth                                              |
| **Consumer**       | Human dev buying API calls               | Catalogue, API detail, playground, keys, wallet                              |
| **Agent**          | AI agent consuming APIs programmatically | Discovery index, agent-tool endpoint, gateway (no screens — machine surface) |
| **Publisher**      | Org member collaborating on API drafts   | Projects, spec editor, analytics, earnings                                   |
| **Org admin**      | Owner/admin of an organization           | Project/listing lifecycle, secrets, payouts, wallet, members, invitations    |
| **Platform admin** | Zevium staff                             | Moderation, quality gates, support tooling                                   |

One account can be several personas at once (a publisher is usually also a consumer). Every user belongs to at least one org (a personal org is created at signup) — the org owns the wallet.

## Revenue model

Consumer pays the price; Zevium keeps 5%, publisher earns 95%. Fee comes from the publisher side — a $10 top-up buys $10 of calls ([fee decision](../decisions/2026-10-10-platform-fee-publisher-side.md)). Card processing fees are passed through at cost as a separate, visible line on top-ups — no markup, no hidden spread ([decision](../decisions/2026-10-10-card-fee-passthrough.md)). New orgs start with ~$1 of credit ([decision](../decisions/2026-10-10-signup-credit.md)). Details, exchange rate, and in-spec pricing: [pricing](../features/pricing.md).

## Agent-facing surface (the differentiator)

1. Metered agent tooling through the same gateway as human traffic, search-then-load
2. Machine-readable discovery index with per-endpoint pricing
3. Agent-readable usage docs per listing
4. Machine-native payments (x402) beside prepaid credits

Detail: [agent-surface](../features/agent-surface.md), [machine-payments](../features/machine-payments.md).

## Supply strategy (decided 2026-10-10)

Cold start is the core risk: zero listings → zero agents → zero publishers. Zevium is its own first publisher: house listings sourced via treg, then RapidAPI for gaps, replaced one by one with direct integrations. Losses accepted for now; every source is ToS-gated. Third-party publishers join a catalogue that already has breadth. Interchangeable house listings feed [capability routing](../features/capability-routing.md). Decision: [house supply](../decisions/2026-10-10-house-supply-via-aggregators.md).

## Positioning (from 2026-10 research)

Source: [agent API marketplace landscape](../research/agent-api-marketplace-landscape.md). Research view, not commitments.

- **Moat candidates**: highest documented publisher split (95% vs Apify ~80%, RapidAPI now 25% take, big MCP directories pay authors nothing); pricing declared in the OpenAPI spec (`x-zevium-cost`) — no competitor does this; one prepaid wallet across all publishers; compact search/docs/call MCP surface.
- **Not a moat**: metering/billing/gateway plumbing — Zuplo, Kong, Cloudflare sell it. Zevium wins only by bringing demand.
- **Threats**: Stripe (owns OpenRouter, Metronome, MPP), Cloudflare Monetization Gateway (x402 paywall, same platform), Apify if it proxies third-party APIs.
- **Prior comparison**: [treg.to](../research/treg-comparison.md).

## Golden paths

### Consumer

```
Landing → Sign up (personal org auto-created) → /app onboarding checklist
  → Catalogue → API detail → Try it (mock mode or free tier)
  → Create key (copy once) → Top up wallet (checkout)
  → First real call from playground or curl   ← under 60s from signup
  → Integrate (snippet) → watch usage/spend on billing page (live)
  → set budget alerts → top up again
```

### Publisher

```
Sign up → Create org → Create project
  → Spec editor: import/paste OpenAPI → add x-zevium-cost per endpoint
  → attach upstream credentials → validate → Save draft → Publish v0.0.1
  → Make Public → automated gates pass → live in catalogue + discovery index + agent tools
  → watch Analytics tick (calls, p95, errors, revenue)
  → Earnings accrue at 95% → payout
```

## Non-goals

- Subscription plans for API access (per-call credits only; subscriptions reintroduce the billing model the market is leaving)
- Hosting publisher API backends (Zevium forwards to publisher-owned upstreams; it is not a compute platform)
- Open unmoderated long-tail listing (curation and quality gates matter more than raw catalogue size)
- House-listing LLM endpoints as Zevium-operated supply (proposed 2026-10-10, [LLM pricing decision](../decisions/2026-10-10-llm-per-token-pricing.md))
