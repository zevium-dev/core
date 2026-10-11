# Earnings & payouts

> Status: root cutover implemented; owner activation pending · Updated: 2026-10-11
> Code: `convex/{earnings,payouts,connect,operators}.ts`, `convex/money/{publisherLedger,financialRollups,transfers,adjustments}.ts`, `tests/finance.test.ts`
> Related: [wallet-billing](wallet-billing.md), [pricing](pricing.md), [publisher-analytics](publisher-analytics.md), [platform-admin](platform-admin.md), [webhooks-notifications](webhooks-notifications.md), [accounts-orgs](accounts-orgs.md), [decision: platform fee publisher side](../decisions/2026-10-10-platform-fee-publisher-side.md), [stripe discovery](../research/stripe-connect-discovery.md)

> Email (#320): built, dormant until configured. Code: `convex/notificationEmail.ts`, `convex/notificationEmailAction.ts`, `convex/lib/notificationEmail.ts`, `convex/notificationEmail.test.ts`.

Publisher side of the money flow. Each settled call credits the publisher org 95% of its price as a risk-held earning; matured earnings become available and an org admin transfers them (≥ $10) to the org's Stripe Connect account, from which Stripe pays out to the bank. Convex owns the publisher ledger; Stripe owns transfer and payout facts.

## Product

- Publishers earn revenue when consumers call their endpoints; earnings accumulate toward payouts
- **Publishers keep 95%.** Low platform fees preserve publisher economics for high-volume machine traffic and make the split easy to understand. The 5% is taken from the publisher side of each call — consumers pay no platform top-up surcharge; separate card-fee estimate remains legal-gated in #318 (decided 2026-10-10, see [decision](../decisions/2026-10-10-platform-fee-publisher-side.md))
- Platform cut + publisher share are calculated per call at charge time
- Publisher earnings accumulate and are settled via payouts
- **Payouts**: transparent 95/5 split, accumulated earnings visible in dashboard; organization admin transfers available earnings to its connected Stripe account once the $10 minimum is reached; Stripe handles bank delivery (automated settlement scheduling is a later refinement)
- Publishers see calls, revenue, and performance per endpoint — without running any billing infrastructure

Roadmap ([roadmap](../product/roadmap.md)):

- P2 #17 — Publisher payouts (95/5, transparent). Implemented ahead of tag

## Flow

### Earnings & payouts — `.../organizations/{org}/earnings` (P2)

- Accumulated publisher share (95%), settlement schedule, payout history, payout method, statement export
- Implemented ahead of its P2 tag with Stripe Connect: members can view state and history; org admins handle publisher onboarding, remediation, and transfers from `/app/org` and `/app/earnings`. Earnings separate pending-risk, available, allocated, transferred, reversed, and failed states. `/admin/payouts` retries failed Connect transfers; bank destinations stay inside Stripe.

Publisher golden path tail: Analytics tick (calls, p95, errors, revenue) → earnings accrue at 95% → payout.

## Tech

Settlement writes exact original-source/day/shard 95/5 atoms and rollups without per-call publisher balance writes. Risk release waits until acceptance-day end plus seven days. Whole-cent transfers retain fractional carry; ambiguous provider outcomes retain allocation and reconciliation evidence. Pending earnings reverse newest-first before released earnings; already transferred money can leave negative publisher availability. Reinstatement restores exact journals. Accounts v2 ownership, mode/account/capability checks and durable retry identities survive. Same-org promo self-consumption earns no withdrawable net; cross-org common ownership is not inferred. These review defaults still need owner policy sign-off before activation.

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

## Decisions

- 2026-10-11 — PR #442 applies [read-surface review defaults](../decisions/2026-10-11-read-surface-review-defaults.md), pending owner sign-off.

- [PR 4 review defaults](../decisions/2026-10-11-payment-review-defaults.md): A/B/C implemented as parent defaults, pending owner sign-off; follow-up #440.

- 2026-10-11 — Preserve durable notification/reconciliation facts in the 34-table isolated rebuild. [Decision](../decisions/2026-10-11-convex-rebuild-durable-facts.md).

- 2026-10-11 — ACCEPTED: Daily buckets may release up to ~24h after the seven-day hold; rebuild #353. [Decision](../decisions/2026-10-11-publisher-risk-release.md).
- 2026-10-11 — ACCEPTED: House org uses ordinary 95/5 ledger (#314); optional total subsidy cap is P2 #429. [Decision](../decisions/2026-10-11-house-listing-accounting.md).

- Wave 9 (user, ≤ 2026-07-12) — Payouts: manual ledger MVP (request → admin queue → human wires). Min payout 100,000 credits ($10). **Superseded 2026-07-12** by Stripe Connect
- 2026-07-12 — Stripe Checkout + Connect replace Polar checkout + manual payouts; separate charges and transfers; Accounts v2 recipient configuration. See [architecture overview](../architecture/overview.md)
- 2026-10-10 — Platform fee taken publisher-side (5% of each call's spend, publisher 95%). [decision](../decisions/2026-10-10-platform-fee-publisher-side.md)

## Open questions

- FLOW lists "settlement schedule" and "statement export"; neither found in code (transfers are manual admin action; no export)
- Route: FLOW target `.../organizations/{org}/earnings`; code is `/app/earnings` + `/app/org`
- Production decisions still open per [stripe-connect-discovery](../research/stripe-connect-discovery.md): payout cadence (scheduled vs publisher-triggered), keep $10 minimum or raise it on transfer/payout economics, risk-hold duration and release rules (code uses 7 days), publisher statement semantics, countries/connected-account configuration
- Dual-rail (x402) funds must still reach publishers via Connect 95/5; settlement path for x402-funded wallets not designed. See [machine-payments](machine-payments.md)
