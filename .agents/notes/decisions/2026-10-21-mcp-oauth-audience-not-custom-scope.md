# MCP OAuth binds by audience, not a custom scope

> Date: 2026-10-21 · Status: accepted · Decided by: owner (delegated)

MCP OAuth tokens must carry `user:org:read` and an audience exactly equal to the canonical MCP resource (`https://gateway.zevium.dev/mcp` in production). The planned second scope, `zevium:mcp:execute`, is dropped.

Why: Clerk only issues its fixed scope set (`email`, `offline_access`, `openid`, `private_metadata`, `profile`, `public_metadata`, `user:org:read`). Both the dynamic-registration allowlist and pre-registered OAuth applications reject custom scopes, so no Clerk token could ever pass a gateway that required `zevium:mcp:execute`. The RFC 8707 audience is the real control: a token minted for any other resource on the same authorization server fails verification (401), and `user:org:read` still drives Clerk's org picker so the token carries the consented `org_id`. A token without `user:org:read` gets 403 `insufficient_scope`.

Consequence: consent shows Clerk's org-read wording, not a Zevium "spend credits" line. A custom consent page (research gap G4) is where spending consent copy belongs.

Code: `apps/gateway/src/mcp-oauth.ts` (`MCP_SCOPES`), tests in `apps/gateway/test/mcp-oauth.test.ts`. Release wiring: repository variables `PRODUCTION_MCP_OAUTH_ISSUER` / `PRODUCTION_MCP_OAUTH_RESOURCE` in `.github/workflows/deploy-production.yml`. Notes: [agent-surface](../features/agent-surface.md), [mcp-oauth research](../research/mcp-oauth.md).
