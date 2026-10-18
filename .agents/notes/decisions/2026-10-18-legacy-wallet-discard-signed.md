# Legacy wallet data discard signed off for every environment

> Date: 2026-10-18 · Status: accepted · Decided by: owner

Owner on 2026-10-18: legacy wallet data is disposable; delete it.

This is the explicit exact-target discard sign-off required by the [2026-10-11 discard policy](2026-10-11-legacy-wallet-discard.md) for **every** environment: development, preview and production. It approves the irreversible deletion of `WalletSqliteDO` storage by migration `v6-control-plane-cutover`. No export is wanted.

It satisfies the discard sign-off in [activation runbook](../architecture/convex-activation.md) steps 1 and 6. Operators still record the exact namespace, deployment and release privately when they run it. It does not cover current `NextWalletDO` journals or real provider obligations, which remain non-disposable.
