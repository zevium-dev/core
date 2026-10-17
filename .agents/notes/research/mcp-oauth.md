# Research: OAuth for Zevium

> 2026-10-10, revised 2026-10-11 against `origin/develop` `1a47ba0`. Status: **research**. The MCP
> OAuth resource server is built (#401, issue #323) but inactive until the owner configures it.
> Everything under "gaps" and "proposed" is a proposal, not a decision.
> Related: [agent-surface](../features/agent-surface.md#mcp-oauth-323) (owns MCP OAuth tech and
> activation steps), [api-keys](../features/api-keys.md), [accounts-orgs](../features/accounts-orgs.md),
> [upstream-credentials](../features/upstream-credentials.md),
> [connected-accounts](../features/connected-accounts.md)

## 0. Summary

OAuth shows up in four places in an agent-first, pay-per-call gateway:

| #   | Role                                                                                                    | Direction                                  | Zevium today                                                                                                  | Recommendation                                                    |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| R1  | Sign-in to the product (GitHub, Google)                                                                 | Zevium is an OAuth **client** of identity  | Clerk: email+password and Google                                                                              | Config only: enable GitHub in Clerk                               |
| R2  | **Connected accounts**: a consumer links its own third-party account and the gateway injects that token | Zevium is an OAuth **client** of upstreams | Prioritized 2026-10-11; built in PR (#351): Zevium-owned clients for YouTube, TikTok, Instagram               | See [provider research](connected-accounts-providers.md)          |
| R3  | **OAuth for MCP clients**: "click to connect" from Claude, ChatGPT, Cursor                              | Clerk **issues**; gateway verifies         | **Built in #401**: Clerk is the authorization server, the gateway is the resource server. Off until activated | **P0**: activate, run live acceptance, close gaps G2–G8 (§1)      |
| R4  | The same authorization server for another first-party client (e.g. a spreadsheet add-on)                | Clerk issues tokens                        | n/a                                                                                                           | Reusable after R3, but needs its own client, resource and consent |

The architecture question (who is the authorization server) is settled: Clerk, built in #401. What
remains for R3 is activation, a live test with real clients, and product gaps: a silent failure when
the user's key setup doesn't match, the `key` tool argument, consent without balances, no grant
management, and no tool annotations for directory listing.

## 1. Where Zevium stands today

| Area                                | Current state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Code                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Sign-in                             | Clerk: email+password, Google OAuth. Live dashboard provider config not recorded in repo                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Clerk dashboard                                                   |
| MCP, OAuth **off**                  | Default. `initialize`/`tools/list` open; `search_apis`, `get_api_docs` anonymous; `call_api_read`/`call_api_write` key only from `Authorization`/`x-api-key` (no `key` argument since 2026-10-17); missing key = tool error inside HTTP 200                                                                                                                                                                                                                                                                                              | `apps/gateway/src/mcp.ts` (`handleCallApi`)                       |
| MCP, OAuth **on**                   | Both `MCP_OAUTH_ISSUER` and `MCP_OAUTH_RESOURCE` set. Every `/mcp` request needs a bearer (API key, signed wallet session, or OAuth token): none → 401 + `WWW-Authenticate` (`resource_metadata`, `scope`); bad/expired → 401 `invalid_token`; missing scope → 403 `insufficient_scope`; verifier outage → 503; GET → 405                                                                                                                                                                                                                | `apps/gateway/src/index.ts`                                       |
| Discovery                           | PRM at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`; root `/.well-known/oauth-authorization-server` redirects to Clerk's metadata. Scopes `user:org:read`, `zevium:mcp:execute`. Config must be HTTPS, issuer an origin, resource path exactly `/mcp`                                                                                                                                                                                                                                         | `apps/gateway/src/mcp-oauth.ts`                                   |
| Token verification (JWT)            | `jose` RS256; exact issuer; `aud` = canonical `/mcp` URL; `typ` `at+jwt`; required `exp iat sub jti client_id org_id`; both scopes. JWKS cached 5 min, 30 s unknown-key cooldown. Signature and expiry checked on every request                                                                                                                                                                                                                                                                                                          | `mcp-oauth.ts` (`ClerkMcpOAuthVerifier`)                          |
| Token verification (opaque `oat_…`) | Cache miss: Clerk Backend API verify (revoked, expired, `aud`, scopes), then Clerk `/oauth/userinfo` for `org_id` (Backend API omits it); subjects must match                                                                                                                                                                                                                                                                                                                                                                            | `mcp-oauth.ts`                                                    |
| Caching / hot path                  | Verification + identity cached 60 s, 512 entries, keyed by SHA-256 of token, concurrent misses coalesced. Clerk/Convex are only called on a miss. Failed refresh fails closed                                                                                                                                                                                                                                                                                                                                                            | `mcp-oauth.ts`, `apps/gateway/src/cache.ts`                       |
| Identity → wallet                   | `(user, org)` → `/mcp-identity` → `resolveMcpIdentity` → the current, active, verified, non-expired key owned by that user in that org (oldest if the one-current-key invariant ever breaks). OAuth spends through that key's wallet, cap, rotation family and revocation controls. No such key → keyless session (2026-10-17, G2), and the first connect auto-creates the member's key (`provisioning: true` until it lands); `null` only for inactive org, deleted user or removed membership without a key verified after the removal | `convex/http.ts`, `convex/keySettings.ts` (`resolveMcpIdentity`)  |
| Key verification                    | Clerk machine API keys (`ak_…`/`zev_…`) with an edge cache; org selects the wallet DO                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `apps/gateway/src/key-verifier.ts`                                |
| Upstream auth                       | Publisher-owned static headers, AES-GCM encrypted in Convex, injected after consumer auth headers are stripped                                                                                                                                                                                                                                                                                                                                                                                                                           | `convex/upstreamCredentials.ts`, `apps/gateway/src/pipeline.ts`   |
| Consumer accounts                   | None. Issue #351; BYOK rejected in favour of connected accounts                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | [decision](../decisions/2026-10-10-no-byok-connected-accounts.md) |

**Gaps (R3):**

| #   | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Impact                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| G1  | **Not activated.** Clerk dashboard config and Worker vars pending; no live client has completed the flow                                                                                                                                                                                                                                                                                                                                                                                                                            | Click-to-connect unavailable; ChatGPT/Claude directory listings blocked |
| G2  | **Resolved 2026-10-17 (options c then a).** Zero usable keys → authenticated keyless session; first connect auto-creates the member's key ("MCP (auto-created)"; `oauth_key_provisioning` meanwhile). Not permitted, failed, or a later-revoked auto key → `oauth_missing_api_key` with a `/app/settings/keys` link; disabled key → `oauth_key_disabled` (re-enable or rotate); removed member with no key newer than the removal → `null` (401). Several keys → oldest current key ([agent-surface](../features/agent-surface.md)) | —                                                                       |
| G3  | **Resolved 2026-10-17.** No tool takes a `key` argument; a passed `key` is refused ([decision](../decisions/2026-10-17-mcp-no-key-argument.md))                                                                                                                                                                                                                                                                                                                                                                                     | —                                                                       |
| G4  | **Consent is Clerk-hosted.** Org picker without balances; no self-registered-client warning beyond Clerk's own copy                                                                                                                                                                                                                                                                                                                                                                                                                 | Users can connect an empty wallet; weak consequence statement           |
| G5  | **No grant management.** Nothing in `/app/settings/keys` lists or disconnects connected agents; changing org means reconnecting                                                                                                                                                                                                                                                                                                                                                                                                     | Users can't see or revoke what's spending                               |
| G6  | **Org not stated in responses.** No `whoami`/balance output telling the agent which org and key pay                                                                                                                                                                                                                                                                                                                                                                                                                                 | Agent and human can't confirm the wallet in use                         |
| G7  | **Resolved 2026-10-17 (#324).** Every tool carries `title` + `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`; `call_api_read` (GET/HEAD) is read-only, `call_api_write` destructive; both open-world. [claude-connectors-directory](claude-connectors-directory.md)                                                                                                                                                                                                                                               | —                                                                       |
| G8  | **Clerk lifecycle unverified.** Refresh rotation, replay revocation of the token family, refresh-token lifetime, configurable JWT TTL                                                                                                                                                                                                                                                                                                                                                                                               | Unknown exposure if a refresh token leaks                               |

## 2. How MCP OAuth has to work

### Discovery and registration

- The resource serves Protected Resource Metadata (RFC 9728), one document per MCP surface. The
  authorization server serves RFC 8414 metadata advertising S256 PKCE and its registration methods.
- **Two client registration methods exist:**
  - **DCR (RFC 7591)**: recommended by the MCP 2025-06-18 spec; used by Claude Code.
  - **CIMD** (the client id _is_ an HTTPS URL to a metadata document): recommended by the MCP
    2025-11-25 spec, which makes DCR optional.
  - ChatGPT supports CIMD, DCR and pre-registered clients. Supporting both is the safe interop
    choice, not a hard requirement.
- Redirect URIs match exactly, query included. The only exception is the loopback port
  (RFC 8252 §7.3).

### Eager 401

- If `initialize` and `tools/list` stay open, clients show "Connected" and never prompt for
  sign-in. The user is stuck with a server that answers but can't do anything.
- So requests without a credential get **401** with
  `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`.
- An expired or invalid access token gets **401 `error="invalid_token"`** (RFC 6750). Many clients
  only run their refresh grant on that exact error code. Corollary: never answer `invalid_token` for
  a token that is valid but can't be used (G2), or the client refreshes forever.
- A valid token without a needed scope gets **403 `insufficient_scope`**.

### Audience binding

- Each token's `aud` is the MCP resource the user consented to (RFC 8707 `resource` parameter).
  Without that check, a token minted for some _other_ resource on the same authorization server
  could spend the user's balance.
- The audience check is mandatory, with no permissive default. Each MCP surface has its own
  audience. One canonical resource URL; aliases normalised and tested.

### Consent screen is the security boundary

- States the consequence in plain words: calls will spend the selected org's credits.
- Warns when the client self-registered, because DCR is open to anyone.
- Has an **org picker that shows each org's balance**, so the user doesn't pick an empty wallet.
- Approval is a POST, same-origin, framing denied.
- If sign-in interrupts the flow, the pending authorization is resumed after sign-in without
  becoming an open redirect.

### The org choice stays visible and reversible

- Tool responses say which org and identity a session is spending from.
- A refresh never changes orgs.
- Removing a membership blocks that member's grants within a stated bound.
- Grants are listed and revocable by the user.

### Codes and refresh

- Authorization codes are single-use, consumed atomically.
- Refresh tokens rotate; replaying a spent one revokes the whole token family, because a retry and
  a thief look identical.

### Two ways in

- Click-to-connect OAuth.
- An **org-pinned API key as `Authorization: Bearer`**. MCP clients only fall back to OAuth on a
  401, so a valid header gets a 200 and works headless (CI, installers).
- Secrets never travel as tool arguments.

### Testing and directory listing

- A dev-only fake third-party client, off in production, runs the real flow end to end. It catches
  bugs unit tests miss.
- Anthropic's directory policy requires accurate tool annotations (`readOnlyHint`,
  `destructiveHint`, a title). A generic tool like `call_api` can read or write, so truthful
  annotation may require splitting it into read and write tools, or a separate curated surface.

## 3. Clerk as the authorization server

| Capability                               | Status                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DCR (RFC 7591)                           | Yes, `/oauth/register`; off until enabled                                                                                                                          |
| CIMD                                     | Yes, generally available; off until enabled; requires public clients, exact redirects, S256, consent                                                               |
| S256 PKCE                                | Yes, enforceable instance-wide                                                                                                                                     |
| Org pin                                  | Yes. Scope `user:org:read` makes consent show an org picker; the token carries `org_id`. **With consent off, Clerk uses the last active org**, so consent stays on |
| Custom consent page                      | Yes, including TanStack Start; submits `organization_id` with approval                                                                                             |
| Audience binding                         | Yes, `aud` from RFC 8707 `resource`; code exchange and refresh inherit it                                                                                          |
| JWT access tokens                        | Verify offline with cached JWKS. **Cannot be revoked**, including through the Backend API; valid until expiry (24 h default)                                       |
| Opaque access tokens                     | Revocable. Backend API verify returns revoked/expired/`aud`/scopes but **omits `org_id`**; `/oauth/userinfo` returns the consented org                             |
| Code lifetime                            | 10 min                                                                                                                                                             |
| Refresh-token lifetime                   | Unclear: docs say never expires, API spec says 10 years                                                                                                            |
| Refresh rotation and replay revocation   | **Unverified** (G8)                                                                                                                                                |
| Shorter JWT TTL                          | **Unverified** (G8)                                                                                                                                                |
| Org role / custom claims in OAuth tokens | **Unverified**                                                                                                                                                     |

**SDK traps** (the #401 verifier uses `jose` and raw HTTP, so it avoids both; keep avoiding them):

- Clerk's backend auth object for OAuth tokens drops `org_id`, and `@clerk/mcp-tools` forwards only
  the user id.
- The `@clerk/mcp-tools` Hono helper returns a bare 401 for invalid tokens, without
  `error="invalid_token"`.

## 4. Decision status: Clerk is the authorization server

Built in #401 (option "Clerk as AS"). The alternatives, an own authorization server or a hybrid
where Clerk proves identity and Zevium mints org- and audience-bound tokens, stay as the fallback
only if live acceptance fails on org pinning, audience or token lifecycle. An org-pinned,
audience-bound token is a hard requirement, because the org selects the wallet that pays.

**Opaque over JWT** is the recommended token format: it is the only one a user or admin can revoke
before expiry. The cost is one Clerk Backend API call plus one userinfo call per token per 60 s cache
window, which stays off the hot path.

**Live acceptance (G1, G8)** must show:

- Claude.ai, Claude Code, ChatGPT and Cursor complete discovery, registration (DCR or CIMD), S256,
  consent and refresh.
- The org picked at consent survives browser org switching and refresh; substituting an org the user
  can't spend from fails.
- The exact `/mcp` audience survives refresh; a wrong `aud` gets 401.
- Disconnecting the grant in Clerk blocks spending within 60 s (opaque). Disabling the key or
  removing the membership blocks within 60 s (both formats).
- Refresh tokens rotate and a replayed one revokes the family (record the result either way).
- Zero balance blocks; the key's cap applies.
- If JWT format stays enabled: JWKS key rotation doesn't break verification.

## 5. What to build, by priority

### 5.1 MCP OAuth (R3): compliance and gaps

| Requirement (§2)                            | Status                                                      |
| ------------------------------------------- | ----------------------------------------------------------- |
| PRM + authorization-server discovery        | Built                                                       |
| Eager 401, `invalid_token`, 403 scope       | Built (when OAuth on)                                       |
| Mandatory audience, canonical `/mcp`        | Built                                                       |
| Org pin → wallet                            | Built, via key mapping; keyless sessions explain (G2)       |
| S256, DCR, CIMD, exact redirects, codes     | Clerk-owned; enable in dashboard (G1)                       |
| Refresh rotation + replay revocation        | Clerk-owned; unverified (G8)                                |
| Revocation bound                            | Built: ≤ 60 s for opaque grants, key and membership changes |
| No per-request Clerk/Convex calls           | Built: cache-miss only                                      |
| Consent with consequence, balances, warning | Partial: scope copy only (G4)                               |
| Org visible and grants manageable           | Missing (G5, G6)                                            |
| Secrets never in tool arguments             | Built 2026-10-17 (G3)                                       |
| Tool annotations                            | Built 2026-10-17 (G7), read/write split                     |
| End-to-end fake-client test                 | Missing: `e2e/` has no MCP OAuth script                     |

**Proposed fixes:**

- **P0, G1/G8: activate and accept.** Owner steps in
  [agent-surface](../features/agent-surface.md#mcp-oauth-323), using opaque tokens and enabling both
  DCR and CIMD. Record the §4 acceptance results in agent-surface.
- **P0, G2: never answer a usable token with `invalid_token`.** Options:
  - (a) Auto-provision a dedicated "MCP connector" key for that user and org on first connect. It
    appears in the key list with its own cap. Removes the precondition entirely.
  - (b) Let the user mark one key per org as the MCP key; pick it deterministically.
  - (c) Keep the rule, but authenticate the transport and fail `call_api` with a readable tool error
    naming the org and linking `/app/settings/keys`.
  - (a) is the best UX; (c) is the smallest change. Either way, no 401.
  - **Built 2026-10-17: (c), then (a)** with one change: the auto-created key is the member's one
    current key, not an extra key ([decision](../decisions/2026-10-17-mcp-auto-created-key.md)).
- **P0, G3: delete the `key` tool argument** — built 2026-10-17; header or OAuth only.
- **P1, G4: custom consent page** in `apps/web` (Clerk supports TanStack Start; it submits
  `organization_id`): consequence in words, org list **with balances** from the existing wallet
  query, self-registered-client warning, POST + same-origin + no framing.
- **P1, G5: grant management** in `/app/settings/keys`, next to API keys: list connected agents
  (client, org, last used), disconnect (revoke the opaque token in Clerk).
- **P1, G6: say who pays.** A `whoami`/balance tool or a field in tool responses naming the org and
  key.
- **P1, G7: annotations.** Accurate `readOnlyHint`/`destructiveHint`/title; split `call_api` (done 2026-10-17)
  by HTTP method (GET/HEAD read; others write) before directory submission.
- **P1: e2e.** `e2e/05-mcp-oauth.sh` driving a dev-only fake client through discovery, DCR,
  consent, a paid call, refresh and revocation.

**Unchanged by any fix:** zero balance still blocks; OAuth changes how a caller authenticates, not
what the wallet allows.

### 5.2 P1: OAuth for publisher upstreams

Today a publisher can only give us a static header. Many real APIs use **OAuth2 client
credentials** (machine-to-machine) or expiring tokens.

- Extend upstream credentials with a typed kind: `static_header` (today), `oauth2_client_credentials`
  (token URL, client id/secret, scopes, audience) and later `oauth2_refresh_token`.
- **Mint and refresh off the hot path.** Convex holds the encrypted client secret. A scheduled action
  refreshes the access token ahead of expiry, serialized per credential (one Convex mutation owns the
  refresh, so two workers can't both redeem a rotating refresh token), with the write-back
  conditional on the previous ciphertext so a stale write can't clobber a rotated token. The gateway
  receives only the short-lived access token through the existing spec/credential sync channel and
  caches it with its expiry. The Worker never sees the client secret.
- **Provider dialects differ** (client auth in body vs HTTP Basic, scope separator, PKCE). Persist
  the refresh dialect on the credential at connection-test time; otherwise connect works and every
  refresh fails later.
- **Expiry and health are separate states** in the publisher console, with alerts through the
  existing publisher webhooks and notifications. Transient upstream 5xx/429 reads as "unknown", not
  "invalid".
- Keep "the spec is the source of truth": publishers can declare the scheme in OpenAPI
  `securitySchemes`, but secret material lives only in upstream credentials, never in the spec.

### 5.3 Consumer-connected accounts (R2, #351)

> Update 2026-10-11: prioritized and built as Zevium-owned provider clients. Current research: [connected-accounts-providers](connected-accounts-providers.md); design: [design/connected-accounts](../design/connected-accounts.md). Text below is the original requirement sketch.

Only relevant if Zevium lists APIs that act **on the consumer's own third-party account**, e.g. a
publisher wraps Google Ads and each consumer org must authorise its own Ads account. Feature
ownership: [connected-accounts](../features/connected-accounts.md).

**Requirements:**

- Per-(org, provider) encrypted grants with offline access; the consent URL requests offline access
  so a refresh token comes back, with per-provider parameter overrides.
- The publisher declares, in the spec, which provider grant and scopes an endpoint needs.
- A consumer consent flow in the app, with `redirect_uri` pinned to Zevium's callback.
- Gateway injection of the consumer's token instead of, or alongside, the publisher's. One request
  can need several secrets (e.g. Google Ads: OAuth bearer plus developer-token header).
- Resource selection where the user token isn't the token the API wants (e.g. Meta Page tokens).
- A **428 remediation body** naming the provider, missing scopes and the action to take, so agents
  can ask the human to connect. Keep it distinct from MCP-level 401/403. Never include a credential.
- Expiry warnings for non-refreshable tokens (some die silently around day 60), health sweeps, and
  garbage collection of abandoned connect attempts (they hold a secret and a replayable `state`).

**Why it's P2:**

- The real cost is **platform app approval** (Google Ads developer token, Meta App Review), not code.
- It blurs who is liable for actions taken on a consumer's account.
- Revisit when a real publisher asks for it.

### 5.4 Config-only: sign-in (R1)

Enable GitHub (developer audience) alongside Google in the Clerk dashboard. No code change. Check the
live dashboard first; current provider config is not recorded in the repo.

## 6. Open questions for the product owner

1. ~~G2 upgrade~~ — answered 2026-10-17: auto-create the member's key on first connect.
2. Can an OAuth grant spend from any org the user belongs to, or only orgs where they're
   `org:admin`? Should a grant have its own cap, or keep sharing the key's cap?
3. Opaque tokens only, or keep JWT format enabled? JWTs can't be revoked before expiry.
4. ~~One surface or a curated directory surface?~~ — answered 2026-10-17: one surface; `call_api` split
   into `call_api_read` / `call_api_write`.
5. Is publisher-upstream OAuth (§5.2) needed for any publisher we're courting now?
6. Is a 60 s revocation bound acceptable for disconnected grants, disabled keys and removed members?

## 7. Proposed phases

| Phase | Scope                                                                            | Exit criteria                                                                                    |
| ----- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 0     | Activation + live acceptance (G1, G8)                                            | §4 results recorded in agent-surface; Claude.ai and Claude Code connect and make a paid call     |
| 1     | G2 identity fix + G3 `key` argument removal                                      | Built 2026-10-17: no `invalid_token` for usable tokens; no tool schema has `key`                 |
| 2     | G4 consent page with balances, G5 grant management, G6 who-pays output           | User sees balances at consent and can list and disconnect grants                                 |
| 3     | G7 annotations + MCP OAuth e2e                                                   | Directory submission ready; `e2e/05-mcp-oauth.sh` green                                          |
| 4     | Publisher upstream `oauth2_client_credentials` with off-path, serialized refresh | Publisher connection test passes against an OAuth upstream; gateway never sees the client secret |
| 5     | Consumer-connected accounts (#351), prioritized 2026-10-11                       | Built in PR; activation needs provider app reviews                                               |

Notes to update when built: [agent-surface](../features/agent-surface.md) (MCP OAuth tech, gaps
closed), [api-keys](../features/api-keys.md) (MCP key rule), [accounts-orgs](../features/accounts-orgs.md)
(consent, grant management).
