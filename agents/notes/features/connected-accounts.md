# Connected accounts (act on behalf of a user)

> Status: exploring — not prioritized, nothing built · Updated: 2026-10-10
> Code: none
> Related: [upstream-credentials](upstream-credentials.md), [gateway](gateway.md), [api-keys](api-keys.md), [decision](../decisions/2026-10-10-no-byok-connected-accounts.md)

A consumer connects their own third-party account (example: Instagram) through OAuth, so an API listed on Zevium can act as them — post on their behalf, read their data. Replaces bring-your-own-key as the way consumers bring their own identity, without opening an unmetered path.

## Product

- Consumer connects an account once; calls that need it use it automatically.
- Calls stay metered and credit-gated through the gateway like every other call.
- Consumer can see and revoke connections at any time.
- BYOK (consumer supplies a vendor API key and skips metering) is not offered for now.

## Flow

Not designed. Reference patterns: treg OAuth connections, Composio and Arcade managed per-user OAuth ([MCP marketplaces research](../research/agent-api-marketplace-landscape/mcp_tool_marketplaces.md)).

## Tech

Not designed. Likely reuses the envelope encryption used for [upstream-credentials](upstream-credentials.md) for stored tokens.

## Decisions

- 2026-10-10 — BYOK rejected for now; connected accounts to be explored. [decision](../decisions/2026-10-10-no-byok-connected-accounts.md)

## Open questions

- Who owns the OAuth app per provider (Zevium vs publisher)?
- Token storage, refresh, scopes, revocation.
- Per-auth-event fee or none.
