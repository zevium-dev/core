# Stripe Connect discovery

Status: proposed architecture and implementation inventory, 2026-07-12. No production Stripe account decisions are assumed complete.

## Executive decision

Use Stripe for both sides of marketplace money movement:

- **Stripe Checkout** collects one-time consumer credit-pack payments.
- **Stripe Connect** onboards publishers and sends transfers/payouts.
- **Convex** remains authoritative for Zevium credits, usage settlement, publisher earnings, platform fees, reversals, and payout eligibility.
- **Wallet Durable Object** remains immediate edge enforcement state: active reservations, spendable checkpoint, per-key limits, and pending settlements.

Do not use Stripe Billing meters, Stripe customer credit balance, or Stripe billing credits as the gateway wallet. Those products do not provide the atomic per-request reservation required by the product rule: zero balance blocks the call before upstream execution.

Recommended Connect funds flow: **separate charges and transfers**. Consumer top-up is a platform charge because publisher is unknown at purchase time. Publisher transfers occur later from accrued, risk-cleared earnings.

Zevium is the platform/merchant of record under this model by default. Stripe Managed Payments is not an escape hatch: Stripe documents that Managed Payments does not support Connect marketplace setups or marketplace offerings.

## Source-of-truth boundaries

| Fact                                             | Authority                        | Replica / projection                       |
| ------------------------------------------------ | -------------------------------- | ------------------------------------------ |
| Checkout, PaymentIntent, charge, refund, dispute | Stripe                           | Convex payment record                      |
| Connected-account identity and capabilities      | Stripe                           | Convex organization payment profile        |
| Org credit balance                               | Convex append-only wallet ledger | Materialized Convex wallet + DO checkpoint |
| Active request reservation                       | Wallet DO                        | None                                       |
| Settled API usage                                | Convex                           | Analytics projections                      |
| Publisher gross/net earnings and 5% fee          | Convex                           | Earnings views                             |
| Transfer to connected-account balance            | Stripe                           | Convex transfer record                     |
| Bank payout from connected account               | Stripe                           | Convex payout projection                   |

This is not split brain: no fact has two authorities. Stripe owns external money events; Convex owns marketplace accounting; DO owns temporary execution state.

## Product constants currently assumed

Current product documents define:

- `$1 = 10,000 credits`.
- Consumer organizations prepay through one-time top-ups.
- Endpoint cost comes only from immutable published OpenAPI spec versions.
- Successful calls settle 95% publisher share and 5% platform fee.
- Upstream failure refunds the reservation.
- Zero balance blocks execution.
- Current packs are `$10`, `$50`, and `$100`, with larger-pack bonuses in `convex/billing.ts`.
- Current manual payout minimum is 100,000 credits (`$10`). This is too low for automated Connect economics unless Stripe fees and payout costs prove negligible; keep as an explicit product decision, not inherited behavior.

## Stripe account model

Each Clerk organization can be both consumer and publisher:

```text
Clerk organization
  ├── Stripe Customer             consumer credit purchases
  └── Stripe connected account   publisher onboarding and payouts
```

Store both IDs on an organization-owned payment profile. Do not use Clerk user IDs for Stripe ownership. Do not accept organization IDs from clients when active Clerk organization context supplies them.

Recommended onboarding: Stripe-hosted or embedded Connect onboarding. Stripe owns collection and validation of legal entity, representative, identity, bank-account, and capability requirements. Zevium stores only state needed for product UX:

- connected account ID
- onboarding/details submitted state
- charges enabled
- payouts enabled
- disabled reason
- requirements currently/past due
- last synchronized timestamp

Never collect or store bank details in Convex.

## Charge and transfer model

### Why separate charges and transfers

A credit purchase does not identify a publisher. Later calls may spend one purchase across many publishers. Destination charges and direct charges require seller attribution too early. Separate charges and transfers decouple consumer charge from later publisher allocation.

Consequences:

- Charge lands on platform Stripe balance.
- Stripe fees, refunds, and disputes debit platform balance.
- Transfers do not reverse automatically when a charge is refunded or disputed.
- Zevium must carry refund/chargeback risk and recover through internal debt, withheld earnings, or transfer reversals.
- Stripe does not automatically retry a failed transfer; Zevium needs an idempotent retry state machine.

Do not attach a later publisher transfer directly to one top-up charge unless accounting can prove attribution and amount. Universal credits can be consumed from several grants and across several publishers. Convex publisher ledger is canonical allocation record.

## Consumer payment flow

1. Authenticated org member selects a canonical credit pack.
2. Convex creates `checkoutIntents` row with expected pack, amount, currency, credits, org, and expiry.
3. Server creates Stripe Checkout Session in `payment` mode for a server-owned Price ID.
4. Session metadata contains only correlation identifiers (`checkoutIntentId`, `clerkOrgId`, `packId`). Metadata never defines amount or credits.
5. Browser redirects to Stripe-hosted Checkout.
6. Success URL returns to `/app/billing?checkout={CHECKOUT_SESSION_ID}` and shows processing/succeeded state; it never grants credits.
7. Verified platform webhook receives payment events.
8. Canonical fulfillment verifies Checkout Session/PaymentIntent, Price, amount, currency, customer, and org mapping.
9. Convex appends exactly one positive wallet entry using stable reference such as `stripe:payment_intent:pi_...`.
10. DO imports a newer Convex balance/sequence checkpoint.

Canonical grant trigger should be one event path only. Proposed default: fulfill from `checkout.session.completed` only when `payment_status === "paid"`; also handle `checkout.session.async_payment_succeeded` for delayed methods. `payment_intent.succeeded` updates payment state or supports recovery, but must not independently double-grant. Final event choice must match enabled Stripe payment methods.

## Refund and dispute accounting

### Refund

1. Receive verified refund/charge update.
2. Resolve original payment and original credit grant from Stripe object IDs, not webhook metadata amounts.
3. Append idempotent negative wallet entry keyed by refund ID.
4. For partial refund, reverse credits proportionally from original paid amount with deterministic integer rounding and a cumulative cap equal to original granted credits.
5. Reconcile DO to newer authoritative sequence.
6. If credits were spent, retain negative Convex balance/debt; edge spendable balance is clamped to zero. Future grants repay debt before becoming spendable.

### Dispute

1. `charge.dispute.created` freezes remaining spendable value attributable to the payment where feasible and flags org risk state.
2. Append reversal/debt according to chosen dispute policy.
3. Withhold publisher earnings still inside risk hold.
4. Attempt transfer reversal only when a prior related transfer can be identified and recovery is legally/product-wise correct.
5. `charge.dispute.closed` resolves won/lost state idempotently.

Refunds and disputes after publisher transfer are platform exposure. Stripe may be unable to reverse a transfer when connected account lacks available balance. Product needs a reserve/hold policy before automated payouts.

## Publisher earnings and Connect transfers

Current code derives net earnings from historical usage and subtracts manual payout requests. Replace that with explicit immutable earning and transfer allocation records.

Each successful usage settlement atomically creates:

```text
consumer wallet debit       = endpoint cost
publisher gross earning     = endpoint cost
platform fee                = floor/defined rounding at 5%
publisher net earning       = gross - platform fee
```

Define one integer rounding rule centrally. Never duplicate `0.05` constants across modules.

Publisher earning lifecycle:

```text
pending_risk → available → allocated_to_transfer → transferred
                                  ↘ reversed / failed
```

Recommended initial policy:

- Show pending earnings immediately.
- Make earnings transferable only after a configurable risk hold.
- Batch transfers by connected account and settlement currency.
- Create Stripe transfer with a deterministic idempotency key derived from internal transfer batch ID.
- Treat transfer and bank payout as different states. Transfer moves platform Stripe balance to connected-account balance; payout moves connected-account balance to bank.
- Listen to connected-account `payout.*` events if UI promises bank-arrival status.

Whether publishers request payout manually or receive scheduled automatic transfers remains a product decision. Boring launch default: publisher completes Connect onboarding, earnings clear risk hold, Zevium creates scheduled transfer batches; Stripe connected-account payout schedule handles bank payout. Remove free-form bank/PayPal/UPI destination fields.

## Proposed Convex schema direction

Exact validators belong in implementation, but required records are:

### `organizationPayments`

- `organizationId` unique
- `stripeCustomerId` optional unique
- `stripeConnectedAccountId` optional unique
- `detailsSubmitted`
- `chargesEnabled`
- `payoutsEnabled`
- `disabledReason` optional
- requirements summary
- `updatedAt`

### `checkoutIntents`

- `organizationId`
- canonical `packId`
- expected Stripe Price ID
- expected amount/currency/credits
- Stripe Checkout Session ID unique
- PaymentIntent ID optional unique
- status
- created/updated/expired timestamps

### `paymentEvents`

- Stripe event ID unique
- Stripe account context (`platform` or connected account ID)
- event type
- object ID
- processing status (`received`, `processing`, `processed`, `failed`, `ignored`)
- attempt count and last error safe summary
- received/processed timestamps

Store enough normalized metadata for replay; avoid storing sensitive full payload forever unless retention policy explicitly requires it.

### `payments`

- organization and checkout intent
- Checkout Session, PaymentIntent, and Charge IDs
- amount/currency
- granted/reversed credits
- status including partial refund and dispute
- created/updated timestamps

### `wallets` and `walletEntries`

Wallet gains monotonically increasing `sequence`. Entry kinds become explicit:

- `payment_grant`
- `usage_settlement`
- `refund_reversal`
- `dispute_reversal`
- `admin_adjustment`

Each entry has globally unique `refId`, signed credit amount, sequence, and source IDs. Materialized balance changes atomically with entry insertion.

### `publisherEarnings`

- publisher org
- usage settlement ID unique
- gross credits
- platform fee credits
- net credits
- available timestamp
- lifecycle status
- transfer allocation optional

### `publisherTransfers`

- publisher org and connected account
- amount/currency
- Stripe transfer ID optional unique
- deterministic idempotency key unique
- lifecycle status
- attempt/error timestamps

### `connectedPayouts`

Optional if product displays bank payout history:

- connected account ID
- Stripe payout ID unique
- amount/currency
- arrival date
- status/failure code

## Webhook architecture

Use separate Stripe endpoint secrets for platform and Connect webhook destinations. Verify against raw body before JSON parsing.

Required platform events, subject to final enabled payment methods:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `payment_intent.payment_failed`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.closed`

Required Connect events:

- `account.updated`
- `transfer.created`
- `transfer.updated`/`transfer.failed` where available in selected API version
- `transfer.reversed`
- `payout.created`
- `payout.paid`
- `payout.failed`

Implementation rules:

- Dedupe every inbound event by Stripe event ID plus account context.
- Also enforce business idempotency on underlying object IDs; Stripe can emit distinct events for one object transition.
- Do not depend on event order. Retrieve current Stripe object when prior state is missing or stale.
- Return `2xx` only after durable receipt. Process slow side effects asynchronously.
- Stripe retries live webhook delivery for up to three days. Manual replay can overlap automatic retries.
- Every outbound Stripe `POST` uses a deterministic idempotency key.
- Store safe errors; never leak Stripe raw internal errors directly to users.

## DO ↔ Convex accounting protocol required before payments ship

Current code has a dangerous ambiguity: DO can acknowledge a batch that Convex partially skipped, authoritative balance returned by `/wallet-grants` is ignored, and no reconciliation cron exists despite TECH.md claiming one.

Required protocol:

1. Every settlement has stable `settle:{reservationId}` reference.
2. Convex ingest returns per-reference result: `applied`, `already_applied`, or `rejected`.
3. DO removes only `applied`/`already_applied` pending records.
4. Convex returns authoritative wallet balance and monotonic sequence.
5. DO accepts newer checkpoints while preserving active reservations and not-yet-applied settlements.
6. Reconciliation runs periodically and on grants/reversals.
7. Negative/debt Convex balance maps to zero spendable edge balance.
8. Public `/wallet/:org/*` administrative proxy is removed or secret-gated before any real payment integration.

## Existing code replacement inventory

### Delete or replace

- `@polar-sh/sdk` dependency in root `package.json`.
- `convex/billing.ts` Polar client, product discovery/creation, checkout, paid-order sync, and cooldown.
- `/polar-webhook` in `convex/http.ts`.
- `lastPolarSyncAt`, `POLAR_SYNC_COOLDOWN_MS`, `getPolarSyncState`, and `markPolarSync`.
- Billing-page “Sync purchases” flow and Polar copy in `apps/web/src/routes/app/billing.tsx`.
- Manual payout request destination and admin “wire money” resolution flow in `convex/payouts.ts`, `convex/admin.ts`, `apps/web/src/routes/app/earnings.tsx`, and `apps/web/src/routes/admin/payouts.tsx`.
- Polar environment variables and stale Polar documentation.

### Preserve conceptually, then harden

- Canonical credit-pack catalogue.
- Convex append-only wallet ledger and materialized balance.
- Billing history and cycle breakdown.
- Publisher earnings UI.
- Durable Object reserve/settle/refund gate.
- Org-scoped auth supplied by Clerk.
- Usage-derived 95/5 accounting.

## Server/API boundaries

Stripe secret-key work belongs in Convex actions or tightly scoped TanStack server functions. Preferred ownership:

- Convex action creates/retrieves Stripe Customer, Checkout Session, connected account, onboarding session/link, transfer, and reversal.
- Convex HTTP action receives webhooks.
- Convex internal mutations perform all durable state changes.
- Browser receives hosted checkout/onboarding URL or embedded component client secret only.
- Gateway never imports Stripe SDK or calls Stripe.

Add official `stripe` Node SDK. Pin Stripe API version explicitly and upgrade intentionally.

## Product decisions required

These do not block sandbox foundation if safe defaults are used, but must be settled before production:

1. **Stripe approval:** written approval for prepaid, non-transferable credits usable across independent API publishers with later 95% Connect transfers.
2. **Platform legal role:** accept Zevium as platform/MoR for separate charges and transfers.
3. **Countries:** consumer sale countries, publisher connected-account countries, currencies, and cross-border transfer support.
4. **Tax:** marketplace-facilitator and digital-service tax liability; Stripe Tax configuration does not decide legal liability.
5. **Credit policy:** expiry, refundability, promotional credits, abandoned/unclaimed balances, and organization closure.
6. **Refund policy:** unused-only versus broader refunds; partial-refund rounding.
7. **Dispute policy:** immediate org lock, debt handling, and publisher recovery.
8. **Publisher risk hold:** duration and release rules.
9. **Payout cadence:** scheduled automatic transfers versus publisher-triggered transfer requests.
10. **Minimum payout:** keep `$10` or raise it based on transfer/payout economics.
11. **Connected-account configuration:** Stripe-hosted versus embedded onboarding; Stripe-controlled risk/pricing configuration versus platform-controlled choices.
12. **Currencies:** launch is single-currency USD. Checkout adaptive pricing stays disabled and the Stripe platform must settle USD; non-USD settlement requires a future explicit FX-rate, rounding, gain/loss, statement, and reversal model.
13. **Pack bonuses:** preserve current bonuses or simplify fixed exchange-rate packs. Bonuses mean paid amount and granted credit liability intentionally diverge.
14. **Negative balances:** future grants repay debt first; decide whether org is suspended during dispute investigation.
15. **Publisher statement semantics:** pending, available, transferred, paid, reversed.

## External setup required

- Stripe platform account with Connect enabled.
- Test-mode secret and publishable keys.
- Three canonical one-time Prices or one Product with three Prices.
- Platform webhook destination and signing secret.
- Connect webhook destination and signing secret.
- Connected-account controller/capability configuration.
- Checkout allowed payment methods. Start with synchronous cards unless delayed methods receive explicit handling.
- Return URLs for local, preview, and production origins.
- Stripe Tax decision/configuration after legal review.
- Written Stripe approval for funds flow.

Proposed environment contract:

```text
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_CONNECT_WEBHOOK_SECRET
STRIPE_PRICE_PACK_10
STRIPE_PRICE_PACK_50
STRIPE_PRICE_PACK_100
APP_ORIGIN
```

Publishable key is needed only if embedded Stripe UI is selected. Hosted Checkout and hosted onboarding can avoid it initially.

## Test plan

### Payment tests

- Checkout rejects unauthenticated and wrong-org callers.
- Client cannot alter pack amount, currency, credits, customer, or org.
- Paid synchronous Checkout grants once.
- Duplicate event grants once.
- Distinct events for same PaymentIntent grant once.
- Out-of-order event converges by retrieving current Stripe object.
- Delayed payment grants only after async success.
- Failed/expired Checkout grants nothing.
- Partial and full refunds reverse exactly once and never beyond original grant.
- Dispute produces deterministic debt/freeze behavior.
- Signature failure and wrong endpoint secret return failure without state change.

### Connect tests

- Connected account belongs to authenticated active org.
- Repeated onboarding start reuses account.
- `account.updated` projects requirements/capabilities idempotently.
- Earnings cannot transfer before hold or before `payouts_enabled`.
- Transfer amount cannot exceed available earnings.
- Transfer retry reuses idempotency key and creates one Stripe transfer.
- Failed transfer releases/retries allocation safely.
- Transfer reversal updates earning/transfer state once.
- Connected payout events update bank-payout projection without changing Convex earning totals twice.

### Ledger/DO tests

- Payment grant, usage settlement, refund, and dispute entries preserve materialized balance invariant.
- Concurrent reservations never overspend balance or per-key cap.
- Disabled/expired keys cannot consume free-tier calls.
- Partial Convex ingest response leaves rejected DO events pending.
- Lost acknowledgements remain idempotent.
- New authoritative sequence reconciles after grants and reversals.
- Negative Convex balance exposes zero spendable DO balance.
- Anonymous wallet administrative requests fail.

### Browser E2E

- Consumer completes Stripe test Checkout and sees realtime balance/history.
- Consumer paid browser fetch passes CORS and decrements wallet.
- Publisher completes Connect test onboarding.
- Publisher sees pending then available earnings.
- Admin/operator transfer reaches connected-account balance in test mode.
- Refund visibly reverses credits and blocks overspend.

## Suggested implementation order

1. Fix public wallet administrative route and DO reconciliation protocol.
2. Add Stripe SDK, config validation, payment schema, and webhook receipt/dedupe foundation.
3. Replace Polar Checkout with Stripe Checkout and verified credit grants.
4. Implement refunds/disputes and authoritative balance checkpoint propagation.
5. Add connected-account onboarding and account-state projection.
6. Replace derived/manual payout accounting with explicit earnings lifecycle.
7. Add idempotent Connect transfers and payout projection.
8. Replace billing/earnings/admin UI flows.
9. Delete Polar/manual-payout residue and update PRODUCT/FLOW/TECH only after behavior passes smoke/E2E tests.

## Go/no-go gates

### Sandbox GO

Proceed when:

- Stripe test account and Connect access exist.
- Connect account configuration is selected.
- Checkout product/Price IDs exist.
- Webhook endpoints can be registered.

### Production GO

Do not launch until:

- Stripe approves exact pooled-credit marketplace model.
- Legal/tax owner accepts platform/MoR obligations.
- Supported publisher countries and currencies are fixed.
- Refund, dispute, debt, risk-hold, and payout policies are written.
- Wallet route and reconciliation P0s are fixed and tested.
- Payment, refund, transfer, and webhook replay tests pass.
- Operational runbook covers failed webhooks, disputes, negative balances, failed transfers, disabled connected accounts, and secret rotation.

## Official Stripe references

- Marketplace architecture: https://docs.stripe.com/connect/marketplace
- Connect merchant-of-record rules: https://docs.stripe.com/connect/merchant-of-record
- Separate charges and transfers: https://docs.stripe.com/connect/separate-charges-and-transfers
- Connect charge types and platform liability: https://docs.stripe.com/connect/charges
- Connected-account onboarding: https://docs.stripe.com/connect/onboarding
- Embedded onboarding: https://docs.stripe.com/connect/embedded-onboarding
- Connect webhooks: https://docs.stripe.com/connect/webhooks
- General webhook verification/retries/order: https://docs.stripe.com/webhooks
- API idempotency: https://docs.stripe.com/api/idempotent_requests
- Refunds: https://docs.stripe.com/api/refunds/create
- Transfer reversals: https://docs.stripe.com/api/transfer_reversals
- Stripe Tax with Connect: https://docs.stripe.com/tax/connect
- Managed Payments limitations: https://docs.stripe.com/payments/managed-payments/how-it-works
