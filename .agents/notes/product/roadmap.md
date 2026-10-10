# Roadmap and backlog

> Updated: 2026-10-10 (merged from former `PRODUCT.md` roadmap and `.project/BACKLOG.md`, backlog truth as of 2026-07-19)
> This file owns priority. Work is tracked as GitHub issues in `zevium-dev/core` (labels `P0`/`P1`/`P2`, `area:*`); `#N` below = issue number. Feature notes own detail and status. Keep both in sync in the same change.

Status legend: **built** · **partial** · **planned**. Status is set by each feature note after checking code; if this table disagrees with a feature note, the feature note wins — fix this table.

## Now — launch blockers

1. #91 #313 #314 **Publish initial production catalogue** (now via house listings, [decision](../decisions/2026-10-10-house-supply-via-aggregators.md)). Anonymous dogfood on 2026-10-10 found one public API, Markdown to HTML; initial supply is still thin. Publish 1–3 owned, reliable APIs with real upstreams, credentials, descriptions, tags, pricing, and agent-readable docs. (Landing fallback teaser cards were removed 2026-08-12, commit `85aad61`; landing now shows live listings or an empty state.) → [publishing-specs](../features/publishing-specs.md), [landing-docs](../features/landing-docs.md)
2. #315 **Prove real payment and settlement journey.** Configure staging env/secrets for the payment drill (`e2e/04-payment-drill.sh`, run in the preview E2E suite; the `payment-drill.yml` workflow named in older notes does not exist); manually run authenticated publish/call plus real Stripe Checkout, refund, and Connect settlement drill. Scheduled drills run deterministic tests only. → [wallet-billing](../features/wallet-billing.md), [earnings-payouts](../features/earnings-payouts.md)
3. #315 **Finish external production gates.** Written Stripe approval for pooled prepaid credits across independent publishers; accept platform/MoR legal and tax obligations; fix supported countries/currency; write refund, dispute, debt, risk-hold, and payout policies; complete operational runbook from [stripe-connect-discovery](../research/stripe-connect-discovery.md).

## Dogfood regressions — 2026-10-10

Baseline `eaa7eff`; [journeys, evidence and limits](../findings/dogfood-2026-10-10.md). Issues are new findings, not completed fixes.

- **P0:** #385 key issuance/deployment blocked by missing index; #389 credentialed publication blocked after passing health check. → [api-keys](../features/api-keys.md), [publishing-specs](../features/publishing-specs.md)
- **P1:** #384 broken seed; #387 local Convex blocked by CSP. → [dev-environment](../architecture/dev-environment.md)
- **P1:** #392 incorrect local discovery origin; #395 MCP query parameters fail; #396 MCP 402 loses recovery metadata. → [agent-surface](../features/agent-surface.md)
- **P1:** #393 publisher visibility webhook omitted. → [webhooks-notifications](../features/webhooks-notifications.md)
- **P2:** #386 docs main landmark; #397 app navigation/heading accessibility; #398 fractional earnings display; #399 invalid inline-price recovery. → [landing-docs](../features/landing-docs.md), [accounts-orgs](../features/accounts-orgs.md), [publisher-analytics](../features/publisher-analytics.md), [publishing-specs](../features/publishing-specs.md)

## Next — P0 product gaps

1. **Public quality signals and automated listing gates** — mostly built (probes, gates, detail-page badges). Remaining: badges on catalogue cards, admin quality dashboard with auto-delist, publisher quality view, per-API status pages, security scan. → [quality-signals](../features/quality-signals.md)
2. **Production acceptance journey** — separate publisher and consumer orgs: publish → buy credits → issue key → paid gateway call → usage ingest → 95/5 earnings → Connect transfer. Also verify keyless mock and MCP calls against same listing. → [wallet-billing](../features/wallet-billing.md)

## Codebase reset (do first) — [decision](../decisions/2026-10-10-codebase-reset.md)

1. #365 #366 Prune tooling/CI
2. #354 Delete Convex migration/rollout code
3. #359 #360 #361 Gateway restructure
4. #353 Convex rebuild (carries bugs #355–#358, #334)
5. #362 #363 #364 #367 Web fixes

## Build queue — decided 2026-10-10

Small, decided items. Each links to its decision; build in any order unless noted.

1. #316 Unpriced operations hidden + not callable; explicit `0` = free — [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)
2. **Built** #317 $1 signup credit per eligible org, once per Clerk creator (funds free-tier calls) — [decision](../decisions/2026-10-10-signup-credit.md)
3. #318 Card fee passed through at cost on top-ups (legal check first) — [decision](../decisions/2026-10-10-card-fee-passthrough.md)
4. **Built** #319 Review eligibility includes free-tier callers — [decision](../decisions/2026-10-10-review-eligibility.md)
5. #320 Email via Resend (built; dormant until owner configures verified sender + API key) — [decision](../decisions/2026-10-10-email-resend.md)
6. #321 Docs/FLOW alignment: two roles (admin, member), admin-only analytics + delivery history — [decision](../decisions/2026-10-10-two-roles-admin-member.md)

Bigger P0 items (x402 rail, distribution, capability routing, house supply, LLM per-token) are in the P0 table below.

## Product roadmap

### P0 — a working, honest loop is table stakes

| #   | Item                                                                                                                                  | Feature                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | Core loop: publish → public catalogue listing → key issuance → paid metered call                                                      | [gateway](../features/gateway.md)                                                                      |
| 2   | All agent tooling routes through metering — no unmetered side doors                                                                   | [agent-surface](../features/agent-surface.md)                                                          |
| 3   | Publisher upstream credentials attached to forwarded calls                                                                            | [upstream-credentials](../features/upstream-credentials.md)                                            |
| 4   | Time-to-first-call < 60s, fully self-serve                                                                                            | [accounts-orgs](../features/accounts-orgs.md)                                                          |
| 5   | Usage dashboard (org wallet, per-member/key/endpoint, projections) + activity log                                                     | [wallet-billing](../features/wallet-billing.md)                                                        |
| 6   | Publisher analytics (calls, revenue, p95/p99, error breakdown)                                                                        | [publisher-analytics](../features/publisher-analytics.md)                                              |
| 7   | Catalogue quality signals + semantic search                                                                                           | [quality-signals](../features/quality-signals.md), [catalogue-search](../features/catalogue-search.md) |
| 7a  | #109 x402 keyless rail: x402/MPP via Stripe funds ephemeral wallet sessions (from P1 #10, 2026-10-10)                                 | [machine-payments](../features/machine-payments.md)                                                    |
| 7b  | #322–#326 Agent distribution: `llms.txt`, OAuth on `/mcp`, Claude Connectors Directory, MCP Registry, one-click installs (2026-10-10) | [agent-surface](../features/agent-surface.md)                                                          |
| 7c  | #327 #328 Capability routing across interchangeable providers, fallback, max cost (from P2 #22, 2026-10-10)                           | [capability-routing](../features/capability-routing.md)                                                |
| 7d  | #313 #314 House listings seeded via treg / RapidAPI, ToS-gated, losses accepted (2026-10-10)                                          | [publishing-specs](../features/publishing-specs.md)                                                    |

### P1 — the agent-first bet + trust plumbing

| #   | Item                                                             | Feature                                                         |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| 8   | Org-scoped wallets                                               | [wallet-billing](../features/wallet-billing.md)                 |
| 9   | Per-API agent tooling + machine-readable discovery/pricing index | [agent-surface](../features/agent-surface.md)                   |
| 10  | ~~x402 machine-native payments~~ → moved to P0 #7a on 2026-10-10 | [machine-payments](../features/machine-payments.md)             |
| 11  | Free tier enforcement (publisher-funded) + tiered pricing        | [pricing](../features/pricing.md)                               |
| 12  | Spend caps, threshold alerts, budget webhooks                    | [wallet-billing](../features/wallet-billing.md)                 |
| 13  | Key-management API with zero-downtime rotation                   | [api-keys](../features/api-keys.md)                             |
| 14  | Mock/sandbox mode                                                | [mock-sandbox](../features/mock-sandbox.md)                     |
| 15  | Deprecation/unpublish lifecycle                                  | [listing-lifecycle](../features/listing-lifecycle.md)           |
| 16  | Publisher webhooks                                               | [webhooks-notifications](../features/webhooks-notifications.md) |

### P2 — cutting edge

| #   | Item                                                                                                                                  | Feature                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 17  | Publisher payouts (95/5, transparent)                                                                                                 | [earnings-payouts](../features/earnings-payouts.md)     |
| 18  | Security-scan + uptime badges as listing gates; per-API status pages                                                                  | [quality-signals](../features/quality-signals.md)       |
| 19  | Version pinning per key + spec-diff changelog                                                                                         | [listing-lifecycle](../features/listing-lifecycle.md)   |
| 20  | Dispute-a-call flow (successful-but-garbage-response refunds, credits held pending review) + SLA tiers with automatic service credits | [wallet-billing](../features/wallet-billing.md)         |
| 21  | Outcome-based pricing extensions (per-token shipped in #329)                                                                          | [pricing](../features/pricing.md)                       |
| 22  | ~~Provider fallback routing~~ → moved to P0 #7c on 2026-10-10                                                                         | [capability-routing](../features/capability-routing.md) |
| —   | Verified reviews                                                                                                                      | [reviews](../features/reviews.md)                       |
| —   | Generated SDKs                                                                                                                        | [landing-docs](../features/landing-docs.md)             |

Several P1/P2 items shipped ahead of their tag (payouts via Stripe Connect, mock mode, webhooks, free-tier enforcement, verified reviews). Feature notes carry the real status.

## Reprioritization (2026-10-10)

Decision: [P0 agent bet](../decisions/2026-10-10-p0-agent-bet.md), [house supply](../decisions/2026-10-10-house-supply-via-aggregators.md). Source: [research](../research/agent-api-marketplace-landscape.md), [session](../sessions/2026-10-10-competitive-research-and-docs.md).

- **Accepted → P0**: x402 keyless rail, agent distribution, capability routing, house supply via aggregators
- **Not approved**: infra freeze
- **Superseded**: single launch vertical — replaced by aggregator-sourced breadth
- **Built #329 (P0)**: per-token pricing for LLM-wrapping APIs; hold then settle observed usage. [Decision](../decisions/2026-10-10-llm-per-token-pricing.md). Outcome-based pricing remains #21.

## Later

- Per-listing MCP tool surfaces beyond current global search/load/call tools

## Recently completed (removed from active backlog)

- New-user org handling: Clerk auto-org creation plus `/app/org/create` guard
- Landing count, credit pluralization, try-it key link, app Docs navigation, notification destinations
- Browser-fetch paid-call and anonymous mock E2E coverage
- Payout notification kinds
- Production CI deployment from green `develop`
