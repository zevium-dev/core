# Connected accounts: implementation

> Status: implemented on branch `feat/connected-accounts`, PR pending review · Updated: 2026-10-11
> Feature owner: [connected-accounts](../features/connected-accounts.md) · Decisions: [connected accounts first](../decisions/2026-10-11-connected-accounts-oauth.md), [Zevium-owned provider clients](../decisions/2026-10-11-zevium-owned-oauth-clients.md) · Research: [provider OAuth clients](../research/connected-accounts-providers.md)

A consumer connects **their own** account at a platform (YouTube, TikTok, Instagram) once. From then on, calls to a listing that needs it act as them, for example uploading a video to their channel. Zevium is the OAuth **client**: one registered app per provider, owned by Zevium. The provider issues tokens to that app; Zevium stores them encrypted and adds them to the consumer's calls.

API only. No consumer screens in the app.

## Plan (how it fits together)

One generic engine, many providers. A provider is data, not code paths:

```
deployment env (client ID + secret per provider app)
        |
        v
provider registry (packages/shared/src/oauth-providers.ts):
endpoints, allowed scopes, parameter quirks, token style, API hosts
        |
        v
ONE flow: POST /connections -> provider consent -> /connections/callback -> code exchange
        |                                                     |
        |                                      encrypted grant per connection
        v                                                     |
metered call -> pick connection -> refresh if due -> Bearer token -> provider API host only
```

| Step | What happens                                                                                                                        | Where                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1    | Registry entry per provider: authorize/token URLs, scopes, `client_id` param name, scope separator, extra params, PKCE, API hosts   | `packages/shared/src/oauth-providers.ts`                                                      |
| 2    | Client credentials from env `OAUTH_<CLIENT>_CLIENT_ID` / `_SECRET`, read at use time                                                | `convex/lib/oauthProviderClients.ts`                                                          |
| 3    | Listing spec names the provider: `x-zevium-oauth-provider` on an `oauth2` authorization-code scheme                                 | `packages/shared/src/connections.ts`                                                          |
| 4    | Start: pick scheme, check `houseOperated` and client config, random state + PKCE, consent URL from the registry                     | `convex/connections.ts`, `connectionsHttp.ts`                                                 |
| 5    | Callback: single-use state, code exchange at the registry token URL; Instagram swaps to its 60-day token                            | `convex/connectionsNode.ts`                                                                   |
| 6    | Call: connection chosen before any charge; token refreshed under a lease; injected only if the upstream host is a provider API host | `apps/gateway/src/next/pipeline.ts`, `connections.ts` (`resolveCallConnection`), `forward.ts` |
| 7    | Long-lived tokens renewed by an hourly cron before they lapse unused                                                                | `convex/crons.ts` → `scheduleRenewals`                                                        |
| 8    | Disconnect: Zevium stops using the grant at once and asks the provider to revoke it, best effort                                    | `connections.revoke` → `revokeAtProvider`                                                     |

## Roles

| Piece                   | Owns                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| Provider registry       | Endpoints, scopes, quirks, API hosts. Reviewed code; a spec cannot change any of it                  |
| Deployment env (Convex) | Zevium's client ID + secret per provider app                                                         |
| Listing spec            | Which provider and scopes each operation needs                                                       |
| Gateway `/connections`  | API-key management (start, list, get, revoke); provider callback                                     |
| Gateway metered call    | Picks the connection, checks the upstream host, adds `Authorization: Bearer <consumer token>`        |
| Convex `connections*`   | Pending links, single-use state, PKCE, code exchange, refresh with lease, renewal, encrypted storage |
| Provider                | Consent screen, codes, tokens, app review, quotas                                                    |

## Flow

```mermaid
sequenceDiagram
  participant App as Consumer app / agent
  participant U as Account owner (browser)
  participant G as Gateway
  participant X as Convex
  participant P as Provider (OAuth)
  participant API as Provider API
  App->>G: POST /connections {api, label?, returnUrl?} + API key
  G->>X: /connections-start (org, project, redirectUri)
  X-->>G: connection (pending) + authorizationUrl (registry URL, Zevium client id, state, PKCE)
  G-->>App: 201 authorizationUrl
  App->>U: open authorizationUrl
  U->>P: sign in + consent to Zevium's app
  P-->>U: redirect gateway /connections/callback?code&state
  U->>G: GET /connections/callback
  G->>X: /connections-callback (state, code)
  X->>P: token request (code + verifier + Zevium client secret)
  P-->>X: access (+ refresh) token
  X-->>G: active (+ returnUrl)
  G-->>U: 303 returnUrl?zevium_connection&zevium_status, or plain page
  App->>G: POST /gateway/zevium/youtube/upload/youtube/v3/videos + API key
  G->>X: /gateway-connection-token (cache miss only; refreshes when due)
  G->>API: request + Authorization: Bearer <consumer token> (provider host only)
  API-->>App: result (metered like any call)
```

## Providers (registry)

| Provider    | Client env          | Authorize / token                                                            | Quirks                                                                                                                          | API hosts                                      |
| ----------- | ------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `youtube`   | `OAUTH_GOOGLE_*`    | `accounts.google.com/o/oauth2/v2/auth` / `oauth2.googleapis.com/token`       | `access_type=offline`, `prompt=consent`; PKCE; revoke refresh token at `/revoke`                                                | `www.googleapis.com`, `youtube.googleapis.com` |
| `tiktok`    | `OAUTH_TIKTOK_*`    | `www.tiktok.com/v2/auth/authorize/` / `open.tiktokapis.com/v2/oauth/token/`  | `client_key` not `client_id`; comma scopes; no PKCE on web; revoke needs client auth                                            | `open.tiktokapis.com`                          |
| `instagram` | `OAUTH_INSTAGRAM_*` | `www.instagram.com/oauth/authorize` / `api.instagram.com/oauth/access_token` | Comma scopes; no PKCE; `data: [...]` response; swap to 60-day token; refresh by GET with the token itself; renewed 7 days early | `graph.instagram.com`                          |

Adding a provider = one registry entry, two env vars, the provider's app registration with the callback URL, and tests.

## Spec contract

```json
"servers": [{ "url": "https://www.googleapis.com" }],
"components": {
  "securitySchemes": {
    "youtube": {
      "type": "oauth2",
      "x-zevium-oauth-provider": "youtube",
      "flows": {
        "authorizationCode": {
          "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth",
          "tokenUrl": "https://oauth2.googleapis.com/token",
          "scopes": { "https://www.googleapis.com/auth/youtube.upload": "Upload videos" }
        }
      }
    }
  }
},
"paths": {
  "/upload/youtube/v3/videos": {
    "post": {
      "x-zevium-cost": 50,
      "security": [{ "youtube": ["https://www.googleapis.com/auth/youtube.upload"] }]
    }
  }
}
```

- Only `oauth2` + `authorizationCode` schemes **with** `x-zevium-oauth-provider` are connected-account schemes. Other OAuth schemes stay documentation only, as before.
- Validation errors block save/publish: unknown provider; `authorizationUrl`/`tokenUrl` different from the registry's; scopes the provider doesn't allow; `servers[0].url` host not one of the provider's API hosts; more than 4 schemes; an operation mixing two schemes.
- The spec documents the flow; Zevium always uses the registry. A spec can never redirect Zevium's client secret or a user's token.
- Effective security: operation `security`, else root `security`. **Required** when every alternative names the scheme; **optional** when another alternative is `{}`.
- Scopes requested at connect time = union of scopes the operations list, limited to declared scopes.

## Consumer API (gateway, Zevium API key)

| Request                                                                      | Result                                                                                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `POST /connections` `{api:"publisher/project", scheme?, label?, returnUrl?}` | `201 {connection, authorizationUrl, expiresAt, next}`                                                     |
| `GET /connections`                                                           | `{connections: ConnectionView[]}` (newest first, revoked hidden)                                          |
| `GET /connections/:id`                                                       | `{connection}` or 404                                                                                     |
| `DELETE /connections/:id`                                                    | `{connection}` with `status: "revoked"`                                                                   |
| `GET /connections/callback?state&code\|error`                                | Provider redirect target. 303 to `returnUrl` with `zevium_connection`, `zevium_status`; else a plain page |

- `ConnectionView`: `id` (`conn_` + 26 base32), `api`, `scheme`, `provider`, `label`, `status` (`pending`, `expired`, `active`, `reauthorize`, `failed`, `revoked`), `scopes`, `createdAt`, `connectedAt`, `error`.
- `label` (≤ 64 printable chars) maps connections to the app's own end users. Many connections per org and API.
- Same evidence as calls: signed key and route snapshots. Disabled, expired or lapsed-grace keys 403; archived orgs and unknown keys 401; private APIs 404 for other orgs; deprecated `entitled_only` APIs 403; sunset or retired 410. Management routes are not rate limited (the per-key limiter lives in wallet admission); writes are bounded by the 50-open-link cap.
- Start errors: `publisher_not_allowed` 403 (project not `houseOperated`), `provider_not_configured` 503 (Zevium client env missing), `no_oauth_scheme`/`scheme_required`/`scheme_not_found` 400, `too_many_pending` 429 (50 open links per org).
- `returnUrl`: https, or http on localhost/127.0.0.1.

## Metered calls

The pipeline (`execute` → `resolveCallConnection`) resolves the connection after route matching and **before** wallet admission (free tier or reservation), so every failure below costs 0.

| Outcome                               | Response                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| one active connection, or header id   | upstream gets `Authorization: Bearer <token>`; response `x-zevium-connection` |
| upstream host not a provider API host | 422 `connection_upstream_not_allowed`; no token lookup                        |
| none                                  | 403 `connection_required` + `connect` hint (`POST /connections` body)         |
| several, no header                    | 409 `connection_ambiguous`; choose with `x-zevium-connection: conn_…`         |
| header id not this org/API            | 404 `connection_not_found`                                                    |
| refresh rejected by provider          | 403 `connection_reauthorize` + `connect` hint                                 |
| Convex/provider unavailable           | 503 `connections_unavailable` (required ops only)                             |

- The consumer token overrides a publisher `authorization` header; other publisher headers still apply.
- `x-zevium-connection` is stripped like every `x-zevium-*` header; CORS allows and exposes it.
- MCP `call_api` builds the same request, so it uses the single active connection automatically; it can't pick one of several yet.

## Storage and security

- Table `oauthConnections` (`convex/schema/connections.ts`, the 37th application table; consumer org, project, scheme, provider, status, encrypted verifier/access/refresh tokens, expiry, token revision, refresh lease, `renewAt`). No client table: client credentials live only in env.
- Encryption: existing AES-GCM keyring (`UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS`), binding `oauth-connection` (`connId:access|refresh|verifier`), so ciphertexts can't be swapped between rows or fields.
- `state`: 32 random bytes; only its SHA-256 is stored; claimed and cleared in one mutation (single use); 10-minute expiry. PKCE S256 for providers that support it; verifier encrypted.
- Randomness and encryption for new links happen in the httpAction, not in a mutation.
- Provider requests: Node action through `requestPinnedHttpsForBody` (webhook transport: https only, DNS-pinned to public IPs, 10 s deadline, 64 KiB cap, no redirects). GET for the Instagram swap and refresh.
- Client secret: read from env per request, never stored, never returned by a query. Rotating it needs no migration.
- Refresh: 60 s before expiry on the call path, one at a time per connection (15 s lease keyed to the token revision). Concurrent callers wait 750 ms and re-read. Non-rotating providers keep the old refresh token. `invalid_grant`/`invalid_client`/`unauthorized_client` (and Graph error code 190) → `reauthorize`, tokens dropped; other failures keep the grant (503). Missing client env → 503, grant kept.
- Renewal cron `renew-oauth-connections` (hourly, 25 per run): active rows with `renewAt <= now` (Instagram: expiry − 7 days) get a normal leased refresh.
- Revoke: row revoked and tokens dropped in one mutation, which schedules `revokeAtProvider` (Google: refresh token at `/revoke`; TikTok: access token plus client auth; Instagram has no endpoint). Failures are ignored.
- Gateway cache: per isolate, 60 s, never past token expiry minus 60 s; failures never cached. Revoke takes effect within 60 s.
- Cleanup cron `cleanup-oauth-connections` (hourly): deletes links abandoned for 1 h, and failed or revoked rows after 30 days.
- **House listings only:** every token is issued to Zevium's provider apps, so only projects with `houseOperated: true` (Zevium-operated listings; new projects default to false) can start connections.

**Link phishing (known, not mitigated):** `authorizationUrl` is a bearer capability. Anyone who completes it connects _their_ account into the org that created it. Apps must show it only to the account owner.

## Activation

1. Register Zevium's app with each provider. Redirect URI: `https://gateway.zevium.dev/connections/callback` (per environment gateway origin).
2. Set Convex env: `OAUTH_GOOGLE_CLIENT_ID/SECRET`, `OAUTH_TIKTOK_CLIENT_ID/SECRET` (TikTok client key), `OAUTH_INSTAGRAM_CLIENT_ID/SECRET`. Existing `GATEWAY_INTERNAL_SECRET` and `UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS` are reused.
3. Deploy Convex (table, routes, crons) before the Worker.
4. Publish house listings (`houseOperated`) with provider schemes (spec example above).
5. Pass provider review before real users (#445): see [research](../research/connected-accounts-providers.md#approval-and-quota). Until then YouTube uploads and TikTok posts are private-only and quota is tiny.

## Tests

- `packages/shared/src/connections.test.ts`: provider binding, foreign endpoints/scopes rejected, plain OAuth schemes ignored, upstream host rule, required/optional detection, scope union, authorize URL for Google and TikTok, token parsing (JSON, form, Instagram `data`, Graph 190, errors, non-bearer).
- `tests/connections.test.ts`: `houseOperated` gate and client config errors, PKCE link from the registry, single-use exchange with Zevium's client secret, denied/expired, selection, refresh (non-rotating), rejected vs transient refresh, revoke + provider revocation, cleanup, Instagram swap + renewal cron + GET refresh.
- `apps/gateway/test/connections.test.ts`: connection resolution (host lock, required/optional, ambiguous + header selection, fail closed), Bearer injection over publisher auth and header stripping in `forward`, management auth (missing/invalid/disabled/unavailable), validation, private APIs, list/get/revoke, callback redirect and pages, worker routing, token cache.

## Not done

- Media hosting: Instagram publishes only from a public media URL; large YouTube uploads need resumable sessions beyond Worker body limits (#444).
- Bring-your-own provider client per org (own quota and review) (#446).
- App confirm step against link phishing.
- MCP `call_api` choosing among several connections.
- Per-auth-event fee (per-call only for now). `lastUsedAt` on connections.
