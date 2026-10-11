# Connected accounts are the OAuth priority (API only, generic)

> Date: 2026-10-11 · Status: accepted (product); implementation choices superseded same day by [Zevium-owned provider clients](2026-10-11-zevium-owned-oauth-clients.md) · Decided by: user
> Feature: [connected-accounts](../features/connected-accounts.md) · Design: [design/connected-accounts.md](../design/connected-accounts.md)

## Context

The 2026-10-11 OAuth work went into MCP OAuth: agents logging in to Zevium ([research](../research/mcp-oauth.md), branch `feat/mcp-oauth-connect`). The user clarified that the OAuth they want is the opposite direction: Zevium acting on the user's own third-party accounts. The example: upload a video through Zevium and have it posted to video and social platforms as the user.

## Decision

- **Connected accounts first.** Zevium is the OAuth client; consumers connect their own accounts; calls use them. Supersedes "exploring, unprioritized" in [2026-10-10](2026-10-10-no-byok-connected-accounts.md).
- **API only.** No consumer screens in the app. Apps and agents start connections and list or revoke them through the gateway API.
- **Generic.** Any standard OAuth 2.0 authorization-code provider, declared in the publisher's OpenAPI spec. Named platforms are examples of the end result, not separate integrations; platform-specific listings come later. _Superseded 2026-10-11: providers are a Zevium registry, starting with YouTube, TikTok, Instagram._
- **MCP OAuth parked.** `feat/mcp-oauth-connect` stays uncommitted on its branch.

Implementation choices made with the first build: the publisher owned the provider OAuth app (superseded: [Zevium owns one client per provider](2026-10-11-zevium-owned-oauth-clients.md)); connections are org-owned with optional labels; per-call pricing only.

## Affects

[connected-accounts](../features/connected-accounts.md), [gateway](../features/gateway.md), [publishing-specs](../features/publishing-specs.md), [upstream-credentials](../features/upstream-credentials.md), [agent-surface](../features/agent-surface.md)
