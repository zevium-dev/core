# Wallet & billing

> Status: root cutover implemented; owner activation pending; estimated card fee (#318) built, disabled pending legal · Updated: 2026-10-17
> Code: `convex/{billing,stripeEvents,wallets,usage}.ts`, `convex/money/`, `convex/schema/wallet.ts`, `apps/web/src/routes/app/billing.tsx`, `apps/web/src/lib/stripe-ui.ts`, `tests/{money,finance,financeThroughput,sourceLocks,edge}.test.ts`, `tests/sourceLocksRacesHarness.ts`, `apps/gateway/scripts/next-acceptance.mjs`
> Related: [pricing](pricing.md), [earnings-payouts](earnings-payouts.md), [machine-payments](machine-payments.md), [gateway](gateway.md), [api-keys](api-keys.md), [accounts-orgs](accounts-orgs.md), [platform-admin](platform-admin.md), [webhooks-notifications](webhooks-notifications.md), [decision: platform fee publisher side](../decisions/2026-10-10-platform-fee-publisher-side.md), [decision: dual rail](../decisions/2026-10-10-dual-rail-keys-and-x402.md), [decision: card fee floor (proposed)](../decisions/2026-10-10-card-fee-floor.md), [stripe discovery](../research/stripe-connect-discovery.md)

> Email (#320): built, dormant until configured. Code: `convex/notificationEmail.ts`, `convex/notificationEmailAction.ts`, `convex/lib/notificationEmail.ts`, `convex/notificationEmail.test.ts`.

Org-scoped prepaid credit wallet. Consumer organizations buy credits through one-time top-ups; every metered call draws from the org wallet; zero balance blocks the call. Billing screens show balance, top-ups, usage with projection, per-member/key/API/endpoint breakdown and itemized charges. Convex owns the ledger; a Durable Object per org wallet gates calls at the edge; Stripe supplies external payment/refund/dispute facts.

## Product

- Consumers (human devs and AI agents) pre-pay for credits — **org-scoped**: the organization owns the wallet, member keys draw from it, admins see per-member and per-key attribution. Solo devs get a personal org automatically; keyless funding is deferred; see the deferred machine-payment design
- Each call deducts credits based on the endpoint's price
- **Zero balance blocks the call.** Never a surprise overage
- **Exchange rate: $1 = 10,000 credits** (1 credit = $0.0001). Market per-call pricing of $0.002–$0.05 maps to 20–500 credits. Rate is a launch default, revisitable — but one global constant, never per-API
- Credits are prepaid by consumer organizations via one-time top-up purchases
- Signup grants $1 (10,000 credits) of nonrefundable promotion to the first organization a Clerk user creates, once per user ever. First processed signed creation wins; Clerk automatic org creation supplies the usual personal org. Joining an organization or creating later organizations grants nothing. Promo spends first; anonymous wallets receive nothing.
- **Platform fee is publisher-side (decided 2026-10-10)**: a consumer who tops up $10 gets $10 of credits — no platform top-up surcharge. A separate estimated card fee is accepted but legal-gated in #318. Zevium keeps 5% of each call's spend; publisher gets 95%. Chosen to be consumer-friendly. See [decision](../decisions/2026-10-10-platform-fee-publisher-side.md) and [pricing](pricing.md)
- **Retained second rail (#109; disabled by decision, enforcement #424 pending)**: enterprises use API keys + org wallet + prepaid top-ups (this feature). Future keyless x402 funds an ephemeral wallet; zero balance still blocks; same 95/5. See [machine-payments](machine-payments.md)
- **Two payment rails (#109 built behind configuration)**: enterprises use API keys + org wallet + prepaid top-ups (this feature). Individuals/agents use keyless x402 funding an ephemeral wallet; zero balance still blocks; same 95/5. See [machine-payments](machine-payments.md)
- **Billing transparency**: usage dashboard with current-cycle consumption + projected cost, per-key and per-endpoint breakdown; spend alerts at 50/75/100% thresholds; budget webhooks
- Consumers see: one gateway URL per API, one key, one wallet, itemized charges

Roadmap ([roadmap](../product/roadmap.md)):

- P0 #5 — Usage dashboard (org wallet balance, per-member/per-key/per-endpoint, projections) + real activity log
- P1 #8 — Org-scoped wallets (member keys draw from org balance, per-member attribution)
- P1 #12 — Spend caps, threshold alerts, budget webhooks

## Flow

### App dashboard — `/app` (wallet card)

- Wallet balance card (live-ticking), calls this cycle + projected spend, recent calls, quick actions (top up, keys, browse)
- First-visit onboarding checklist: get key → make first call → top up

### Wallet & billing — `/app/organizations/{org}/billing`

Current screen: `/app/billing`. Org switcher selects workspace for this and every org-scoped screen; URL does not repeat org slug.

Org-scoped — the org owns the wallet; admins manage it, members view their own attribution.

- Balance (live), Buy Credits (hosted checkout, credit-pack products — larger denominations surfaced first), top-up history
- Card fee (off until legal approval, #318): each pack shows credits, estimated card fee and total before payment; hosted Checkout shows the same two lines. The fee buys no credits and never changes after payment. A full refund returns it
- Credits from a payment under review are on hold: shown under the balance, not spendable, other credits still work. They return once the payment is reconciled
- Usage: current-cycle consumption + **projected** end-of-cycle spend; breakdown per member, per key, per API, per endpoint
- Charges history: itemized, each charge links to the exact call
- Spend controls (P1): budget with 50/75/100% threshold alerts (email + in-app), signed budget webhooks, hard-cap toggle
- Note: zero balance always blocks calls — the "cap" here is the alerting budget, not the wallet

### Activity — `/app/settings/activity`

- Filterable account activity + call log: timestamp, API, endpoint, status, credits charged, latency

### Machine surface

- Insufficient balance on `/gateway` returns `402` with machine-readable create-key / top-up / docs actions — see [gateway](gateway.md) and [machine-payments](machine-payments.md)

## Tech

Stripe SDK 23.0.0 keeps the explicit `2026-06-24.dahlia` API pin in `convex/lib/stripe.ts`; SDK-generated Endive types require a documented compatibility directive. Signed Checkout/refund/dispute fixtures remain offline; canonical Checkout requests also assert the wire version. `tests/stripeSdk.test.ts` verifies both API and incomplete-body connection errors remain ambiguous outcomes.

Activity (`apps/web/src/routes/app/settings/activity.tsx`) keys only its `ActivityCalls` list/inspector subtree by the filter window (range + authorized list arguments). The remount freezes one `Date.now()` per filter window (lazy state, no render-time clock read) while the filter selects stay mounted and keep keyboard focus.

Legacy WalletSqliteDO test data is disposable by the 2026-10-11 owner decision. Exact-target discard (default) or optional pinned-release export still needs owner sign-off before v6; see the activation runbook. No existing NextWalletDO journal is covered by that discard approval.

Root money modules own append-only wallet journals, materialized balances, promo/admin/paid FIFO lots and indexed original-source balances. Dust moves retain zero-delta source journals; 32-source admissions fail before upstream when fragmented. Verified test-mode Checkout grants principal atomically; refunds/disputes close/drain before paged exact-source reclamation and publisher clawback/restoration. Every page is generation fenced and globally throughput limited. Authentic unchargeable finals become retained zero-debit exceptions; no debt or synthetic grant. `needs_review` now drains then quarantines only affected original funding sources (#440); unrelated paid and promotional funds reopen. `fundingLotSources.state=locked` excludes those rows from allocation and dust moves, including inside mixed lots. `wallets.lockedCredits` tracks quarantined remaining inventory without changing the ledger; executable checkpoint balance is ledger balance minus locked credits. Containers carry an indexed `spendable` flag, true exactly when `by_lot_spend` finds an available source. Grant, consume, lock/unlock, reversal/restoration and merge maintain it in the same transaction using bounded source-index reads; settlement folds the flag into its existing container writes to retain the 150-write event budget. `by_spend` excludes locked-only containers before the 33-container limit and retains priority/creation/ID ordering. Edge snapshots already query available sources and the DO orders that same inventory before its 32-source cap. The schema field is required on fresh activation data. Dust discovery skips containers with no unlocked source; merging into a locked target row is refused. `billing.getBillingState` returns `wallet.lockedCredits` for the on-hold line. Lock pages fence checkpoints with gate revisions. Operator retry waits for quarantine completion, creates a fresh generation/close, restores only payment reversals, reapplies canonical facts and unlocks sources before reopening. Failed/canceled refunds or dispute reinstatement follow the same drained path. Every reopened `finishClose` path (including abandoned admin commands, restored adjustments and completed merges) schedules the shared wallet wake; delivery retries at 1/2/4 seconds after failed HTTP responses or transport errors. See [gateway](gateway.md) for immediate checkpoint refresh (#456). Lost DO journals still require real recovery; no timeout substitutes for drain. Stripe live keys/objects are refused.

Card fee (#318, built, off by default): `packQuote` in `convex/billing.ts` is the single quote source for billing state and Checkout. A pack without `NEXT_STRIPE_PRICE_PACK_{10,50,100}` is `available: false`. Fee off unless `NEXT_CARD_FEE_ENABLED=true`; then each pack needs `NEXT_STRIPE_FEE_PACK_{10,50,100}_CENTS` (positive integer) and `_PRICE` (fixed Stripe price of the same amount), else that pack is `available: false` and Checkout refuses it. `getBillingState.packs` returns `priceCents`/`feeCents`/`totalCents`/`available`; the billing page renders the breakdown via `checkoutPackPrice`. `prepareCheckoutIntent` snapshots quote, total and `feePolicyVersion` (`estimated-v1`/`disabled-v1`) on the intent; Checkout carries a separate fee line item labelled "Estimated card fee" (billing page, Checkout custom text and Stripe product name match). `createCheckout` retrieves each line's Stripe price and refuses Checkout unless active, one-time, USD and equal to the snapshotted cents; failures return a generic error and log only price id + failed check (`tests/finance.test.ts` "createCheckout verifies Stripe prices"). `projectPaid` matches the paid fact against the intent snapshot only (never current env), so replays and config changes cannot alter price; it grants principal credits only. Actual Stripe fee from the balance transaction lands as `processingFeeActualCents` and `processingFeeVarianceCents` (actual − charged): platform accounting facts, no customer debit. Refunds: `principalForCumulative` allocates principal as floor(cumulative refunded × principal ÷ paid); each refund takes the delta, remainder is fee. Cumulative full refund equals `amountPaidCents`, principal and fee sums equal charged amounts; Zevium absorbs Stripe's retained fee. Disputes allocate proportionally per dispute.

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

## Decisions

- 2026-10-11 — [Legacy wallet discard policy](../decisions/2026-10-11-legacy-wallet-discard.md), exact-target owner sign-off required before v6.

- 2026-10-11 — PR #442 applies [read-surface review defaults](../decisions/2026-10-11-read-surface-review-defaults.md), pending owner sign-off.

- [PR 4 review defaults](../decisions/2026-10-11-payment-review-defaults.md): A/B/C implemented as parent defaults, pending owner sign-off before activation; scoped B implemented in #440.

- [Promo self-consumption protection](../decisions/2026-10-11-promo-self-consumption.md): proposed, pending owner sign-off; same-org protection implemented in isolated PR #438.

- 2026-10-11 — Preserve durable notification/reconciliation facts in the 34-table isolated rebuild. [Decision](../decisions/2026-10-11-convex-rebuild-durable-facts.md).

- 2026-10-11 — ACCEPTED: DO spend authority, 30s snapshots, freeze/drain, no fixed-price debt; bounded lots and dust merge #353/#430. [Decision](../decisions/2026-10-11-edge-authority-and-lots.md).
- 2026-10-11 — ACCEPTED: grant once per Clerk user via their first signed organization creation; automatic creation supplies the signup personal org. First-processed delivery wins if creation webhooks race. Joined orgs never claim for the joining user; anonymous wallets receive nothing. [Decision](../decisions/2026-10-11-signup-credit-first-created-org.md).
- 2026-10-11 — ACCEPTED: Estimated fee, no true-up, full paid-amount refund; P0 #318 legal gate remains. [Decision](../decisions/2026-10-11-card-fee-and-refunds.md).
- 2026-10-11 — ACCEPTED: Per-token listings deferred; hide/disable #425, future policy P2 #431. [Decision](../decisions/2026-10-11-llm-deferred.md).
- 2026-10-11 — ACCEPTED: Anonymous breakage is Zevium revenue; no expiry warnings or expiry display in balance responses. #353/#424. [Decision](../decisions/2026-10-11-breakage-revenue.md).

- 2026-07-12 — Stripe Checkout + Connect replace Polar checkout + manual payouts; Convex is the credit-ledger source of truth (own tables), Worker holds the edge gate. Replaces vendor credit ledgers + Redis gate. See [architecture overview](../architecture/overview.md)
- 2026-10-10 — Platform fee taken publisher-side: $10 top-up = $10 credits, no top-up surcharge; Zevium keeps 5% of each call's spend. Consumer-friendly. [decision](../decisions/2026-10-10-platform-fee-publisher-side.md)
- 2026-10-10 — ACCEPTED: two rails — enterprises on API keys + org wallet + prepaid top-ups; individuals/agents on keyless x402 funding an ephemeral wallet. [decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md), detail in [machine-payments](machine-payments.md) (Historical; scope superseded 2026-10-11 above.)
- 2026-10-10 — ACCEPTED: card processing fee passed through at cost as a separate, transparent line on top-ups (OpenCode Zen style); credits stay face value; no minimum-top-up floor. [decision](../decisions/2026-10-10-card-fee-passthrough.md) (Historical; scope superseded 2026-10-11 above.)
- 2026-10-10 — BUILT (#317): $1 signup promotion, once per org and once per Clerk creator (verified-email signal unavailable). [decision](../decisions/2026-10-10-signup-credit.md) (Historical; scope superseded 2026-10-11 above.)

## Open questions

- Resolved #357: a stale balance no longer permanently rejects already-admitted usage; admission remains the wallet DO’s responsibility.

- Card fee: legal check of surcharge rules per card network/region remains the #318 launch gate; fee is one estimate per pack, not per payment method. Partial-refund allocation, full paid-amount refunds and no true-up are resolved and built
- Doc/code conflict: FLOW says "larger denominations surfaced first"; code returns packs $10, $50, $100 (smallest first). Code wins until FLOW or code changes
- Doc/code conflict: research doc ([stripe-connect-discovery](../research/stripe-connect-discovery.md)) says packs carry "larger-pack bonuses in `convex/billing.ts`"; code packs are flat 10,000 credits/$ with no bonus. Code wins
- P1 #12 spend controls (50/75/100% budget alerts, signed budget webhooks, hard-cap toggle) not built; only the undocumented low-balance cron (< 1,000 credits) exists
- Billing route still `/app/billing`; FLOW target is `/app/organizations/{org}/billing`
- Remaining credit-policy work before production: refund operations, abandoned/unclaimed balance handling and organization closure. Org funds never expire; signup eligibility and anonymous breakage are decided above. See [machine-payments](machine-payments.md) for deferred rail delivery.
- Anonymous machine-payment activation is deferred; refund mechanics and implementation of decided breakage accounting remain in [machine-payments](machine-payments.md).
