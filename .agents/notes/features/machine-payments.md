# Machine payments (x402)

> Status: root cutover implemented; owner activation pending · Updated: 2026-10-11
> Code: `apps/gateway/test/cutover.test.ts`, `convex/schema/`, `packages/shared/src/edge/`
> Related: [wallet-billing](wallet-billing.md), [gateway](gateway.md), [agent-surface](agent-surface.md), [dual rail](../decisions/2026-10-10-dual-rail-keys-and-x402.md), [expiry](../decisions/2026-10-10-anonymous-wallet-expiry.md)

## Product

Deferred product flow below is retained for future activation. Owner decision is feature off; implementation #424 is pending.

Individuals and agents can fund a wallet without an account or API key. One $1 payment buys 10,000 credits. Calls spend those credits at the published spec price, with the existing 95% publisher / 5% platform split. There is no anonymous signup credit. Zero spendable balance blocks even free endpoints.
Keyless payments are disabled for now. Consumers use API keys or MCP OAuth. A future implementation would let individuals and agents fund a wallet without an account or API key. One $1 payment buys 10,000 credits. Calls spend those credits at the published spec price, with the existing 95% publisher / 5% platform split. There is no anonymous signup credit. Zero spendable balance blocks even free endpoints.

Each top-up expires one calendar year after funding. Spending uses the oldest unexpired top-ups first; a later top-up does not extend earlier funds. Expired unused anonymous money is Zevium revenue. Balance/MCP responses show no top-up expiry or expiry warnings. Organizations using API keys retain their existing non-expiring wallets.

## Flow

Current behavior: keyless paid calls receive normal auth-required recovery, without a machine payment offer. The following flow is retained for re-enablement only.

1. Call `/gateway/:publisher/:project/*` without credentials. When explicitly enabled and configured, the 402 includes a $1 x402 offer and existing create-key, top-up, and docs actions.
2. Retry with the signed payment proof. Confirmed settlement funds the payer's wallet; the same request runs through the normal metered pipeline.
3. Save the returned wallet session and send it as a Bearer credential on later HTTP calls or MCP `call_api` calls. The session lasts 24 hours and accesses public APIs only.
4. Empty wallets receive another payable 402. Another payment from the same payer restores access to all remaining unexpired funds. A repeated payment cannot fund twice and does not issue another session.

## Tech

PR #443 review cleanup also removes `invalid_payment` recovery and exposed payment/session headers from `apps/gateway/src/{payment-required,cors}.ts`. Future activation requires new-plane implementation, not restoring environment bindings.

x402 execution/session/funding implementation and anonymous schema were removed with legacy control plane. Setting old bindings cannot enable it. Git history retains the previous implementation and provider evidence; existing x402 runbooks are historical design references, not executable activation instructions. Revival requires a new reviewed implementation, provider/finality policy and owner approval. Ordinary org-wallet calls remain authenticated and credit-gated.

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

## Decisions

- 2026-10-11 — ACCEPTED: x402 disabled by policy; P1 #424 enforces feature off; #109 activation moves to P2. [Decision](../decisions/2026-10-11-x402-disabled.md).
- 2026-10-11 — Owner: disable x402 for now, retain code for re-enablement; expired unused anonymous funds are Zevium revenue; omit top-up expiry display and warnings from balance/MCP responses. Decision records are maintained in parallel.
- 2026-10-11 — ACCEPTED: Expired anonymous funds are Zevium revenue; no expiry warnings or expiry display in balance responses. #353/#424. [Decision](../decisions/2026-10-11-breakage-revenue.md).
- 2026-10-11 — Owner: disable x402 for now, retain code for re-enablement; expired unused anonymous funds are Zevium revenue; omit top-up expiry display and warnings from balance/MCP responses. Decision records are maintained in parallel.
- 2026-10-11 — ACCEPTED: Rebuild #353/#430 accepts 32 slices and traceable dust merges with identical expiry rules. [Decision](../decisions/2026-10-11-edge-authority-and-lots.md).
- 2026-10-11 — Owner: disable x402 for now, retain code for re-enablement; expired unused anonymous funds are Zevium revenue; omit top-up expiry display and warnings from balance/MCP responses. Decision records are maintained in parallel.

- 2026-10-10 — BUILT behind configuration: payer-bound wallet sessions, zero-balance gate, 95/5 split, $1 top-up default, anonymous accounting organizations. [Dual rail](../decisions/2026-10-10-dual-rail-keys-and-x402.md). (Historical; scope superseded 2026-10-11 above.)
- 2026-10-10 — BUILT behind configuration: payer-bound wallet sessions, zero-balance gate, 95/5 split, $1 top-up default, anonymous accounting organizations. [Dual rail](../decisions/2026-10-10-dual-rail-keys-and-x402.md).
- 2026-10-10 — BUILT: per-top-up one-year expiry, oldest-first admission. [Expiry](../decisions/2026-10-10-anonymous-wallet-expiry.md).
- 2026-10-10 — Historical P0 priority, superseded by P2 activation on 2026-10-11. [Agent bet](../decisions/2026-10-10-p0-agent-bet.md).

## Open questions

- Activation is P2. Complete runbook prerequisites and real sandbox settlement evidence before enabling.
- Before future activation: implement decided breakage policy (#353), resolve anonymous refunds, sanctions screening and session recovery. Follow the [enablement runbook](../architecture/x402-enablement.md).
- Complete owner setup and the real sandbox settlement evidence before enabling production.
- Accounting posting mechanics for expired-funds revenue, anonymous refunds, sanctions screening and session recovery before launch.
