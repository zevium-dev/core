# Every environment uses the Stripe sandbox, including production

> Date: 2026-10-18 · Status: accepted · Decided by: owner

All environments, production included, use the Stripe sandbox with test keys. No real money moves yet. Live payments wait on [#315](https://github.com/zevium-dev/core/issues/315) (Stripe approval, legal, tax and policy gates).

This matches the code: Convex refuses live Stripe keys and live-mode objects. Turning on live mode needs a new decision plus a reviewed removal of that test-only enforcement.

Notes: [wallet-billing](../features/wallet-billing.md), [activation runbook](../architecture/convex-activation.md).
