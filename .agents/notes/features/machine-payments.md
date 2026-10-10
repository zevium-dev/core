# Machine payments (x402)

> Status: planned (P0 since 2026-10-10) — direction decided 2026-10-10, nothing built · Updated: 2026-10-10
> Code: none for x402. Current non-x402 `402` envelope: `apps/gateway/src/payment-required.ts`, call sites in `apps/gateway/src/pipeline.ts`
> Related: [wallet-billing](wallet-billing.md), [gateway](gateway.md), [api-keys](api-keys.md), [agent-surface](agent-surface.md), [mock-sandbox](mock-sandbox.md), [earnings-payouts](earnings-payouts.md), [decision: dual rail](../decisions/2026-10-10-dual-rail-keys-and-x402.md), [decision: anonymous wallet expiry](../decisions/2026-10-10-anonymous-wallet-expiry.md), [research: landscape](../research/agent-api-marketplace-landscape.md)

Second payment rail for individuals and AI agents: pay with x402 instead of signing up for an API key and org wallet. Decided design: an x402 payment funds an ephemeral wallet keyed to the payer address (a wallet session); later calls draw from it at the edge, with no per-call on-chain settlement. Today only the prepaid-credit rail exists and `/gateway` returns a generic, non-x402 `402` recovery envelope.

## Product

- **Planned machine-native payments (x402, P1)** beside prepaid credits: a future signed-payment rail may let agents pay per call with zero signup. Current product uses API keys and prepaid credits only
- Roadmap: P1 #10 — x402 machine-native payments as second rail ([roadmap](../product/roadmap.md))

Decided 2026-10-10 (ACCEPTED, not built — [decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md)):

- **Two rails.** Enterprises: API keys + org wallet + prepaid top-ups ([wallet-billing](wallet-billing.md)). Individuals/agents: keyless x402
- **No per-call settlement.** Calls cost $0.002–$0.05; payment-rail minimums (0.01 USDC per settlement, $0.50 card) make paying each call individually unworkable. Instead an x402 payment funds a wallet tied to the payer; later calls draw from that balance
- **Zero balance still blocks the call.** Never a surprise overage
- **Same 95/5 split** as the key rail
- **Product rule amendment required**: "every gateway/agent call is key-authenticated" becomes "every call is authenticated by an API key or a verified wallet session"
- **Anonymous wallet expiry** (ACCEPTED, [decision](../decisions/2026-10-10-anonymous-wallet-expiry.md)): unused balance in anonymous (keyless) wallets expires after one year, "for now, can change later". Whether the clock starts at last top-up or last activity is open

## Flow

### x402 machine payments (P1) — current state

- Future signed-payment retry, facilitator verification, and settlement flow; no x402 payment implementation exists in the current tree
- Current `/gateway` authentication and credit failures use a generic `402` actions envelope (create key, top up, docs) for the prepaid-credit flow. That envelope contains no x402 payment requirements and cannot authorize or settle a payment. Keyless `/mock` has no authentication or payment failure path; missing, unsafe, or unreadable projects/specs/routes return generic `404` responses

### Target machine flow (decided, not built)

- Agent calls a gateway URL without a key or with an empty wallet session → `402` carrying a payable offer
- Agent pays via x402 → payment funds an ephemeral wallet keyed to its payer address
- Subsequent calls authenticated by that verified wallet session draw from the wallet at the edge; zero balance → `402` again
- Recommended rail order (research): Stripe-hosted x402 + MPP as a top-up rail first

## Tech

- **Payment-required errors**: unauthenticated, invalid-key, and insufficient-credit responses on `/gateway` return a generic `402` with machine-readable create-key, top-up, and docs actions. This is prepaid-credit recovery metadata, not x402: no payment requirements, signed-payment verification, facilitator, or settlement exists in this tree. `/mock` is keyless and free; project, spec, and route failures return generic `404` responses (copy; canonical home [gateway](gateway.md))
- **Later (explicitly deferred)** — x402 rail: entirely deferred to P1 per [roadmap](../product/roadmap.md). Any future implementation needs signed-payment retry, facilitator verification, settlement/replay controls, tests, data inventory, and approved operating evidence; generic current `402` action envelopes are not an x402 stub

### Decided design (2026-10-10, not built)

From [dual-rail decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md):

- No per-call on-chain settlement: Stripe minimum 0.01 USDC per settlement, $0.50 card minimum; Zevium calls are $0.002–$0.05
- x402 payment funds an ephemeral wallet keyed to the payer address (wallet session); later calls draw from it at the edge (wallet DO); zero balance still blocks; same 95/5
- Authentication rule becomes "API key or verified wallet session"
- Rail order recommended by research: Stripe-hosted x402 + MPP as top-up rail first

### Research facts (research 2026-10-10, not built)

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

- 2026-10-10 — ACCEPTED: two rails (enterprise keys + org wallet + prepaid top-ups; individual/agent keyless x402). x402 funds an ephemeral wallet keyed to payer address; no per-call on-chain settlement; zero balance blocks; 95/5; auth rule amended to "API key or verified wallet session"; Stripe-hosted x402 + MPP top-up rail first. [decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md)
- 2026-10-10 — ACCEPTED: unused anonymous-wallet balance expires after one year (for now, can change later). [decision](../decisions/2026-10-10-anonymous-wallet-expiry.md)
- 2026-10-10 — ACCEPTED: x402 keyless rail promoted P1 → P0. [decision](../decisions/2026-10-10-p0-agent-bet.md)
- 2026-10-10 — ACCEPTED: anonymous balance expires per top-up, one year after each top-up (funding-lot expiry). [decision](../decisions/2026-10-10-anonymous-wallet-expiry.md)

## Open questions

- Product rule amended in AGENTS.md on 2026-10-10 ("API key, or — planned — a verified x402 wallet session"). Wallet-session verification itself is unbuilt
- PRODUCT says "there is no separate personal-wallet model"; ephemeral payer-address wallets are a new wallet kind. Decide ledger shape (ephemeral org vs new wallet type) and identity mapping
- Top-up amount semantics for the 402 offer (fixed pack vs call price + buffer) undecided
- Compliance for anonymous payers (sanctions screening, refunds of expired/unused balance) not analyzed
- Stale code comment: `apps/gateway/src/payment-required.ts` says the envelope serves "/gateway and /mock"; only `pipeline.ts` (`/gateway`) calls it, matching TECH (`/mock` returns `404`s). Code behavior wins; comment is stale
