# Roadmap and backlog

> Updated: 2026-10-11 (owner decisions; existing implementation status retained)
> This file owns priority. Work is tracked as GitHub issues in `zevium-dev/core` (labels `P0`/`P1`/`P2`, `area:*`); `#N` below = issue number. Feature notes own detail and status. Keep both in sync in the same change.

Status legend: **built** · **partial** · **planned**. Status is set by each feature note after checking code; if this table disagrees with a feature note, the feature note wins — fix this table.

## Now — launch blockers

1. #91 #313 #314 **Publish initial production catalogue** (now via house listings, [accounting/source decision](../decisions/2026-10-11-house-listing-accounting.md)). Anonymous dogfood on 2026-10-10 found one public API, Markdown to HTML; initial supply is still thin. Publish 1–3 owned, reliable APIs with real upstreams, credentials, descriptions, tags, pricing, and agent-readable docs. (Landing fallback teaser cards were removed 2026-08-12, commit `85aad61`; landing now shows live listings or an empty state.) → [publishing-specs](../features/publishing-specs.md), [landing-docs](../features/landing-docs.md)
2. #315 **Prove real payment and settlement journey.** Configure staging env/secrets for the payment drill (`e2e/04-payment-drill.sh`, run in the preview E2E suite; the `payment-drill.yml` workflow named in older notes does not exist); manually run authenticated publish/call plus real Stripe Checkout, refund, and Connect settlement drill. Scheduled drills run deterministic tests only. → [wallet-billing](../features/wallet-billing.md), [earnings-payouts](../features/earnings-payouts.md)
3. #315 **Finish external production gates.** Written Stripe approval for pooled prepaid credits across independent publishers; accept platform/MoR legal and tax obligations; fix supported countries/currency; write refund, dispute, debt, risk-hold, and payout policies; complete operational runbook from [stripe-connect-discovery](../research/stripe-connect-discovery.md).

## Dogfood regressions — 2026-10-10

Round 2 on `75633792`: [verification, new issues and limits](../findings/dogfood-2026-10-10-round-2.md). Ten requested round-one findings passed; #396 reopened for incomplete monthly-cap recovery. #385 was excluded from standalone re-verification. New work:

- **P1 #417 (implemented):** recovery actions now target the configured local/preview/production web origin. → [agent-surface](../features/agent-surface.md)
- **P2 #416:** organization creation leaves notifications in a persistent authentication error. → [webhooks-notifications](../features/webhooks-notifications.md)

The original baseline findings below are historical; use the round-two report for their current retest status.

Baseline `eaa7eff`; [journeys, evidence and limits](../findings/dogfood-2026-10-10.md). Issues are new findings, not completed fixes.

- **P0:** #385 key issuance/deployment blocked by missing index; #389 credentialed publication blocked after passing health check. → [api-keys](../features/api-keys.md), [publishing-specs](../features/publishing-specs.md)
- **P1:** #384 broken seed; #387 local Convex blocked by CSP. → [dev-environment](../architecture/dev-environment.md)
- **P1:** #392 incorrect local discovery origin; #395 MCP query parameters fail; #396 MCP 402 loses recovery metadata. → [agent-surface](../features/agent-surface.md)
- **P1:** #393 publisher visibility webhook omitted. → [webhooks-notifications](../features/webhooks-notifications.md)
- **P2:** #386 docs main landmark; #397 app navigation/heading accessibility; #398 fractional earnings display; #399 invalid inline-price recovery. → [landing-docs](../features/landing-docs.md), [accounts-orgs](../features/accounts-orgs.md), [publisher-analytics](../features/publisher-analytics.md), [publishing-specs](../features/publishing-specs.md)

## Next — P0 product gaps

1. **Public quality signals and automated listing gates** — mostly built (probes, gates, detail-page badges; catalogue card badges + publisher quality view #331). Remaining: admin quality dashboard with auto-delist, per-API status pages, security scan. → [quality-signals](../features/quality-signals.md)
2. **Production acceptance journey** — separate publisher and consumer orgs: publish → buy credits → issue key → paid gateway call → usage ingest → 95/5 earnings → Connect transfer. Also verify keyless mock and MCP calls against same listing. → [wallet-billing](../features/wallet-billing.md)

## Codebase reset (do first) — [decision](../decisions/2026-10-10-codebase-reset.md)

1. #365 #366 Prune tooling/CI
2. #354 Delete Convex migration/rollout code
3. #359 #360 #361 Gateway restructure
4. #353 Convex rebuild — PR 7 root cutover implemented; local/browser/CI evidence and owner-only activation tracked in [runbook](../architecture/convex-activation.md). No shared deployment performed. Rebuild (carries bugs #355–#358, #334); fold in P0 #430 traceable dust-lot merge, 32-slice bound, accepted DO authority/freeze-drain, daily risk release and anonymous breakage recognition — [decisions](../sessions/2026-10-11-owner-decisions.md)
5. #362 #363 #364 #367 Web fixes

## Build queue — updated 2026-10-11

- **P1 #440:** isolate payment `needs_review` locks to the affected original sources and reopen unrelated wallet funds; current whole-wallet freeze is pending owner sign-off. → [wallet-billing](../features/wallet-billing.md)

Small, decided items. Each links to its decision; build in any order unless noted.

1. #316 Built — unpriced operations hidden + not callable; explicit `0` = free — [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)
2. **Pending P0 #426** restrict $1 grant to signup auto-created personal org, once per user; #317 broader implementation remains until fixed — [decision](../decisions/2026-10-11-signup-credit-eligibility.md)
3. #318 Estimated checkout card fee, no true-up, full paid-amount refund including fee (legal check first) — [decision](../decisions/2026-10-11-card-fee-and-refunds.md)
4. **Built** #319 Review eligibility includes free-tier callers — [decision](../decisions/2026-10-10-review-eligibility.md)
5. #320 Email via Resend (built; dormant until owner configures verified sender + API key) — [decision](../decisions/2026-10-10-email-resend.md)
6. #321 Docs/FLOW alignment: two roles (admin, member), admin-only analytics + delivery history — [decision](../decisions/2026-10-10-two-roles-admin-member.md)

Agent distribution remains P0. x402 activation and capability routing move to P2; LLM support is deferred entirely. Disabling existing features is tracked separately from future activation. [Owner answer map](../sessions/2026-10-11-owner-decisions.md).

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
| 7b  | #322–#326 Agent distribution: `llms.txt`, OAuth on `/mcp`, Claude Connectors Directory, MCP Registry, one-click installs (2026-10-10) | [agent-surface](../features/agent-surface.md)                                                          |
| 7d  | #313 #314 House listings through permitted sources, ordinary publisher 95/5; RapidAPI excluded; optional cap P2 #429                  | [publishing-specs](../features/publishing-specs.md)                                                    |
| 7e  | #425 Hide/disable per-token LLM listings, retain code                                                                                 | [pricing](../features/pricing.md)                                                                      |
| 7f  | #428 Spec → MCP/CLI/docs converter; link existing MCP #110, SDKs #350 remain P2                                                       | [agent-surface](../features/agent-surface.md)                                                          |
| 7g  | #426 Signup personal-org-only $1 grant, once per user                                                                                 | [accounts-orgs](../features/accounts-orgs.md)                                                          |
| 7h  | #353 #430 Rebuild authority/lots, traceable dust merge, daily release and breakage accounting                                         | [wallet-billing](../features/wallet-billing.md)                                                        |

### P1 — the agent-first bet + trust plumbing

| #   | Item                                                                             | Feature                                                         |
| --- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 8   | Org-scoped wallets                                                               | [wallet-billing](../features/wallet-billing.md)                 |
| 9   | Per-API agent tooling + machine-readable discovery/pricing index                 | [agent-surface](../features/agent-surface.md)                   |
| 10  | #424 Disable x402 and retain enablement runbook; activation is P2 #109           | [machine-payments](../features/machine-payments.md)             |
| 11  | Free tier enforcement (publisher-funded) + tiered pricing                        | [pricing](../features/pricing.md)                               |
| 12  | Spend caps, threshold alerts, budget webhooks                                    | [wallet-billing](../features/wallet-billing.md)                 |
| 13  | Key-management API with zero-downtime rotation                                   | [api-keys](../features/api-keys.md)                             |
| 14  | Mock/sandbox mode                                                                | [mock-sandbox](../features/mock-sandbox.md)                     |
| 15  | Deprecation/unpublish lifecycle                                                  | [listing-lifecycle](../features/listing-lifecycle.md)           |
| 16  | Publisher webhooks                                                               | [webhooks-notifications](../features/webhooks-notifications.md) |
| 16a | #427 OpenAPI-generated Try it form; current raw-text input replaced in follow-up | [mock-sandbox](../features/mock-sandbox.md)                     |
| 16b | #110 Listing-scoped MCP generated tools, coordinated with P0 #428                | [agent-surface](../features/agent-surface.md)                   |

### P2 — cutting edge

| #   | Item                                                                                                                                  | Feature                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 17  | Publisher payouts (95/5, transparent)                                                                                                 | [earnings-payouts](../features/earnings-payouts.md)     |
| 18  | Security-scan + uptime badges as listing gates; per-API status pages                                                                  | [quality-signals](../features/quality-signals.md)       |
| 19  | Version pinning per key + spec-diff changelog                                                                                         | [listing-lifecycle](../features/listing-lifecycle.md)   |
| 20  | Dispute-a-call flow (successful-but-garbage-response refunds, credits held pending review) + SLA tiers with automatic service credits | [wallet-billing](../features/wallet-billing.md)         |
| 21  | #349 Outcome pricing; #431 LLM revival/precision policy (support deferred, #425 disables existing #329)                               | [pricing](../features/pricing.md)                       |
| 22  | #327 #328 Capability routing deferred; #372 design retained; one listing → one upstream for now                                       | [capability-routing](../features/capability-routing.md) |
| —   | Verified reviews                                                                                                                      | [reviews](../features/reviews.md)                       |
| —   | #350 Generated SDKs                                                                                                                   | [landing-docs](../features/landing-docs.md)             |
| —   | #109 x402 activation deferred; feature-off follow-up P1 #424 and enablement runbook                                                   | [machine-payments](../features/machine-payments.md)     |
| —   | #429 Optional $100/month total house subsidy cap — assessed and skipped 2026-10-11; upstream-cost evidence needs broader changes      | [publishing-specs](../features/publishing-specs.md)     |

Several P1/P2 items shipped ahead of their tag (payouts via Stripe Connect, mock mode, webhooks, free-tier enforcement, verified reviews). Feature notes carry the real status.

## Reprioritization (2026-10-11)

[Owner decisions](../sessions/2026-10-11-owner-decisions.md): agent distribution remains P0. x402 activation (#109) and capability routing (#327/#328) are P2; LLM support is deferred. #424/#425 enforce disabled behavior in follow-up code. The ten decision files preserve money, contract and house-listing policy answers.

### Historical reprioritization (2026-10-10; superseded where noted)

Decision: [P0 agent bet](../decisions/2026-10-10-p0-agent-bet.md), [house supply](../decisions/2026-10-10-house-supply-via-aggregators.md). Source: [research](../research/agent-api-marketplace-landscape.md), [session](../sessions/2026-10-10-competitive-research-and-docs.md).

- **Accepted → P0**: x402 keyless rail, agent distribution, capability routing, house supply via aggregators
- **Not approved**: infra freeze
- **Superseded**: single launch vertical — replaced by aggregator-sourced breadth
- **Built #329 (P0)**: per-token pricing for LLM-wrapping APIs; hold then settle observed usage. [Decision](../decisions/2026-10-10-llm-per-token-pricing.md). Outcome-based pricing remains #21.

## Later

- Listing-scoped MCP is tracked as P1 #110 above and linked to P0 converter #428; no duplicate issue.

## Recently completed (removed from active backlog)

- New-user org handling: Clerk auto-org creation plus `/app/org/create` guard
- Landing count, credit pluralization, try-it key link, app Docs navigation, notification destinations
- Browser-fetch paid-call and anonymous mock E2E coverage
- Payout notification kinds
- Production CI deployment from green `develop`

## Payment recovery fixes — 2026-10-10

- **P1 #396, #417 (implemented):** all gateway/MCP admission 402s retain safe explanations and recovery actions for the paired web environment. → [agent-surface](../features/agent-surface.md)
- **P1 #421 (implemented):** cached empty wallets refresh once before admission, with concurrent deduplication and a persistent five-second cooldown; immediate signup credit succeeds on direct/MCP paid, free-tier, and zero-price paths. → [wallet-billing](../features/wallet-billing.md)
