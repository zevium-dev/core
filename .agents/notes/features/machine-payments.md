# Machine payments (x402)

> Status: built behind configuration (#109); real sandbox settlement blocked by owner setup · Updated: 2026-10-10
> Code: `apps/gateway/src/machine-payments.ts`, `machine-facilitator.ts`, `wallet-session.ts`, `wallet.ts`, `convex/machinePayments.ts`, `convex/lib/funding.ts`, `packages/shared/src/machine-payments.ts`
> Related: [wallet-billing](wallet-billing.md), [gateway](gateway.md), [agent-surface](agent-surface.md), [dual rail](../decisions/2026-10-10-dual-rail-keys-and-x402.md), [expiry](../decisions/2026-10-10-anonymous-wallet-expiry.md)

## Product

Individuals and agents can fund a wallet without an account or API key. One $1 payment buys 10,000 credits. Calls spend those credits at the published spec price, with the existing 95% publisher / 5% platform split. There is no anonymous signup credit. Zero spendable balance blocks even free endpoints.

Each top-up expires one calendar year after funding. Spending uses the oldest unexpired top-ups first; a later top-up does not extend earlier funds. Organizations using API keys retain their existing non-expiring wallets.

## Flow

1. Call `/gateway/:publisher/:project/*` without credentials. When configured, the 402 includes a $1 x402 offer and existing create-key, top-up, and docs actions.
2. Retry with the signed payment proof. Confirmed settlement funds the payer's wallet; the same request runs through the normal metered pipeline.
3. Save the returned wallet session and send it as a Bearer credential on later HTTP calls or MCP `call_api` calls. The session lasts 24 hours and accesses public APIs only.
4. Empty wallets receive another payable 402. Another payment from the same payer restores access to all remaining unexpired funds. A repeated payment cannot fund twice and does not issue another session.

## Tech

- x402 V2 headers: `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`; the credential is returned in `X-Zevium-Wallet-Session`. Requirements advertise Base USDC, `exact`, 1,000,000 atomic units ($1). The `zevium-wallet` extension explains the top-up and credential contract. The offer is funding, not an alternate endpoint price.
- Stripe's current x402 docs use an **external facilitator** for `/verify` and `/settle`, a **Stripe-owned deposit address**, then a Stripe `transaction_verification` PaymentIntent. The adapter requires a succeeded $1 USD PaymentIntent before crediting Convex. Stripe remains the funds/off-ramp provider; Connect earnings/payout processing stays on the existing ledger path. MPP is not a second wire protocol in this implementation.
- `MachineFacilitator` isolates that integration. The default adapter uses a configured private V2 facilitator proxy (CDP authentication stays at the proxy), validates the server-owned requirements, verifies payer identity, checks settlement network/transaction, and records Stripe with a transaction-derived idempotency key. No chain SDK enters the gateway bundle.
- A proof-scoped Durable Object serializes payment attempts and persists the settlement receipt before recording Stripe. Retries after Stripe failure reuse that receipt. If Stripe replays an initial `processing` create response, the adapter retrieves the current PaymentIntent before deciding whether credits can be granted. Convex deduplicates both Stripe payment ID and `(network, transaction)`. Duplicate funding returns 409; projection retry can repair a missing edge grant without issuing a new session or adding funds twice.
- Accounting owner: `organizations.walletKind = anonymous`, with namespaced `clerkOrgId = x402:<network>:<lowercase payer>`. This is an internal accounting container, not a Clerk organization: no members, public handle, customer creation, or signup grant. Reusing the existing org foreign keys preserves settlement, funding allocation, publisher earnings and Connect behavior.
- Each payment creates a `machine_payment` funding lot with `expiresAt`. These lots never compact together. Expired unused lots remain in the audit ledger; the raw ledger balance includes that inventory, while the edge's **spendable** balance excludes it. This avoids recognizing accounting breakage prematurely or discarding valid late usage. No expiry grant or signup credit can extend a lot.
- Edge reservations record exact lot slices and admission time, persisted with holds and settlements. Convex validates wallet ownership, admission before expiry, remaining lot inventory and amount totals before committing the standard ledger entry and earnings. Out-of-order delivery cannot switch funding sources. A reservation admitted before expiry may complete afterward. Refunded/expired holds do not revive expired funds. At most 24 lots fund one call, matching the existing transaction budget; larger fragmentation fails closed.
- Token-priced calls reserve oldest lots at the estimated maximum, consume only the oldest reserved slices needed for actual usage, and release the rest with their original expiry. The in-flight token budget excludes expired inventory. Free and refunded calls carry empty lot allocations so their usage remains auditable.
- Session: HMAC-SHA256, versioned `zev_ws_` credential, payer/network subject, gateway-origin audience, `gateway:public` scope, issuance and expiry timestamps. Local verification only. Anonymous key controls and grants never fetch Convex/Clerk on admission, including a cold DO. Paid usage still flushes asynchronously. Payment proofs and session headers are stripped before upstream forwarding; CORS exposes payment/session response headers.
- `POST /machine-fund` is gateway-secret protected and only accepts verified payment facts. It calls an internal mutation. It is not a public client-funded credit mutation.
- Tests: `apps/gateway/test/machine-payments.test.ts` and `convex/machinePayments.test.ts` cover the offer/pay/session/empty/replay path, no admission-time control-plane calls, session tampering/audience/expiry, lot admission/expiry, payment HTTP contract, source attribution, and 95/5 earnings.

### Owner setup and sandbox evidence

The rail is disabled unless all optional gateway bindings are present: `X402_DEPOSIT_ADDRESS`, `X402_FACILITATOR_URL`, `X402_FACILITATOR_TOKEN`, `X402_STRIPE_SECRET_KEY`, `WALLET_SESSION_SECRET`. The usual Convex URL and gateway shared secret are also required.

1. Replace the expired configured Stripe test key with a test restricted key permitted to create deposit addresses and create/read transaction-verification PaymentIntents. Request machine/stablecoin access. Provision the Stripe-owned Base deposit address outside the request path; never use a Zevium custody address.
2. Provide a private V2 facilitator proxy with appropriate CDP credentials and verify its `/verify` and `/settle` contracts against the adapter tests. Confirm a Stripe-supported sandbox network/transaction flow with Stripe before sending any real funds; this adapter advertises Base, not Tempo or Base Sepolia.
3. Supply the bindings as gateway secrets and deploy Convex schema/functions before gateway. Use an independent random signing secret of at least 32 characters.
4. Complete a **real sandbox** offer → pay → session → calls → exhaustion journey, verify the Stripe PaymentIntent and Convex lot/earnings, then replay the proof and verify no second grant. This has not been completed. Test-double contract coverage is not a real Stripe settlement.
5. If choosing MPP instead, first create a sandbox business profile and implement a payer-address-bearing adapter; an SPT alone is not a wallet address. Do not advertise MPP support until that wire protocol is implemented and tested.

Observed 2026-10-10: the configured test account initially accepted Base deposit-address creation (HTTP 200); MPP business-profile lookup returned 404 `not_found`. A later test-only transaction-verification probe returned 401 `api_key_expired`. No live keys or live money were used. No full sandbox journey is claimed.

### Operational limits

- Refund/expiry breakage policy remains an owner launch decision. Anonymous lots are classified non-refundable in the current automatic allocation path; no automatic machine-payment refund/reversal projection is advertised.
- A lost successful HTTP response also loses its bearer session. Replaying the payment remains refused; a fresh top-up from the same payer can access existing unexpired funds. Wallet-signature session recovery is not built.
- A crash between external on-chain settlement and durable receipt persistence requires facilitator transaction recovery/manual reconciliation. Never tell an operator to pay a second time to repair that gap.

### Research facts (historical research, 2026-10-10)

Source: [landscape](../research/agent-api-marketplace-landscape.md), raw notes [agent_payment_rails.md](../research/agent-api-marketplace-landscape/agent_payment_rails.md). Secondary-source figures are labeled.

- **x402 protocol**: server returns `402` with `PAYMENT-REQUIRED` header (base64 `PaymentRequired`); client retries with `PAYMENT-SIGNATURE` (`PaymentPayload`); server returns `PAYMENT-RESPONSE` (base64 settlement response). Resource server calls facilitator `/verify` + `/settle` or settles on-chain itself. Schemes: `exact`, `upto`, `batch-settlement` (EVM). Non-custodial by design — [github.com/x402-foundation/x402](https://github.com/x402-foundation/x402)
- **x402 V2** (2025-12-11): unified network/asset format, card/ACH/SEPA facilitators, wallet-based sessions so callers skip repaying every call, automatic API discovery — [x402.org V2 launch](https://www.x402.org/writing/x402-v2-launch)
- **CDP facilitator**: 1,000 on-chain tx/month free, then $0.001/tx; verification free; `batch-settlement` claims many vouchers in one tx; ERC-20 on Base, Polygon, Arbitrum, World, Solana — [CDP facilitator docs](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator)
- **x402 Foundation** operational under Linux Foundation 2026-07-14; premier members include Stripe, Visa, Mastercard, Google, AWS, Cloudflare, Coinbase — [x402 Foundation press](https://x402.org/linux-foundation-announces-operational-launch-of-x402-foundation-to-standardize-internet-native-payments-for-ai-agents-and-applications/)
- **Stripe machine payments / MPP** (launched 2026-03-18 with Tempo): cards via Shared Payment Tokens at $0.50 minimum; stablecoins at 0.01 USDC minimum settlement; MPP sessions pre-deposit and charge sub-cent increments. Stripe also accepts x402 on Base (USDC). Stablecoins auto-offramp into Stripe balance in fiat; refunds via normal Refunds API; "available for Connect platforms across all charge types". Stablecoin acceptance excludes New York — [docs.stripe.com/payments/machine](https://docs.stripe.com/payments/machine)
- **MPP server**: `mppx` (`Mppx.create`, `mppx.charge({amount})`), HMAC-bound challenges, `npx mppx validate`; fetch-style handler fits a Worker. `hostedFeePayer` cannot combine with Connect. API still preview (`Stripe-Version: 2026-07-29.preview`). Keep deposit-address creation off the core request path — [Stripe MPP docs](https://docs.stripe.com/payments/machine/mpp)
- **Worker SDKs**: `@x402/hono`; Cloudflare Agents SDK `withX402` / `paidTool` — [CF docs](https://developers.cloudflare.com/agents/x402/charge-for-mcp-tools/)
- **Live keyless→x402 pattern**: Tavily keyless API returns `hourly_cap_reached` with a `next_actions` `agentic_payment` entry pointing to x402 (observed 2026-10-10) — [Tavily x402 docs](https://docs.tavily.com/documentation/machine-payments/x402)
- **Traction**: CDP claims >100M x402 payments (primary, undated) — [CDP welcome](https://docs.cdp.coinbase.com/x402/welcome); dollar volume small, heavy test/wash noise (secondary). Bazaar snapshot 2026-10-09: 34,062 listings, 94% missing a "use when" line — [DEV](https://dev.to/tanod/state-of-the-x402-bazaar-34062-listings-2158-hosts-and-94-missing-a-use-when-line-34co)
- **Compliance**: lowest-burden path keeps Stripe as regulated party (funds land in Stripe balance, publishers paid via Connect). Own facilitator with Zevium-owned `payTo` puts pooled USDC on Zevium's books (custody, off-ramp, sanctions screening, possible MTL). Per-publisher `payTo` breaks the 95/5 ledger (research inference)
- **Competition**: Cloudflare Monetization Gateway (announced 2026-07-01, waitlist) paywalls APIs/MCP tools with x402 at the edge — [Cloudflare blog](https://blog.cloudflare.com/monetization-gateway/)
- **Research gaps**: Stripe fee for MPP/x402 not found; whether Stripe-accepted x402 fires standard `payment_intent.succeeded` webhooks unconfirmed; Stripe x402 + Connect charge-type compatibility unconfirmed; verification latency unknown

## Decisions

- 2026-10-10 — BUILT behind configuration: payer-bound wallet sessions, zero-balance gate, 95/5 split, $1 top-up default, anonymous accounting organizations. [Dual rail](../decisions/2026-10-10-dual-rail-keys-and-x402.md).
- 2026-10-10 — BUILT: per-top-up one-year expiry, oldest-first admission. [Expiry](../decisions/2026-10-10-anonymous-wallet-expiry.md).
- 2026-10-10 — P0 priority. [Agent bet](../decisions/2026-10-10-p0-agent-bet.md).

## Open questions

- Complete owner setup and the real sandbox settlement evidence before enabling production.
- Accounting breakage, anonymous refunds, sanctions screening and session recovery policy before launch.
