> Historical only after PR 7 (2026-10-11): legacy x402 runtime and schema are deleted. Current code cannot enable this rail. A new implementation review and owner approval are required; see [cutover activation](convex-activation.md).

# Re-enable x402 wallet payments

> Updated: 2026-10-11 · Status: disabled by owner decision; implementation retained
> Owner: [machine payments](../features/machine-payments.md)

## Activation and rollback

The single activation switch is gateway binding `X402_ENABLED`. Only the literal
string `true` enables the rail. Missing, `false`, `1`, and other values disable it.
`apps/gateway/wrangler.jsonc` and `.env.example` default to `false`. Secrets alone
never enable payments. No web or Convex activation flag exists.

After the prerequisites and smoke tests below pass, set `X402_ENABLED` to `true`
on the intended gateway Worker under Cloudflare Settings → Variables and Secrets,
and deploy that configuration. For an isolated local gateway, put the binding in
its ignored `apps/gateway/.dev.vars`. Production release uploads use `--keep-vars`, but the checked-in `false` can
override a dashboard value. For a persistent production opt-in, add
`--var X402_ENABLED:true` to the gateway `wrangler versions upload` command in
`.github/workflows/deploy-production.yml` before releasing. This overrides the
same binding, not a second switch. For rollback, remove that argument (or change
it to `--var X402_ENABLED:false`) and release. Verify the deployed binding after
each release. Do not turn
on unrelated previews or globally change the repository default.

To disable again, set the binding to `false` and deploy. New requests cannot offer
payment, settle a proof, fund a wallet, issue a session, or authenticate an existing
wallet session. Direct HTTP returns its normal API-key recovery envelope (currently
HTTP 402 without `PAYMENT-REQUIRED`); OAuth-enabled MCP uses its normal Bearer
challenge. Ordinary API-key/OAuth traffic and anonymous mocks retain their behavior.
Disabling does not cancel requests already settling. Reconcile in-flight receipts;
keep existing funding, usage outboxes, and deduplication records.

## Required configuration

Supply secret values privately through Cloudflare's secret settings. Names only:

- `X402_DEPOSIT_ADDRESS`: Stripe-owned Base USDC deposit address, provisioned
  outside the request path.
- `X402_FACILITATOR_URL`: HTTPS private x402 V2 facilitator proxy.
- `X402_FACILITATOR_TOKEN`: gateway-to-proxy authentication.
- `X402_STRIPE_SECRET_KEY`: separate restricted Stripe key with payment-intent
  create/read permissions; use test credentials for sandbox evidence. Provisioning
  the deposit address needs its own permitted operation outside the hot path.
- `WALLET_SESSION_SECRET`: independent random HMAC signing secret, at least 32
  characters. Rotation invalidates all outstanding wallet sessions.
- `CONVEX_SITE_URL`, or `CONVEX_URL` from which the gateway derives the site URL.
- `GATEWAY_INTERNAL_SECRET`: must match Convex's authenticated internal channel.
- `APP_ORIGIN`: paired web origin used for create-key, top-up, and docs recovery.

Retain the normal deployment's Clerk, registry, Stripe Connect, and usage-ingest
configuration. This switch does not provision those services.

## Facilitator, networks, and settlement

Recommended facilitator: **Coinbase CDP**, behind the private proxy expected by
`StripeX402Facilitator`. The proxy owns `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`;
these are proxy configuration names, not gateway bindings. It authenticates CDP
requests server-side and exposes V2 `/verify` and `/settle` responses. Never point
the gateway's static Bearer token directly at CDP as a substitute for CDP auth.
[CDP facilitator documentation](https://docs.cdp.coinbase.com/x402/seller/facilitator).

Production network: **Base**, `eip155:8453`, USDC. Facilitator integration testing:
**Base Sepolia**, `eip155:84532`, with test USDC and a separate test payer.
CDP supports both networks. The retained gateway adapter currently hardcodes Base
and Stripe's `base` transaction-verification network; **there is no testnet env
selector**. Base Sepolia tests must first exercise the proxy directly. End-to-end
Base Sepolia gateway testing requires a reviewed test-network adapter and a
confirmed Stripe-compatible sandbox recording path. Do not relabel a Sepolia
transaction as Base or use a mocked Stripe response as live settlement evidence.
This is a pre-existing activation blocker, not something setting the flag fixes.

Credit only after confirmed **on-chain settlement**, never after `/verify`, a
signature, or a submitted/pending transaction. The proxy must await settlement
before returning success. The adapter checks success, transaction hash, network,
and payer, persists the receipt in the proof DO, then requires a succeeded $1 USD
Stripe transaction-verification PaymentIntent before invoking Convex funding.
The Worker trusts the authenticated facilitator's settlement result; it does not
independently query chain finality. Verify the facilitator's finality policy before
activation. [Stripe's settlement sequence](https://docs.stripe.com/payments/machine/x402).

Validate EVM payer addresses as 20-byte hex, compare verify/settle addresses
case-insensitively, then lowercase before funding. Stable identity is
`x402:<CAIP-2 network>:<lowercase payer>`. Transaction hashes are also lowercased.
Never use a client-supplied wallet ID or reset balances when address casing changes.

## Sessions, expiry, and storage

Sessions last **86,400 seconds (24 hours)**, defined by `MACHINE_SESSION_SECONDS`.
They are HMAC-SHA256 `zev_ws_` Bearer credentials bound to the gateway origin,
network/payer, and `gateway:public` scope. Verification stays local. A successful
payment returns `X-Zevium-Wallet-Session`; save it securely. Replayed payments
return 409 without a replacement session or duplicate grant. Lost-session recovery
by wallet signature is not implemented.

Funding lots still expire one calendar year after each payment; oldest unexpired
lots fund admission. Expired unused anonymous money belongs to Zevium as revenue
(owner decision, 2026-10-11). Keep audit inventory and honor reservations admitted
before expiry. No new breakage ledger posting is introduced by this switch change.
Do not add top-up expiry fields, expiry warnings, or reminders to balance/MCP
responses; the enabled payment offer also omits the old expiry warning. Session
credential expiry remains a separate authentication requirement.

**No new DO migration or data reset is needed to toggle the rail.** Keep the
`WALLET` binding to `WalletSqliteDO`, migration history through
`v4-wallet-sqlite`, proof receipt/result records, wallet lots, and Convex tables.
The prior destructive migration is not a re-enable step. Deploy compatible Convex
schema/functions before enabling the gateway. `/machine-fund` remains an internal,
shared-secret-protected settlement projection, not a public top-up API.

## Smoke tests

1. Run `VITEST_MAX_WORKERS=2 pnpm ci:pr`. Targeted rail coverage:
   `VITEST_MAX_WORKERS=2 pnpm --filter @zevium/gateway test --maxWorkers=2 test/x402-disabled.test.ts test/machine-payments.test.ts test/payment-recovery.test.ts`.
2. With the flag absent or false **and all secrets present**, call a published
   `/gateway/:publisher/:project/*` route without credentials and with a payment
   proof. Expect normal auth recovery, no `PAYMENT-REQUIRED`, no
   `PAYMENT-RESPONSE`, no wallet-session header, no facilitator requests, funding,
   or upstream execution. Existing sessions must fail authentication. Check
   `/discovery`, MCP `initialize`/`tools/list`/`get_api_docs`, `/llms.txt`, and web
   consuming/agent docs: no enabled x402 claim. OAuth-enabled MCP must challenge
   keyless requests; valid API-key/OAuth calls still use normal credit gating.
3. Finish Base Sepolia proxy verification/settlement tests and the Stripe sandbox
   prerequisite above. Never use real money to replace missing sandbox evidence.
4. Enable the intended sandbox deployment explicitly. An unauthenticated gateway
   call should return the human recovery envelope plus a V2 offer. Decode it:
   expected network, Stripe-owned recipient, USDC, `exact`, 1,000,000 atomic units,
   and 10,000 credits. No top-up expiry text or fields.
5. Pay with the test payer. Confirm on-chain settlement and succeeded matching
   Stripe PaymentIntent **before** one Convex funding lot and one edge grant.
   Confirm 10,000 credits less call cost, session header, and `PAYMENT-RESPONSE`.
   Pending/rejected settlement and unsuccessful Stripe recording must never grant.
6. Reuse the session for direct calls and MCP `call_api`; confirm public-only
   access, normal debits and 95/5 earnings, no admission-time Clerk/Convex calls.
   Tampered, wrong-origin, and expired sessions must fail. Balance/MCP responses
   must not display funding expiry. Verify expiry enforcement in lot tests.
7. Exhaust the wallet and confirm refusal before upstream execution. Replay the
   proof: no second grant/session; retry a transient Stripe failure with the same
   proof and confirm reuse of the persisted settlement receipt. Compare mixed-case
   payer receipts and confirm one normalized wallet.
8. Turn the switch off again and repeat step 2, including previously issued
   sessions. Only enable production after recording real sandbox evidence. Do not
   advertise successful live settlement based on test doubles.

Public discovery and web docs currently describe API-key/OAuth access and do not
need a second flag. MCP recovery mentions wallet sessions only when active. Any
future public x402 guide must derive availability from the gateway rather than
introducing an independent activation switch.
