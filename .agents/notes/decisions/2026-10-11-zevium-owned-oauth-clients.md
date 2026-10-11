# Zevium owns one OAuth client per provider (connected accounts)

> Date: 2026-10-11 · Status: accepted; built in PR (pending review) · Decided by: user
> Feature: [connected-accounts](../features/connected-accounts.md) · Design: [design/connected-accounts.md](../design/connected-accounts.md) · Research: [provider OAuth clients](../research/connected-accounts-providers.md) · Issue #351

## Context

The first build of connected accounts was generic: the publisher's spec declared the provider's OAuth endpoints and the publisher saved its own client ID and secret in project settings. The user's goal is narrower and concrete: Zevium posts to YouTube, Instagram and TikTok on the user's behalf. The user asked for a single flow where Zevium is the one OAuth client exchanging with many providers' OAuth servers.

## Decision

- **Zevium is the client.** One registered app per provider, owned by Zevium. Client ID and secret live in deployment env (`OAUTH_<CLIENT>_CLIENT_ID` / `_SECRET`), read at use time.
- **Providers are a code registry**, not spec input: endpoints, scopes, parameter quirks, token style and allowed API hosts. Starts with YouTube, TikTok, Instagram.
- **Specs reference a provider** with `x-zevium-oauth-provider`; they can't change endpoints. The publisher OAuth client table and settings card are removed.
- **Tokens go only to provider API hosts.** Enforced at publish validation and again in the gateway.
- **House listings only for now.** Only projects with `houseOperated: true` can start connections.
- Added with the build: renewal cron for long-lived tokens, best-effort provider revocation on disconnect.

## Consequences

- Adds `oauthConnections` as the 37th application table (budget was 36 after the Convex rebuild). Proposed with this change; needs owner sign-off.

- One provider review and quota per platform, shared by all users. Approval is the activation gate (see research).
- Bring-your-own client per org is the planned relief when quota bites; not built.
- Third-party publishers can't list connected-account APIs until the allow-list policy changes.

## Supersedes

The "publisher owns the provider OAuth app" implementation choice in [2026-10-11 connected accounts first](2026-10-11-connected-accounts-oauth.md). The rest of that decision (API only, connected accounts before MCP OAuth) stands.
