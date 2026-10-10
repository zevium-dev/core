# Earnings & payouts

> Status: partial (P2 — built ahead of tag on Stripe Connect; settlement schedule + statement export absent) · Updated: 2026-10-10
> Code: `convex/earnings.ts`, `convex/payouts.ts`, `convex/accounting.ts`, `convex/billing.ts` (publisher reconciliation), `convex/admin.ts` (`retryPublisherTransfer`), `convex/http.ts` (`/stripe-connect-webhook`, `/stripe-connect-v2-webhook`), `packages/shared/src/connect-countries.ts`, `apps/web/src/routes/app/earnings.tsx`, `apps/web/src/routes/app/org/index.tsx`, `apps/web/src/routes/admin/payouts.tsx`
> Related: [wallet-billing](wallet-billing.md), [pricing](pricing.md), [publisher-analytics](publisher-analytics.md), [platform-admin](platform-admin.md), [webhooks-notifications](webhooks-notifications.md), [accounts-orgs](accounts-orgs.md), [decision: platform fee publisher side](../decisions/2026-10-10-platform-fee-publisher-side.md), [stripe discovery](../research/stripe-connect-discovery.md)

Publisher side of the money flow. Each settled call credits the publisher org 95% of its price as a risk-held earning; matured earnings become available and an org admin transfers them (≥ $10) to the org's Stripe Connect account, from which Stripe pays out to the bank. Convex owns the publisher ledger; Stripe owns transfer and payout facts.

## Product

- Publishers earn revenue when consumers call their endpoints; earnings accumulate toward payouts
- **Publishers keep 95%.** Low platform fees preserve publisher economics for high-volume machine traffic and make the split easy to understand. The 5% is taken from the publisher side of each call — consumers pay no top-up surcharge (decided 2026-10-10, see [decision](../decisions/2026-10-10-platform-fee-publisher-side.md))
- Platform cut + publisher share are calculated per call at charge time
- Publisher earnings accumulate and are settled via payouts
- **Payouts**: transparent 95/5 split, accumulated earnings visible in dashboard; publisher requests a payout once earnings clear a $10 minimum, queued for platform fulfillment (automated settlement schedule is a later refinement)
- Publishers see calls, revenue, and performance per endpoint — without running any billing infrastructure

Roadmap ([roadmap](../product/roadmap.md)):

- P2 #17 — Publisher payouts (95/5, transparent). Implemented ahead of tag

## Flow

### Earnings & payouts — `.../organizations/{org}/earnings` (P2)

- Accumulated publisher share (95%), settlement schedule, payout history, payout method, statement export
- Implemented ahead of its P2 tag with Stripe Connect: members can view state and history; org admins handle publisher onboarding, remediation, and transfers from `/app/org` and `/app/earnings`. Earnings separate pending-risk, available, allocated, transferred, reversed, and failed states. `/admin/payouts` retries failed Connect transfers; bank destinations stay inside Stripe.

Publisher golden path tail: Analytics tick (calls, p95, errors, revenue) → earnings accrue at 95% → payout.

## Tech

### Why Stripe Checkout + Connect (Connect)

- Connect handles hosted publisher onboarding, connected-account capabilities, transfers, and bank-payout events. Zevium uses [separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers) because a publisher is unknown when universal credits are purchased. Connected accounts use the recipient configuration described by [Stripe Accounts v2](https://docs.stripe.com/connect/accounts-v2).

Ledger-authority and external-facts bullets ("Convex remains authoritative for credits, 95/5 usage settlement, earning holds…", "Stripe supplies external … facts") live in [wallet-billing](wallet-billing.md).

### Domain ownership (Convex schema sketch)

- `publisherEarnings`, `publisherTransfers`, `connectedPayouts` (risk-held 95/5 earnings, Connect transfer state, bank-payout projection)

### Implementation notes

- **Fresh deployment (#354)**: removed legacy transfer metadata repair operators and finance migration bypasses/stamps. Runtime provider correlation, allocation, reconciliation, retries, reversals, and publisher balance validation remain.

- **Connect onboarding**: connected accounts and hosted onboarding links both use Accounts v2. Server-issued durable operation ids scope provider idempotency separately for account creation and each single-use link. Account creation first reconciles bounded v2 metadata (including 5f8-era `clerkOrgId` orphans), fails closed beyond the v2 replay window or a saturated scan, and persists the verified account id + livemode before link creation. Refresh is a separate active-org admin action that always rotates to a fresh link operation; return/refresh URLs require HTTPS except HTTP loopback in verified test mode. Stripe-hosted link URLs always require HTTPS and are never stored. Account/link responses must match the local org, recipient configuration, and configured Stripe mode. Checkout and Connect verify the runtime key's own `/v1/account` identity against `STRIPE_PLATFORM_ACCOUNT_ID` and its `/v1/balance` mode; restricted keys need read access to both resources.
- **Connect settlement**: publisher usage creates risk-held earning rows denominated in accounting atoms (`10,000 atoms = 1 credit`), making every per-call 95/5 split exact even for a one-credit call. Mature earnings post in indexed 25-row chunks into an append-only publisher settlement ledger plus materialized available / allocated / paid buckets and all-row pending-risk / reversed / failed aggregates; recent-row pagination is display-only. Refund/dispute clawbacks can make publisher available balance negative after already-paid earnings, so future earnings repay that publisher liability before payout; consumer wallets never carry debt. Transfers require the product's $10 minimum, allocate only whole Stripe cents, and leave all sub-cent atoms in canonical available balance. Transfer creation, webhook projection, and crash recovery validate amount, currency, destination connected account, platform account, 256-bit server nonce, and HMAC metadata against a provider snapshot; cumulative reversals return the exact allocation without duplicating or dropping remainder. `STRIPE_PLATFORM_ACCOUNT_ID` and a 32-byte `STRIPE_TRANSFER_CORRELATION_SECRET` are required before transfer creation.
- **Payouts**: Stripe Connect onboarding replaces free-form payout destinations. Earnings move through pending-risk, available, allocated, transferred, and reversed/failed states; `/admin/payouts` operates failed transfer retries while Stripe payout events project bank-delivery state.

Connect webhook subscriptions (`/stripe-connect-webhook` payout events, `/stripe-connect-v2-webhook` account events, platform `transfer.*` events), refund acceptance and payment-drill compensation (publisher reconciliation, transfer reversal) live in [wallet-billing](wallet-billing.md).

### Code facts (read from source 2026-10-10, not in source docs)

- `convex/accounting.ts`: `PUBLISHER_MINIMUM_PAYOUT_CENTS = 1_000` ($10); `PUBLISHER_RISK_HOLD_MS` = 7 days; `publisherEarningSplit` computes fee = gross × 500 atoms, publisher = gross × 9,500 atoms
- Transfers are org-admin-initiated (`payouts.initiatePublisherTransfer` from `/app/earnings`), not scheduled; onboarding via `payouts.startOnboarding` / `refreshOnboarding` / `replaceClosedAccount`

## Decisions

- Wave 9 (user, ≤ 2026-07-12) — Payouts: manual ledger MVP (request → admin queue → human wires). Min payout 100,000 credits ($10). **Superseded 2026-07-12** by Stripe Connect
- 2026-07-12 — Stripe Checkout + Connect replace Polar checkout + manual payouts; separate charges and transfers; Accounts v2 recipient configuration. See [architecture overview](../architecture/overview.md)
- 2026-10-10 — Platform fee taken publisher-side (5% of each call's spend, publisher 95%). [decision](../decisions/2026-10-10-platform-fee-publisher-side.md)

## Open questions

- Doc/code conflict: PRODUCT "Payouts" still describes request → "queued for platform fulfillment"; code lets org admins transfer directly to their Connect account (admin queue only retries failed transfers). Code wins; product text needs update
- FLOW lists "settlement schedule" and "statement export"; neither found in code (transfers are manual admin action; no export)
- Route: FLOW target `.../organizations/{org}/earnings`; code is `/app/earnings` + `/app/org`
- Production decisions still open per [stripe-connect-discovery](../research/stripe-connect-discovery.md): payout cadence (scheduled vs publisher-triggered), keep $10 minimum or raise it on transfer/payout economics, risk-hold duration and release rules (code uses 7 days), publisher statement semantics, countries/connected-account configuration
- Dual-rail (x402) funds must still reach publishers via Connect 95/5; settlement path for x402-funded wallets not designed. See [machine-payments](machine-payments.md)
