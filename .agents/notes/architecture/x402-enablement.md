# x402 future enablement runbook

> Updated: 2026-10-11 · Status: runbook only; x402 disabled by owner decision, enforcement #424 pending; activation P2 #109
> Policy: [x402 disabled](../decisions/2026-10-11-x402-disabled.md) · Feature/code map: [machine payments](../features/machine-payments.md)

No deployment, secret, payment or feature flag changed in the decision PR. This runbook records how to prepare a future activation; it is not an activation instruction for the current launch.

## 1. Establish the off state

Current `apps/gateway/src/index.ts` constructs `machinePayments` only when all five x402/session bindings plus Convex site URL and the gateway internal secret exist. It has no explicit feature-off flag. #424 must add a default-off gate that covers offers, proof settlement, funding and wallet-session admission on HTTP and MCP even if old secrets remain configured. Use the flag name and deployment procedure delivered by #424; no such name is invented here.

Until that gate exists, keep optional x402 bindings unconfigured. Verify each target environment: unauthenticated calls retain ordinary create-key/top-up/docs recovery and contain no payable x402 offer; old proofs or sessions cannot authorize a call or create a funding lot. Check direct HTTP and MCP. Existing API keys and keyless spec-only mocks must still work. Do not delete ledger rows, settlement receipts or pending reconciliation to disable admission.

## 2. Select facilitator and settlement path

At revival, record the facilitator, supported network/asset, custody/off-ramp path and settlement guarantees in a new activation decision. Coinbase CDP on Base is a candidate. It is not selected or configured by this runbook.

The retained `StripeX402Facilitator` adapter expects a private HTTPS x402 V2 proxy exposing `/verify` and `/settle`. CDP authentication belongs at that proxy; gateway sends its separate proxy bearer credential. A direct CDP URL is not a drop-in replacement unless its auth and response contracts match the adapter. The current path uses a Stripe-owned deposit address followed by a Stripe transaction-verification PaymentIntent. Switching facilitators or bypassing Stripe requires explicit adapter/accounting work, not an environment-only swap.

Recheck provider support and account access at activation using [CDP facilitator docs](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator) and [Stripe machine payments](https://docs.stripe.com/payments/machine). These are verification pointers, not claims that today's provider configuration has been validated. Preserve existing production gates #315.

## 3. Fix network, asset and identity normalization

Observed in `apps/gateway/src/machine-facilitator.ts` and `packages/shared/src/machine-payments.ts`:

- Current adapter is hardcoded to Base mainnet, CAIP-2 `eip155:8453`, USDC contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `exact` scheme and 1,000,000 atomic units ($1). Confirm these against the chosen provider before funding.
- Base Sepolia or another chain is not a supported config toggle. A test Stripe key does not turn Base mainnet into a sandbox. Obtain a provider-supported sandbox flow and implement explicit network/asset changes if required before sending funds.
- Validate EVM payer/deposit addresses as 20-byte hex, then normalize to lowercase for wallet identity. Bind wallet identity to both network and payer (`x402:<network>:<lowercase payer>`). Validate/normalize transaction hashes too. Different networks must never share balances or replay keys.
- The adapter compares the accepted offer against server-owned scheme/network/asset/amount/payTo and validates facilitator payer/network/transaction. Mixed-case aliases must resolve to the same payer only after validation. Do not apply EVM lowercasing to future non-EVM addresses.
- Session audience binds to the gateway origin and public gateway scope. Current sessions last 24 hours; that is separate from per-top-up one-year expiry. Any lifetime change requires matching issue/verification work.

## 4. Provision secrets without recording values

Set these through the deployment's secret mechanism after sandbox prerequisites are met. Never place values in notes, issues, shell command arguments, logs or screenshots.

| Binding                          | Purpose                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `X402_DEPOSIT_ADDRESS`           | Stripe-owned deposit address provisioned off the request path for the selected network |
| `X402_FACILITATOR_URL`           | Private HTTPS V2 proxy URL                                                             |
| `X402_FACILITATOR_TOKEN`         | Proxy authentication; provider credentials stay at the proxy                           |
| `X402_STRIPE_SECRET_KEY`         | Appropriate restricted key for transaction-verification PaymentIntent create/read      |
| `WALLET_SESSION_SECRET`          | Independent random HMAC signing secret, at least 32 characters                         |
| `CONVEX_SITE_URL` / `CONVEX_URL` | Correct paired backend; site URL can be derived from cloud URL                         |
| `GATEWAY_INTERNAL_SECRET`        | Matching internal gateway/backend authentication                                       |

Use separate sandbox and production credentials. Do not rotate a session secret merely to test disabling, and do not alter shared API-key/Stripe bindings to switch x402 off. Document secret names and readiness only.

## 5. Define settlement finality before granting credit

Verification alone is not payment. Current code accepts facilitator settlement success, persists a proof-scoped receipt, then requires a succeeded $1 USD Stripe PaymentIntent before Convex funding. It does not establish an independent chain-confirmation count.

Before activation, choose and document what the facilitator's “settled” means, required confirmations/finality, reorg handling and how uncertain results are recovered. If that guarantee is insufficient, implement a finality wait/reconciliation step before any credit grant. Never turn a pending/unknown settlement into spendable balance.

Persist the transaction receipt before retrying Stripe projection; reuse it instead of settling again. Deduplicate by payment ID and normalized `(network, transaction)`. A crash after external settlement but before receipt persistence requires transaction lookup/manual reconciliation. Do not ask the payer to pay twice to repair that gap. Retain failed/unknown attempts until resolved.

## 6. Complete acceptance before enabling

1. Land #424's off switch and record its actual name. Confirm off behavior with all bindings present, on direct HTTP and MCP, including old sessions/proofs.
2. Implement decided [breakage revenue](../decisions/2026-10-11-breakage-revenue.md) accounting (#353): no expiry warnings or expiry display in balance responses; retain internal expiry/provenance. No signup credit for anonymous wallets. Org funds never expire.
3. In the paired sandbox, deploy backend schema/functions before compatible gateway. Enable only that sandbox and complete offer → verified/final settlement → one funding lot → signed session → paid calls → exhaustion. Check the same 95/5 earnings and zero-balance rejection, including free-price calls.
4. Verify duplicate proof, duplicate payment, mixed-case payer/hash, wrong network/asset/payTo, expired/tampered session, incorrect audience, disconnect, facilitator outage, ambiguous settlement, process restart and projection replay. A top-up retry must not grant twice. Already-admitted usage must reconcile after expiry or disabling.
5. Verify no expiry fields in balance responses and no expiry notices. Exercise expiring funds, pre-expiry reservations settling late, and idempotent revenue recognition without double-counting served usage.
6. Record sanitized test results and unresolved provider limits. Existing deterministic adapter tests do not replace a real sandbox payment journey.
7. Once activation is separately scheduled and prerequisites pass, provision production bindings, deploy the compatible pair with the feature still off, then explicitly enable. Verify a bounded payment/call/reconciliation journey and monitor failures. Never activate merely because secrets happen to exist.

## 7. Disable or roll back

Turn the explicit feature gate off to stop new offers, funding and session admission. Preserve API-key traffic, ledger history, proof receipts and background reconciliation. Drain/reconcile already-admitted work and externally settled payments before any destructive deployment/reset. Leave uncertain transactions closed to further spend until resolved; use the accepted wallet freeze/drain protocol, not a global revocation path.

Re-enabling uses the same checklist. Reconcile outstanding receipts and grants first so retries cannot mint duplicate money. Session recovery and anonymous refund mechanics remain separate unresolved future work; do not claim they are solved by this runbook.
