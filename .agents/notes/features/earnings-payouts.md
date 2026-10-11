# Earnings & payouts

> Status: #398 fixed; partial (#363 list/presentation fixes complete) (P2 — built ahead of tag on Stripe Connect; settlement schedule + statement export absent); daily risk buckets accepted for rebuild #353 · Updated: 2026-10-11
> Rebuild status: isolated PR 3 settlement projection, wider total shards and same-org promo protection implemented; isolated PR 4 risk release, pending-first/newest-first publisher clawbacks, bounded restoration, transfer recovery and Connect/payout projection implemented; production reads and cutover unchanged.
> Code: `packages/control-plane-next/convex/money/{rollups,adjustments,publisherLedger}.ts`, `convex/earnings.ts`, `convex/payouts.ts`, `convex/accounting.ts`, `convex/billing.ts` (publisher reconciliation), `convex/admin.ts` (`retryPublisherTransfer`), `convex/http.ts` (`/stripe-connect-webhook`, `/stripe-connect-v2-webhook`), `packages/shared/src/connect-countries.ts`, `apps/web/src/routes/app/earnings.tsx`, `apps/web/src/routes/app/org/index.tsx`, `apps/web/src/routes/admin/payouts.tsx`, `apps/web/src/lib/format.ts`, `convex/earnings.test.ts`
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

### Isolated rebuild PR 6 — 2026-10-11

**Status:** implemented behind next preview switch; legacy remains default until PR 7. Updated: 2026-10-11.

Next earnings totals use exact lifetime/month publisher rollups; org project detail is bounded to first 100 with truncation metadata; project screens use an exact slug-indexed lookup. Payout DTOs now compile against actual screens, including in-transit bank payouts; authoritative totals remain separate from recent 50 detail rows. Transfer confirmation/definitive failure emits idempotent inbox notices. Operator failed-transfer retry allocates a new canonical transfer; unknown outcomes retain their original dispatch identity and require reconciliation.

Code pointers: `packages/control-plane-next/convex/earnings.ts`; `packages/control-plane-next/convex/payouts.ts`; `packages/control-plane-next/convex/admin.ts`. See [rebuild PR 6 handoff](../architecture/convex-rebuild.md#pr-6-implementation-and-handoff--2026-10-11) for bounds, validation and cutover prerequisites.

PR #439 throughput hardening: isolated rebuild earning release and payment restoration/clawback share `packages/control-plane-next/convex/money/throughput.ts` admission (ten pages/second, 128 KiB full-document writes per page). Release discovery spaces workers/continuations; deployment throughput errors retry after two seconds without opening corruption cases. Existing release leases remain cron-recoverable if scheduling fails. [Budget and CI scale validation](../architecture/convex-rebuild.md#pr-4-implementation-and-handoff--2026-10-11).

### Isolated rebuild PR 4 — 2026-10-11

`packages/control-plane-next/convex/money/{publisherLedger,financialRollups,transfers,adjustments,reconciliationCases}.ts` and `{payouts,connect,stripeEvents}.ts` implement daily risk release, source-specific 95/5 reversals/restoration, whole-cent transfer allocation, provider outcome recovery and separate bank payout projection. Publisher balances change on ledger transitions, never per settled call. Earned gross/net stay immutable; held + released + reversed equals earned. Already-paid clawbacks can make publisher available balance negative. Payment-specific reconciliation holds block transfers from temporary restoration balances.

PR #439 uses `publisherEarnings.by_payment_state_day` to drain pending buckets newest-first before released buckets newest-first, across publishers while preserving payment attribution. Wallet/publisher reversals carry restoration markers; `by_unrestored` scans only outstanding journals. Status-only refund/dispute updates create no new reconciliation generation. Multi-publisher/payment tests verify original-source, 95/5, and publisher journal conservation.

Review defaults **pending owner sign-off**: A — the pending-first/newest-first order above; B — `needs_review` keeps the entire consumer wallet frozen for now (PR 6 operator UI), with P1 [#440](https://github.com/zevium-dev/core/issues/440) to lock only the bad payment's sources; C — accept the remaining window in which released earnings transfer before a refund clawback reaches them. The seven-day hold covers most exposure; it cannot guarantee recovery from already transferred money. [Proposed defaults](../decisions/2026-10-11-payment-review-defaults.md).

Daily `netAtoms` remains execution analytics, **not releasable money**. Release uses earning inventory and acceptance-day pending risk; total shards remain 128 and project shards use modulo 16. Corrupt releases are isolated. Unknown transfer outcomes retain allocation beyond the 23-hour safe replay window; paged candidate evidence requires review. Accounts v2 creation has its own 29-day replay policy and retains unresolved operation PII. Connected-account and payout projections reject stale revision completions. Bank payout status never moves wallet/publisher money. House orgs use this same path.

All replacement Stripe calls are test-mode-only. No live destination/caller changed. [PR 4 complete handoff and safe interpretations](../architecture/convex-rebuild.md#pr-4-implementation-and-handoff--2026-10-11).

Isolated PR #438 review: original-source/day earnings and publisher-total/platform rollups use 128 shards; publisher project/endpoint and consumer dimensions retain 16. Same-org promo slices keep gross attribution with zero publisher net/fee and explicit promo cost. Paid/admin and unrelated-org promo retain 95/5. Daily net is not releasable inventory; PR 4 releases from earnings and acceptance-day pending risk, mapping earning shards modulo 16 for project totals. [Proposed promo policy](../decisions/2026-10-11-promo-self-consumption.md) awaits owner sign-off.

### Isolated rebuild PR 3 — 2026-10-11

Settlement now creates 128-shard original-source daily buckets with exact 95/5 atoms, acceptance-day end + seven-day availability, and transactional pending-risk rollups. It never writes publisherBalances per call. PR 4 implements risk release, payment clawbacks and transfers below. [Implementation and handoff](../architecture/convex-rebuild.md#pr-3-implementation-and-handoff--2026-10-11).

### Isolated rebuild foundation — 2026-10-11

PR #436 adds `financeReconciliationCases` in `packages/control-plane-next/convex/schema/read.ts` for foreign Stripe events, orphan transfers and account-creation quarantine, including facts without an owned organization. `rowKind:case` owns state/cursors/counts; candidate/provider-request evidence is indexed child rows in the same table, never growing arrays. This isolated schema raises the application count to 34; PR 4 owns worker behavior and live settlement is unchanged. [Rebuild schema and handoff](../architecture/convex-rebuild.md#pr-1-implementation-and-handoff--2026-10-11).

### Accepted changes — implementation pending (2026-10-11)

Rebuild #353 may release source-aware daily earning buckets up to ~24h after the seven-day hold; never earlier. This is an accepted target, not a change to current release code. House publisher delivery #314 uses the ordinary publisher ledger; optional total subsidy cap #429 must not create a second earnings ledger.

### Current implementation

- **Email (#320)**: `transfer_sent` / `transfer_failed` kinds now have idempotent producers in verified transfer projection and definitive dispatch failure, with optional Resend delivery. Stale failure events after success and initially reversed snapshots cannot send misleading notices. These describe transfers to the connected account, not confirmed bank delivery. No new bank-payout notification kind. Setup and preferences: [webhooks-notifications](webhooks-notifications.md#transactional-email-320).

- **Earnings precision (#398)**: statement project/month/all-time totals accumulate accounting atoms before converting to decimal credits. Analytics follows the same conversion; all net tickers and ledger credit columns use `formatPublisherCredits` (two decimals). USD equivalents retain the shared `formatCreditsAsUsd` rounding.

- **Presentation and operations (#363)**: earnings, transfers, and bank payout histories use stock shadcn Table and shared `lib/format.ts` money/decimal-credit/UTC date formatting. Fractional publisher credits keep two decimals with an explicit `en-US` locale. Admin transfers use native reactive pagination; retry actions rely on subscription updates rather than clearing and refetching pages. Dead `earningTotalsByStatus` helpers were removed; authoritative totals still come from Convex.

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
