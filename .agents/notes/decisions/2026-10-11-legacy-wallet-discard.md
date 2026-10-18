# Legacy wallet cutover data

- Date: 2026-10-11
- Status: accepted policy; discard signed off for every environment on 2026-10-18 ([decision](2026-10-18-legacy-wallet-discard-signed.md))
- Scope: PR #443, legacy WalletSqliteDO only

Owner confirms zero users and disposable legacy test data. Default activation path discards that data through v6. Owner must explicitly confirm target data is disposable and sign off before v6 deployment. If preservation is wanted, export/reconcile using pinned legacy release `3d51eb9a406e6dafae03919988875f75c87e52d3` before signing off. Current NextWalletDO state and real provider obligations are not disposable under this decision.

The real provider journey is a hard gate before activation flags, not before merging code. Provider configuration/deployments and live Stripe remain separately authorized owner work.

[Activation procedure](../architecture/convex-activation.md).
