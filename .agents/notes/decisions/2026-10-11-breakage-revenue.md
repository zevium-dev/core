# Expired anonymous wallet money is Zevium revenue

> Date: 2026-10-11 · Status: accepted direction; implementation pending · Decided by: owner
> Session: [owner decisions](../sessions/2026-10-11-owner-decisions.md)

## Decision

Expired anonymous-wallet money (breakage) is **Zevium revenue**. Send no expiry warnings and show no expiry in balance responses. Ordinary organizations' wallet money never expires.

Retain per-top-up one-year expiry from [2026-10-10 anonymous expiry](2026-10-10-anonymous-wallet-expiry.md); resolve that decision's owner questions about notices and revenue treatment. This does not grant expiry authority for org wallets or change the age of funds through dust merging.

## Delivery and limits

Rebuild #353 owns ledger recognition; x402 enablement #424 / P2 #109 must check it before reactivation. Current code excludes expired lots from spendable balance but retains raw ledger inventory; revenue recognition is not implemented by this decision.

Recognize only expired unspent money after accounting for reservations admitted before expiry and late usage. Record an idempotent, source-traceable ledger fact so breakage and served-call earnings cannot count the same money twice. Keep expiry internally for accounting even though balance responses omit it. Jurisdictional treatment remains part of existing production gates #315; no fresh legal approval is claimed.

## Affects

[Machine payments](../features/machine-payments.md), [wallet billing](../features/wallet-billing.md).
