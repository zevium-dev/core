# Connected accounts (act on behalf of a user)

> Status: built on branch `feat/connected-accounts` (API only), PR pending review · Updated: 2026-10-11
> Code: `packages/shared/src/oauth-providers.ts` (provider registry), `packages/shared/src/connections.ts`, `packages/shared/src/openapi.ts` (root `security`), `packages/shared/src/validate.ts`, `convex/connections.ts`, `convex/connectionsNode.ts`, `convex/connectionsHttp.ts`, `convex/lib/oauthProviderClients.ts`, `convex/lib/webhookTransport.ts` (`requestPinnedHttpsForBody`), `convex/lib/credentialCrypto.ts` (`connectionSecretBinding`), `convex/crons.ts`, `convex/schema/connections.ts`, `apps/gateway/src/connections.ts`, `apps/gateway/src/next/pipeline.ts`, `apps/gateway/src/forward.ts`, `apps/gateway/src/index.ts`
> Related: [upstream-credentials](upstream-credentials.md), [gateway](gateway.md), [publishing-specs](publishing-specs.md), [api-keys](api-keys.md), [implementation](../design/connected-accounts.md), [research](../research/connected-accounts-providers.md), [decision](../decisions/2026-10-11-zevium-owned-oauth-clients.md) · Issue #351

A consumer connects their own account at a platform (YouTube, TikTok, Instagram) through OAuth, so a Zevium listing can act as them: upload a video to their channel, publish a post. Zevium is the OAuth client of each platform. Replaces bring-your-own-key as the way consumers bring their own identity, without opening an unmetered path.

## Product

- API only: an app or agent asks Zevium for a connect link, the account owner approves at the platform, and later calls use that account automatically. No consumer screens in the Zevium app.
- Zevium owns one app per platform. Users see Zevium on the consent screen. Supported now: YouTube, TikTok, Instagram.
- Listings that use connected accounts are Zevium's own (house) listings for now.
- One org can hold many connections per API (for example one per end user), each with an optional label. The caller picks one per call when there are several.
- Calls stay metered and credit-gated through the gateway like every other call. A call that needs a connection and has none is refused at 0 credits.
- Consumers can list and revoke connections at any time. Revoking also asks the platform to revoke Zevium's access where the platform supports it.
- BYOK (consumer supplies a vendor API key and skips metering) is not offered.

## Flow

1. Zevium registers its app with each platform and publishes a listing whose spec names the platform.
2. Consumer app calls `POST /connections` with its API key and gets a one-time link (10 minutes).
3. The account owner opens the link, signs in at the platform and approves Zevium.
4. The platform sends them back to Zevium. Zevium finishes the connection and returns them to the app (or shows a plain "Account connected" page).
5. The app calls the API as usual. Zevium adds the owner's access token, refreshes it when it expires and keeps long-lived tokens from lapsing.
6. If the platform revokes access, calls say the account must be reconnected.

## Tech

Full design: [design/connected-accounts.md](../design/connected-accounts.md).

- Registry: `OAUTH_PROVIDERS` (endpoints, scopes, `client_id`/`client_key`, separator, extra params, PKCE, token style, revoke, renewal, API hosts). Client ID/secret from Convex env `OAUTH_GOOGLE_*`, `OAUTH_TIKTOK_*`, `OAUTH_INSTAGRAM_*`. House gate: `projects.houseOperated`.
- Spec: `oauth2` authorization-code scheme with `x-zevium-oauth-provider`; endpoints must equal the registry's, scopes must be allowed, `servers[0].url` host must be a provider API host. Effective `security` (operation, else root): required if every alternative names it; optional if an alternative is `{}`.
- Gateway: `/connections` routes (API key on signed key evidence, lifecycle gates), `/connections/callback` (public). The pipeline checks the upstream host, then resolves the token before wallet admission; `forward()` sets `Authorization: Bearer`; response header `x-zevium-connection`. Token cache 60 s per isolate, never past expiry.
- Convex: `oauthConnections`; internal routes `/connections-start`, `/connections-callback`, `/connections-list`, `/connections-revoke`, `/gateway-connection-token`. Single-use hashed state, PKCE S256 where supported, encrypted tokens bound to connection id and field, refresh lease per token revision, Instagram 60-day swap, hourly renewal and cleanup crons, best-effort provider revocation.
- Outbound provider requests use the DNS-pinned webhook transport; URLs come only from the registry.

## Decisions

- 2026-10-11 — ACCEPTED: Zevium owns one OAuth client per provider; code registry; specs reference providers; tokens only to provider API hosts; house listings only. [decision](../decisions/2026-10-11-zevium-owned-oauth-clients.md)
- 2026-10-11 — ACCEPTED: connected accounts are the OAuth priority; API only; MCP OAuth branch parked. [decision](../decisions/2026-10-11-connected-accounts-oauth.md)
- 2026-10-10 — BYOK rejected for now; connected accounts to be explored. [decision](../decisions/2026-10-10-no-byok-connected-accounts.md)

## Open questions

- Platform reviews and quotas before real users: #445 ([research](../research/connected-accounts-providers.md#approval-and-quota)).
- Media hosting for Instagram (public URL) and large YouTube uploads: #444.
- Bring-your-own client per org: #446. Opening provider schemes to third-party publishers.
- Confirm step against link phishing (a link completed by the wrong person connects their account into the creator's org).
- Per-auth-event fee or none (per-call only today). MCP `call_api` connection selection. Rate limiting on management routes. Owner sign-off on the 37th table.
