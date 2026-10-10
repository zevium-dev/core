# No BYOK for now; explore connected accounts (OAuth on behalf of user)

> Date: 2026-10-10 · Status: BYOK rejected for now; connected accounts = exploring, unprioritized · Decided by: user
> Session: [2026-10-10](../sessions/2026-10-10-competitive-research-and-docs.md)

## Decision

- **No bring-your-own-key** for now. Keeps the no-unmetered-paths rule intact.
- **Explore connected accounts**: a consumer connects their own account (example: Instagram) via OAuth so an API can act on their behalf (post as them). Pattern seen at treg (OAuth connections), Composio, Arcade (managed per-user OAuth).

## Open

- Who holds the OAuth app and tokens (Zevium vs publisher), token storage (same envelope encryption as upstream credentials?), scopes, revocation UX.
- Pricing: per-call as usual; per-auth-event fee (Arcade charges one) or none.
- How it fits metering: calls still go through the gateway and wallet.

## Affects

[connected-accounts](../features/connected-accounts.md), [upstream-credentials](../features/upstream-credentials.md), [gateway](../features/gateway.md)
