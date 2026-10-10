# Two org roles for now: admin and member

> Date: 2026-10-10 · Status: accepted (matches most current code) · Decided by: user
> Session: [2026-10-10](../sessions/2026-10-10-competitive-research-and-docs.md)

## Decision

- Expose simple role-based access with two roles: **admin** and **member**. No separate owner role in product (code's acceptance of `org:owner` as privileged is harmless; treat owner as admin).
- **Org admins** see publisher analytics and webhook delivery history (code already enforces this; docs that said members can are wrong).
- Full permission-based access control comes later; build toward it, don't expose it yet.

## Affects

[accounts-orgs](../features/accounts-orgs.md), [publisher-analytics](../features/publisher-analytics.md), [webhooks-notifications](../features/webhooks-notifications.md)
