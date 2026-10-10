# Email via Resend

> Date: 2026-10-10 · Status: accepted, not built (API key pending from user) · Decided by: user
> Session: [2026-10-10](../sessions/2026-10-10-competitive-research-and-docs.md)

## Decision

Transactional email goes through Resend. User provides the API key later — request it via a private secret prompt, never in chat; store as a Convex env var, never in notes or code.

## Scope

Notifications docs already promise by email: budget thresholds, deprecation/sunset notices, payout notices, listing-status changes. Verification and invitation emails stay with Clerk.

## Affects

[webhooks-notifications](../features/webhooks-notifications.md), [listing-lifecycle](../features/listing-lifecycle.md), [wallet-billing](../features/wallet-billing.md), [earnings-payouts](../features/earnings-payouts.md)
