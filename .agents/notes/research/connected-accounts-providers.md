# Research: one OAuth client, many providers (connected accounts)

> 2026-10-11. Status: **research**, input to [Zevium-owned provider clients](../decisions/2026-10-11-zevium-owned-oauth-clients.md).
> Built design: [design/connected-accounts](../design/connected-accounts.md). Feature: [connected-accounts](../features/connected-accounts.md). Issue #351.
> Provider facts come from public provider docs as of this date. Quotas and review rules change; re-check before activation.

## Question

How does one platform act on many users' accounts at many providers (example: upload a video once, post it to YouTube, TikTok and Instagram as the user), and who should own the OAuth apps?

## How the pattern works

The OAuth roles are fixed by the providers: Google, TikTok and Meta run the authorization servers; the platform is a registered **client** of each one. One server can be a client of any number of providers.

- **One client registration per provider.** Each provider issues its own client ID and secret and lists the platform's exact redirect URI. One callback URL on the platform serves every provider; `state` says which pending flow (and so which provider) a callback belongs to.
- **Providers are data.** The generic authorization-code flow is identical everywhere. What differs fits in a table: endpoints, scope names and separator, the client-id parameter name, extra authorize parameters, PKCE support, token-response shape, how refresh works, revocation, and which API hosts accept the token.
- **Snapshot or re-read settings at callback time.** The code exchange must use the same provider, redirect URI and PKCE verifier as the consent URL.
- **Tokens per user grant, secrets per app.** Store each grant's tokens encrypted. Keep the client secret out of per-grant storage so rotating it doesn't strand old grants.
- **Refresh on demand, plus renewal for long-lived tokens.** Short-lived tokens (Google 1 h, TikTok 24 h) refresh on the call path. Tokens that die unused (Instagram 60 days) need a scheduled renewal.
- **Lock the destination.** A grant's token must only ever be sent to that provider's API hosts. Otherwise anyone who can define a listing can collect users' tokens.

## Who owns the OAuth app

| Option                                   | Consent screen shows | Quota and review                                     | Fit                                                                |
| ---------------------------------------- | -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| Platform-owned client per provider       | The platform         | Shared by all users; the platform passes each review | Best first step: one review, users connect in one click            |
| Publisher-owned client (publisher's app) | The publisher        | Per publisher                                        | Generic marketplace model; every publisher must pass reviews alone |
| Bring-your-own client per consumer org   | The consumer's app   | Per org                                              | Big users who outgrow shared quota; add later on the same engine   |

Recommendation taken: platform-owned clients now, with room for bring-your-own later (connection rows record the provider; client lookup is one function).

## Build or buy

Managed connection services (unified OAuth/token vaults) pre-wire hundreds of providers, refresh tokens and expose a token API. Trade-off for Zevium: a third party holds every user's platform tokens, adds a hop on cache misses and a per-connection bill. With three providers and the engine already built (state, PKCE, encrypted grants, refresh lease, gateway cache), building is cheaper. Revisit past roughly ten providers. Their public provider catalogs are a good reference for quirks.

## Provider notes

| Provider                    | Endpoints                                                                                                                                                   | Differences that matter                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YouTube (Google)            | `accounts.google.com/o/oauth2/v2/auth`, `oauth2.googleapis.com/token`, revoke `oauth2.googleapis.com/revoke`                                                | Refresh token only with `access_type=offline`; `prompt=consent` to get it again on reconnect. PKCE supported. Space-separated full-URL scopes. Upload at `www.googleapis.com/upload/youtube/v3/videos`, resumable for large files.                                                                                                  |
| TikTok                      | `www.tiktok.com/v2/auth/authorize/`, `open.tiktokapis.com/v2/oauth/token/`, revoke `.../v2/oauth/revoke/`                                                   | `client_key` instead of `client_id`. Comma-separated scopes. Web flow lists no PKCE parameters (desktop PKCE uses a hex challenge). Access token 24 h, refresh token 365 days. Content Posting API: `video.upload` (draft) and `video.publish` (direct post).                                                                       |
| Instagram (Instagram Login) | `www.instagram.com/oauth/authorize`, `api.instagram.com/oauth/access_token`, `graph.instagram.com/access_token`, `graph.instagram.com/refresh_access_token` | Code grant returns a 1-hour token inside `data: [...]` with `permissions`, no refresh token. Swap it server-side (`ig_exchange_token`, with client secret) for a 60-day token; refresh that token itself (`ig_refresh_token`) before expiry. Business or Creator accounts only. Publishing takes a public media URL, not an upload. |

## Approval and quota

These gate real use more than code does. All are on Zevium as owner of the apps.

- **YouTube:** `youtube.upload` is a sensitive scope: Google OAuth verification required. Projects not audited for YouTube API compliance get uploads locked to private. Default Data API quota is 10,000 units/day per project and an upload costs about 1,600 units, so roughly 6 uploads/day for **all** users combined until a quota extension. Apps left in "Testing" get refresh tokens that expire after 7 days.
- **TikTok:** Content Posting API needs app review; until the client is audited, posts are restricted to private (self-only) visibility, with daily caps.
- **Instagram:** Meta App Review for `instagram_business_content_publish`, business verification, and a rolling 24-hour publishing cap per account.

## Ideas (not decided)

- Media hosting: short-lived signed URLs for Instagram and for resumable YouTube uploads that exceed Worker body limits.
- Bring-your-own provider client per org when shared quota bites.
- Share one connection across several house listings of the same provider (today a connection belongs to one listing).

## Sources

- [Google OAuth 2.0 for web server apps](https://developers.google.com/identity/protocols/oauth2/web-server)
- [YouTube Data API quota and videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert)
- [TikTok Login Kit for Web](https://developers.tiktok.com/doc/login-kit-web)
- [TikTok Login Kit for Desktop (PKCE)](https://developers.tiktok.com/docs/en/login-kit-desktop)
- [TikTok user access token management](https://developers.tiktok.com/docs/en/oauth-user-access-token-management)
- [Business Login for Instagram](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login)
- [Instagram access token reference](https://developers.facebook.com/documentation/instagram-platform/reference/access_token)
