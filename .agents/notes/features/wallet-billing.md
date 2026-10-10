# Wallet & billing

> Status: partial (P0 #5 + P1 #8 built; P1 #12 spend controls planned; real-money journey unproven) · Updated: 2026-10-10
> Code: `apps/gateway/src/wallet.ts`, `apps/gateway/src/settlement-queue.ts`, `apps/gateway/src/usage.ts`, `convex/wallets.ts`, `convex/billing.ts`, `convex/accounting.ts`, `convex/usage.ts`, `convex/http.ts`, `convex/cronTasks.ts`, `apps/web/src/routes/app/billing.tsx`, `apps/web/src/routes/app/index.tsx`, `apps/web/src/routes/app/settings/activity.tsx`, `e2e/04-payment-drill.sh`
> Related: [pricing](pricing.md), [earnings-payouts](earnings-payouts.md), [machine-payments](machine-payments.md), [gateway](gateway.md), [api-keys](api-keys.md), [accounts-orgs](accounts-orgs.md), [platform-admin](platform-admin.md), [webhooks-notifications](webhooks-notifications.md), [decision: platform fee publisher side](../decisions/2026-10-10-platform-fee-publisher-side.md), [decision: dual rail](../decisions/2026-10-10-dual-rail-keys-and-x402.md), [decision: card fee floor (proposed)](../decisions/2026-10-10-card-fee-floor.md), [stripe discovery](../research/stripe-connect-discovery.md)

Org-scoped prepaid credit wallet. Consumer organizations buy credits through one-time top-ups; every metered call draws from the org wallet; zero balance blocks the call. Billing screens show balance, top-ups, usage with projection, per-member/key/API/endpoint breakdown and itemized charges. Convex owns the ledger; a Durable Object per org wallet gates calls at the edge; Stripe supplies external payment/refund/dispute facts.

## Product

- Consumers (human devs and AI agents) pre-pay for credits — **org-scoped**: the organization owns the wallet, member keys draw from it, admins see per-member and per-key attribution. Solo devs get a personal org automatically; there is no separate personal-wallet model
- Each call deducts credits based on the endpoint's price
- **Zero balance blocks the call.** Never a surprise overage
- **Exchange rate: $1 = 10,000 credits** (1 credit = $0.0001). Market per-call pricing of $0.002–$0.05 maps to 20–500 credits. Rate is a launch default, revisitable — but one global constant, never per-API
- Credits are prepaid by consumer organizations via one-time top-up purchases
- **Platform fee is publisher-side (decided 2026-10-10)**: a consumer who tops up $10 gets $10 of credits — no top-up surcharge (unlike OpenRouter's 5.5%). Zevium keeps 5% of each call's spend; publisher gets 95%. Chosen to be consumer-friendly. See [decision](../decisions/2026-10-10-platform-fee-publisher-side.md) and [pricing](pricing.md)
- **Two payment rails (decided 2026-10-10, not built)**: enterprises use API keys + org wallet + prepaid top-ups (this feature). Individuals/agents use keyless x402 funding an ephemeral wallet; zero balance still blocks; same 95/5. See [machine-payments](machine-payments.md)
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
- Usage: current-cycle consumption + **projected** end-of-cycle spend; breakdown per member, per key, per API, per endpoint
- Charges history: itemized, each charge links to the exact call
- Spend controls (P1): budget with 50/75/100% threshold alerts (email + in-app), signed budget webhooks, hard-cap toggle
- Note: zero balance always blocks calls — the "cap" here is the alerting budget, not the wallet

### Activity — `/app/settings/activity`

- Filterable account activity + call log: timestamp, API, endpoint, status, credits charged, latency

### Machine surface

- Insufficient balance on `/gateway` returns `402` with machine-readable create-key / top-up / docs actions — see [gateway](gateway.md) and [machine-payments](machine-payments.md)

## Tech

### Why Stripe Checkout + Connect (Checkout / USD / ledger authority)

- Checkout collects fixed, one-time credit-pack payments. A verified paid event grants the consumer organization exactly once; browser redirects never grant credits.
- Launch accounting is USD-only. Stripe Checkout adaptive pricing is disabled, and the platform Stripe account must settle into a USD balance so Connect transfers use the same currency as the credit ledger. A non-USD platform requires an explicit FX ledger before use.
- Convex remains authoritative for credits, 95/5 usage settlement, earning holds, reversals, and transfer eligibility. Stripe Billing meters/customer credits never gate gateway calls.
- Stripe supplies external payment/refund/dispute/transfer/payout facts. Current code creates the platform charge and later transfer; legal role, tax, refund and dispute allocation remain launch blockers (#315) and are not settled by architecture text

Connect bullets live in [earnings-payouts](earnings-payouts.md).

### Credit gate design (the hot path)

- **Durable Object per org wallet**: single-threaded actor = race-free reserve/settle/refund with zero lock code, lives at the edge near traffic
- Convex ledger is authoritative; DO holds a monotonic balance/sequence checkpoint plus active reservations and pending settlements. DO batches stable settlement refs to Convex; Convex returns per-ref `applied`/`already_applied`/`rejected` outcomes and a newer checkpoint. Only accepted refs are acknowledged, so lost acknowledgements and partial rejection converge without dropping usage.
- Zero balance **blocks** ([product](../product/overview.md) rule: never surprise-overage). DO answers in-memory → sub-ms gate

Key-verification bullet lives in [api-keys](api-keys.md).

### Domain ownership (Convex schema sketch)

- `wallets` + `walletEntries` (append-only ledger entries + materialized authoritative balance)
- `usageEvents` (per-call: project, endpoint, org, credits, latency, status) + rollup tables via cron (publisher analytics p95/p99 come from here)
- `organizationPayments`, `checkoutIntents`, `payments`, `paymentEvents` (Stripe customer/Connect projection, hosted Checkout correlation, durable webhook dedupe)

### Implementation notes

- **Usage ingest pipe**: the wallet DO's alarm (~5s, non-empty pending queue) batches settled usage and `POST`s it to `{CONVEX_SITE_URL}/ingest-usage`, an `httpAction` authenticated by a shared `x-internal-secret` header (`GATEWAY_INTERNAL_SECRET`) — no Convex deploy key on the hot path. `CONVEX_DEPLOY_KEY` remains as a fallback constructor path only, unused when the shared secret is configured. Release automation sends a fresh cryptographic challenge through the authenticated gateway request and persists it atomically with settlement metadata. Separate `RELEASE_PROBE_SECRET` protects bounded, one-time `/release-probe-accounting`; lookup binds request id + challenge + freshness + stamped gateway release, verifies consumer-wallet ownership and materialized ledger checkpoint, and returns minimal settlement/split totals without consumer identity, key, balance, sequence, or lifecycle state
- **Stripe payments**: `billing.createCheckout` is admin/owner-only and creates server-priced hosted Checkout sessions. Its cancel URL carries only the local checkout-intent id; `getBillingState` resolves it under the active org before showing canceled state. Platform and Connect webhook routes verify raw-body signatures, persist each receipt and its scheduled processor in one transaction, lease processing attempts, retry with bounded backoff, and recover abandoned leases every minute. Every positive wallet source becomes a universal funding lot. Non-refundable promotion/admin inventory is consumed first, then refundable payment/restoration inventory FIFO; negative adjustments use the same fully preflighted allocator. Compatible lots compact into derived inventory with immutable root-to-derived lineage, and each settlement batch has a total-write budget rather than only an input-count cap. Refund/dispute exposure removes only the affected payment's unspent inventory. Pending and `requires_action` refunds reserve exposure; failed/canceled transitions restore publisher exposure first and then mint an exact payment-bound restoration lot for wallet inventory. Publisher clawback/restoration runs through a durable eight-row source-specific reconciliation journal, so a million historical allocations never enter one mutation. Only Stripe `funds_withdrawn` / `funds_reinstated` events move dispute money. Stripe API version is pinned in code.
- **Fresh-deployment finance schema (#354)**: migration jobs, audits, recovery/quarantine operators, legacy payment funding tables, and global runtime migration gates are removed. Wallet and publisher ledger operations retain idempotency, balance checks, atom accounting, and refund/dispute reconciliation. `walletFundingStates.migrationWatermarkSequence` remains a required runtime checkpoint: it must match the wallet ledger sequence; it is not a migration gate. Fields still omitted by supported write paths remain optional. Unknown connected-account payout webhooks remain ignored.
- **Stripe webhook subscriptions**: configure `/stripe-webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `payment_intent.payment_failed`, `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`, all five dispute events (`charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`), and `transfer.created`, `transfer.updated`, `transfer.failed`, `transfer.reversed`. Configure connected-account snapshot events at `/stripe-connect-webhook` for `payout.created`, `payout.updated`, `payout.paid`, `payout.failed`, and `payout.canceled`. Account v2 thin notifications use `/stripe-connect-v2-webhook` for `v2.core.account.closed`, `v2.core.account.updated`, `v2.core.account[configuration.recipient].updated`, `v2.core.account[configuration.recipient].capability_status_updated`, and `v2.core.account[requirements].updated`. Use each destination's corresponding signing secret. Dispute-created/closed events alone do not project money movement; missing withdrawal/reinstatement subscriptions can leave withdrawn credits spendable or prevent restoration. After repairing subscriptions, resend the exact missed provider events to the matching destination.
- **Payment-drill acceptance**: payment drills run as part of the preview E2E suite against the isolated preview deployment. Browser commands run with only browser session env, provider commands receive only restricted test keys/provider identifiers, and ledger commands receive only Convex/deployment identifiers. Direct Stripe Accounts/transfer/payout primitives remain supplemental-only.
- **Refund acceptance**: paid-call evidence follows exact `x-zevium-request-id` values through `settle:{requestId}` wallet entries, usage rows, project publisher identity, and contiguous wallet sequences. Partial and remaining refunds must match exact provider refund ids, exposure rows, payment/event receipt, and wallet reversal journal. Acceptance waits for publisher reconciliation status `complete`; `pending`, `running`, or `failed` is terminal proof failure. Every active exposure must be fully applied and all source-specific clawbacks, affected earnings, publisher journal atoms, materialized balance buckets, aggregate pending/reversed/failed atoms, and wallet credits must conserve. Its intentional failure remains a disposable attempt-tagged `charge.refunded` canary; proof requires exclusive canonical/canary v1 topology and zero competing v2 snapshot destinations before replay.
- **Payment-drill compensation**: `PAYMENT_DRILL_PHASE=cleanup` always removes only attempt canaries, verifies canonical endpoint identity, completes exact remaining payment refund and publisher reconciliation, fully reverses app transfer, waits for `transfer.reversed`, and restores available/allocated/paid publisher buckets while preserving exact post-refund pending/reversed/failed aggregates. Provider-primitives cleanup separately closes its temporary v2 account, reverses test payout/transfers, and refunds source charges. Acceptance artifact generation is fail-closed: only explicitly allowlisted schema fields become minimal DTOs, identifiers use stable keyed hashes, and exact/encoded credentials, cookies, client secrets, and raw Clerk/Convex/Stripe ids are rejected. After runner loss, recover exact Checkout from `checkoutIntentId`, Clerk org, run reference, and workflow time; retry only exact event against canonical endpoint, then rerun cleanup with same reference. Never close payment proof work without one green real manual run and sanitized acceptance DTO.

### Code facts (read from source 2026-10-10, not in source docs)

- `convex/accounting.ts`: `CREDITS_PER_USD = 10_000`; `PLATFORM_FEE_BASIS_POINTS = 500`
- `convex/billing.ts` `CREDIT_PACKS`: `pack_10` $10 → 100,000 credits, `pack_50` $50 → 500,000, `pack_100` $100 → 1,000,000 (flat rate, no bonus, no surcharge). Stripe Price ids from env `STRIPE_PRICE_PACK_10|50|100`. Packs returned in that order (smallest first)
- `convex/billing.ts` `cycleBreakdown`: UTC calendar-month cycle; breakdown `byKey` / `byMember` / `byProject` / `byEndpoint`; members without `viewOrgUsage` capability see only their own rows. `projectedCycleCredits` = linear month-end projection
- `convex/cronTasks.ts` `checkLowBalances`: hourly, `low_balance` notification when balance < 1,000 credits, once per org per UTC day

### Remaining launch work (tracked in [roadmap](../product/roadmap.md), backlog truth 2026-07-19)

- **Prove real payment and settlement journey** (Now — launch blocker)
  - Configure staging environment variables/secrets used by `.github/workflows/payment-drill.yml`.
  - Manually run authenticated publish/call plus real Stripe Checkout, refund, and Connect settlement drill.
  - Scheduled payment drills currently run deterministic tests only.
- **Finish external production gates** (Now — launch blocker)
  - Obtain written Stripe approval for pooled prepaid credits across independent publishers.
  - Accept platform/MoR legal and tax obligations.
  - Fix supported countries/currency and write refund, dispute, debt, risk-hold, and payout policies.
  - Complete operational runbook required by [stripe-connect-discovery](../research/stripe-connect-discovery.md).
- **Production acceptance journey** (Next — P0 gap)
  - Using separate publisher and consumer orgs: publish → buy credits → issue key → paid gateway call → usage ingest → 95/5 earnings → Connect transfer.
  - Also verify keyless mock and MCP calls against same listing.

## Decisions

- 2026-07-12 — Stripe Checkout + Connect replace Polar checkout + manual payouts; Convex is the credit-ledger source of truth (own tables), Worker holds the edge gate. Replaces vendor credit ledgers + Redis gate. See [architecture overview](../architecture/overview.md)
- 2026-10-10 — Platform fee taken publisher-side: $10 top-up = $10 credits, no top-up surcharge; Zevium keeps 5% of each call's spend. Consumer-friendly. [decision](../decisions/2026-10-10-platform-fee-publisher-side.md)
- 2026-10-10 — ACCEPTED: two rails — enterprises on API keys + org wallet + prepaid top-ups; individuals/agents on keyless x402 funding an ephemeral wallet. [decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md), detail in [machine-payments](machine-payments.md)
- 2026-10-10 — ACCEPTED: card processing fee passed through at cost as a separate, transparent line on top-ups (OpenCode Zen style); credits stay face value; no minimum-top-up floor. [decision](../decisions/2026-10-10-card-fee-passthrough.md)
- 2026-10-10 — ACCEPTED: new orgs get ~$1 default promotional credit so free-tier and first calls work at signup. [decision](../decisions/2026-10-10-signup-credit.md)

## Open questions

- Card-fee passthrough: legal check of surcharge rules per card network/region; fee per payment method; whether the fee is refunded with credits. See [decision](../decisions/2026-10-10-card-fee-passthrough.md)
- Signup credit: amount, verification/anti-farming rule. See [decision](../decisions/2026-10-10-signup-credit.md)
- Doc/code conflict: FLOW says "larger denominations surfaced first"; code returns packs $10, $50, $100 (smallest first). Code wins until FLOW or code changes
- Doc/code conflict: research doc ([stripe-connect-discovery](../research/stripe-connect-discovery.md)) says packs carry "larger-pack bonuses in `convex/billing.ts`"; code packs are flat 10,000 credits/$ with no bonus. Code wins
- P1 #12 spend controls (50/75/100% budget alerts, signed budget webhooks, hard-cap toggle) not built; only the undocumented low-balance cron (< 1,000 credits) exists
- Billing route still `/app/billing`; FLOW target is `/app/organizations/{org}/billing`
- Credit policy unsettled before production (from research doc): org-wallet credit expiry, refundability, promotional credits, abandoned/unclaimed balances, organization closure. Anonymous-wallet expiry is decided separately in [machine-payments](machine-payments.md)
- Dual-rail decision adds a wallet keyed to payer address; PRODUCT still says "there is no separate personal-wallet model". Reconcile wording and ledger shape for ephemeral wallets
