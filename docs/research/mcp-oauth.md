# Research: OAuth for Zevium

> 2026-10-10. Status: **proposal only**. Nothing has been built.

## 0. Summary

OAuth shows up in four places in an agent-first, pay-per-call gateway:

| #   | Role                                                                                                         | Direction                                  | Zevium today                                                              | Recommendation                                                           |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| R1  | Sign-in to the product (GitHub, Google)                                                                      | Zevium is an OAuth **client** of identity  | Clerk does this (FLOW.md lists Google; live dashboard config unverified)  | Config only: enable GitHub in Clerk                                      |
| R2  | **Connected accounts**: a consumer links its own third-party account and the gateway injects that token      | Zevium is an OAuth **client** of upstreams | Nothing. Upstream auth is a static publisher-owned header                 | **P2**: only once publisher APIs need to act _on the consumer's_ account |
| R3  | **Zevium as an OAuth authorization server for MCP clients**: "click to connect" from Claude, ChatGPT, Cursor | Zevium **issues** tokens                   | Nothing. `/mcp` takes a raw API key in a header **or as a tool argument** | **P0/P1**: biggest agent-UX win and closes a key-leak path               |
| R4  | The same authorization server for another first-party client (e.g. a spreadsheet add-on)                     | Zevium issues tokens                       | n/a                                                                       | Reusable after R3, but still needs its own client, resource and consent  |

The highest-leverage move is **R3**: make `/mcp` a spec-compliant OAuth-protected resource, so an
agent connects by clicking through a consent screen that picks the **org whose wallet pays**. Clerk
can issue org-pinned (`org_id`) and audience-bound (`aud` from RFC 8707 `resource`) JWTs, so **Clerk
as the authorization server is the front-runner**, pending a one-day spike on refresh rotation and
revocation (§4). A publisher-side variant of R2 also matters (§5.2): upstreams that use OAuth
client-credentials.

## 1. Where Zevium stands today

| Area                        | Current state                                                                                                                                                                                                                                                    | File                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Sign-in                     | Clerk; FLOW.md lists email+password and Google OAuth (live dashboard config unverified)                                                                                                                                                                          | `FLOW.md`, Clerk dashboard                                                                        |
| MCP auth                    | `initialize`/`tools/list` open; `search_apis` and `get_api_docs` work anonymously; only `call_api` needs a key, taken from **a tool argument** first, else `Authorization`/`x-api-key`; a missing key is a tool error inside HTTP 200, no 401, no OAuth metadata | `apps/gateway/src/mcp.ts` (`handleCallApi`)                                                       |
| Key verification            | Clerk machine API keys (`ak_…`/`zev_…`), verified via Clerk with an edge cache; the org (the `org_id` claim if present, else the key's `subject`) selects the wallet DO                                                                                          | `apps/gateway/src/key-verifier.ts`                                                                |
| Upstream auth               | Publisher-owned static headers, AES-GCM encrypted in Convex (`upstreamCredentials`), injected after consumer auth headers are stripped                                                                                                                           | `convex/upstreamCredentials.ts`, `convex/lib/credentialCrypto.ts`, `apps/gateway/src/pipeline.ts` |
| Consumer-connected accounts | none                                                                                                                                                                                                                                                             | n/a                                                                                               |

**Problems:**

1. **The key as a tool argument puts the secret in the model's context window**, and in transcripts
   and logs. Remove it.
2. **The open `initialize` lets clients show "Connected" and then fail on the first paid call.**
3. **There's no OAuth click-to-connect**, so every agent setup means copy-pasting a long-lived key.
   Some clients can send a fixed key header (Claude custom connectors support one), but OpenAI's
   directory submission has no API-key connection flow, and a pasted key is the UX to replace.

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
- A server that fetches CIMD documents must fence the fetch: HTTPS only, no redirects, public
  addresses only, short timeout, a size cap enforced while streaming, the resolved address pinned
  (blocks DNS rebinding), and the document must name its own URL.
- Redirect URIs match exactly, query included. The only exception is the loopback port
  (RFC 8252 §7.3).

### Eager 401

- If `initialize` and `tools/list` stay open, clients show "✓ Connected" and never prompt for
  sign-in. The user is stuck with a server that answers but can't do anything.
- So every id-bearing JSON-RPC request without a credential gets **401** with
  `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`. `notifications/*` and `ping` pass.
- An expired or invalid OAuth access token gets **401 `error="invalid_token"`** (RFC 6750). Many
  clients only run their refresh grant on that exact error code.
- A valid token without a needed scope gets **403 `insufficient_scope`**.
- Access-token validation is stateless (signature plus expiry), cheap enough for the transport
  layer. The flip side: a revoked grant's access token keeps working until it expires, so revocation
  needs its own mechanism (§5.1).

### Audience binding

- Each token's `aud` is the MCP resource the user consented to (RFC 8707 `resource` parameter).
  Without that check, a token minted for some _other_ MCP server could spend the user's balance.
- The audience check is mandatory in the verifier, with no permissive default.
- `/authorize` rejects a `resource` the server doesn't serve.
- Each MCP surface has its own audience, so tokens don't cross surfaces.
- One canonical resource URL. Host and trailing-slash aliases are normalised and tested across
  metadata, authorize, code exchange and refresh. Some clients omit `resource`; any fallback for that
  is a compatibility path, not the normal flow.

### Consent screen is the security boundary

- States the consequence in plain words: calls will spend the selected org's credits.
- Warns when the client self-registered, because DCR is open to anyone.
- Has an **org picker that shows each org's balance**, so the user doesn't pick an empty wallet.
- Approval is a POST, same-origin, framing denied. `Origin: null` (produced by sign-in redirect
  chains) is accepted only when `Sec-Fetch-Site` corroborates it.
- If sign-in interrupts the flow, the pending `/authorize` URL is parked in a short-lived HttpOnly
  cookie and resumed after sign-in. The cookie only honours that one path, so it can't become an
  open redirect.

### The org choice stays visible and reversible

- Tool responses say which org and identity a session is spending from.
- A grant can move to another org the same user belongs to, without re-consenting.
- A refresh never changes orgs.
- Removing a membership revokes that member's grants **immediately**, not at the next refresh.
- "Not your org" and "no such org" return the same 404.

### Codes and refresh

- Authorization codes are single-use, consumed atomically (consume-and-return), so concurrent
  redemption is impossible.
- Refresh tokens rotate.
- Retired refresh tokens are kept: replaying a spent one revokes the whole token family, because a
  retry and a thief look identical.

### Two ways in

- Click-to-connect OAuth.
- An **org-pinned API key as `Authorization: Bearer`**. MCP clients only fall back to OAuth on a
  401, so a valid header gets a 200 and works headless (CI, installers).
- An installer that writes a key into agent configs verifies the key **before** writing anything.

### Testing and directory listing

- A dev-only "fake third-party client" page, behind a flag and off in production, runs the real flow
  end to end. It catches bugs unit tests miss.
- Anthropic's directory policy requires accurate tool annotations (`readOnlyHint`,
  `destructiveHint`, a title). A generic tool like `call_api` can read or write, so truthful
  annotation may require splitting it into read and write tools, or a separate curated surface.

## 3. Clerk as the authorization server

| Capability                               | Status                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| DCR (RFC 7591)                           | Yes, `/oauth/register`; off until enabled                                                                                                      |
| CIMD                                     | Yes, generally available; off until enabled; requires public clients, exact redirects, S256, consent                                           |
| S256 PKCE                                | Yes, enforceable instance-wide                                                                                                                 |
| Org pin                                  | Yes. Scope `user:org:read` makes consent show an org picker; the token carries `org_id`. **With consent off, Clerk uses the last active org.** |
| Custom consent page                      | Yes, including TanStack Start; submits `organization_id` with approval                                                                         |
| Audience binding                         | Yes, instance setting `aud_claim_enabled` derives `aud` from RFC 8707 `resource`; code exchange and refresh inherit it                         |
| Discovery                                | `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` on the Frontend API origin                                   |
| Offline verification                     | Yes, JWT access tokens verify with cached JWKS                                                                                                 |
| Access-token / code lifetime             | 24 h / 10 min                                                                                                                                  |
| Refresh-token lifetime                   | Unclear: docs say never expires, API spec says 10 years                                                                                        |
| Refresh rotation and replay revocation   | **Unverified**                                                                                                                                 |
| Shorter access-token TTL                 | **Unverified**                                                                                                                                 |
| Org role / custom claims in OAuth tokens | **Unverified**                                                                                                                                 |
| Instant revocation                       | No, inherent to offline JWTs                                                                                                                   |

**SDK traps:**

- Clerk's backend auth object for OAuth tokens drops `org_id`, and `@clerk/mcp-tools` forwards only
  the user id. Read `org_id` from the verified JWT directly.
- The `@clerk/mcp-tools` Hono helper returns a bare 401 for invalid tokens, without
  `error="invalid_token"`. Write the challenge ourselves.

## 4. Decision: who is the authorization server?

| Option                                                                                                                                                     | Pros                                                                                                                                                   | Cons                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **A1. Clerk as AS** (Clerk OAuth Applications, JWT access tokens)                                                                                          | Clerk already owns identity; DCR, CIMD, PKCE, discovery, org pin, audience binding, custom consent and offline verification all supported (§3)         | Refresh rotation, replay revocation and shorter TTLs unverified; no instant revocation; refresh-token lifetime unclear |
| **A2. Own thin AS** (authorize/consent in TanStack Start, token and state in Convex, JWT signing with our own key, verified in the Worker via cached JWKS) | Full control of `aud`, the org pin, consent, refresh-family replay detection, grant org-moves                                                          | Most surface to own and secure; no clear benefit over A3 while Clerk owns identity                                     |
| **A3. Hybrid**                                                                                                                                             | Clerk handles _who the user is_; our consent page picks the org; our AS mints short-lived, org- and audience-bound JWTs with rotating refresh families | Two token layers; we own token lifecycle                                                                               |

**Recommendation:** **A1, conditional on a one-day spike.** The spike must prove:

- Claude Code, Claude.ai, ChatGPT and Cursor complete discovery, registration (DCR or CIMD), S256,
  consent and refresh.
- The org picked at consent survives browser org switching and refresh; substituting an org the user
  can't spend from fails. Consent stays **on**.
- The exact `/mcp` audience survives refresh; a missing or wrong `aud` fails in the Worker.
- Refresh tokens rotate and a replayed one revokes the family; access-token TTL can be cut well below
  24 h.
- Revoking a grant or removing a membership blocks spending within an agreed bound, with no
  per-request Clerk/Convex call.
- Cached-JWKS verification works offline and survives signing-key rotation.

If lifecycle or binding fails, go with **A3**. An org-pinned, audience-bound token is a hard
requirement, because the org selects the wallet that pays.

## 5. What to build, by priority

### 5.1 P0/P1: Zevium as an OAuth-protected MCP resource (R3)

**Goal:** an agent adds `https://gateway.zevium.dev/mcp`, gets a browser consent screen on
`zevium.dev`, picks the **org whose wallet pays** (showing its balance), and is connected. Tokens
are short-lived, refreshable and bound to that org and to the MCP audience.

**Behaviour spec (any option):**

- **Discovery:**
  - The gateway serves `/.well-known/oauth-protected-resource/mcp` (RFC 9728 path form) with the full
    `/mcp` URL as `resource`.
  - The AS serves `/.well-known/oauth-authorization-server`, advertising S256 PKCE, DCR and/or CIMD,
    and `refresh_token`.
  - One canonical resource URL, aliases tested end to end.
- **Eager challenge:** 401 with `WWW-Authenticate` for missing credentials, `error="invalid_token"`
  for expired or invalid JWTs, 403 `insufficient_scope` for missing scopes. `ping` and notifications
  pass.
- **Two accepted credentials:**
  1. An OAuth JWT. Verified in the Worker with cached JWKS: signature, trusted issuer, token type,
     `exp`, `aud == the /mcp resource`, scopes, and an org claim present and not revoked.
  2. An existing Clerk API key as a Bearer header, the headless path for CI and installers.
  - **Remove the `key` tool argument.**
- **Org pin:** the org claim maps to the wallet DO exactly like `key-verifier.ts` does today, so the
  metering and wallet path is unchanged.
- **Revocation at the edge:** short access-token TTLs plus a small revoked-grant / removed-membership
  set pushed to the edge asynchronously (same channel as the key cache). Define the
  revocation-latency budget up front.
- **Consent page** (`apps/web`, e.g. `/oauth/consent`): consequence in words, org list **with
  balances** from the existing wallet query, self-registered-client warning, POST + same-origin +
  no framing.
- **Grant lifecycle:**
  - Refresh rotation, with replay revoking the whole family.
  - Atomic single-use authorization codes (A2/A3 only; Clerk owns this under A1).
  - Grants listed in `/app/settings/keys`, next to API keys, with a revoke button.
  - Moving a grant to another org of the same user (no re-consent), if A1 allows it; otherwise
    re-consent.
  - Grant revoked immediately when the membership or the org is deleted.
- **Agent ergonomics:** MCP `balance`/`whoami` style responses say which org and identity the
  session is spending from.
- **Zero balance still blocks.** The OAuth token changes how a caller authenticates, not what the
  wallet allows. "No unmetered execution paths" is unaffected.

**Gateway hot-path compliance:** JWT verification is local (JWKS fetched rarely and cached, the
same pattern as today's key edge cache). No per-request calls to Clerk or Convex.

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

### 5.3 P2: consumer-connected accounts (R2)

Only relevant if Zevium lists APIs that act **on the consumer's own third-party account**, e.g. a
publisher wraps Google Ads and each consumer org must authorise its own Ads account.

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

## 6. Checklist

1. **401 on first contact.** Never let an MCP client handshake succeed without a credential.
2. **`error="invalid_token"` on expired tokens**, so clients refresh.
3. **Mandatory audience check**, no permissive default. Reject unknown `resource` at authorize. One
   canonical resource URL, aliases tested.
4. **Support the registration methods target clients use.** CIMD is the current MCP recommendation;
   DCR is optional but widely used. Doing both is the safe choice.
5. **Exact redirect URI match**, query included; only the RFC 8252 loopback-port exception.
6. **Consent shows consequences and balances**, and the org choice stays visible and movable later.
7. **Atomic single-use codes. Rotating refresh tokens with replay revocation of the whole family.**
8. **Secrets never enter tool arguments, responses or logs.**
9. **Verify any token before writing it into agent configs** (if we ship an installer).
10. **Dev-only fake-client page** behind a flag; `e2e/` gains a `05-mcp-oauth.sh`.
11. **Upstream OAuth:** persist the refresh dialect, serialize refresh per credential, make the
    write-back conditional, keep refresh off the request path.
12. **Budget revocation latency.** Short TTLs; revoke on membership removal directly.
13. **Enforce, don't just advertise:** S256 PKCE, trusted issuer and keys, scopes,
    `403 insufficient_scope`.
14. **If we fetch CIMD documents ourselves** (A2/A3): self-naming document, streaming size cap,
    pinned resolved address.

## 7. Open questions for the product owner

1. A1 (Clerk) vs A3 (hybrid)? A1 is the front-runner; the spike in §4 decides.
2. Can an OAuth grant spend from any org the user belongs to, or only orgs where they're
   `org:admin`? A spend cap per grant, like the existing per-key monthly caps?
3. One MCP surface with accurately annotated tools, or a separate curated surface for the Claude
   connector directory? `call_api` can read or write, so annotation alone may force a split.
4. Is publisher-upstream OAuth (§5.2) needed for any publisher we're courting now?
5. Should consumer-connected accounts (§5.3) stay out of scope until a publisher asks?
6. What revocation latency is acceptable for a removed member or a revoked grant (minutes vs the
   24 h default access-token life)?

## 8. Proposed execution phases (after sign-off)

| Phase     | Scope                                                                                                             | Exit criteria                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 0         | Spike Clerk-as-AS (org claim, `aud`, DCR + CIMD, refresh rotation and replay, TTL, revocation, JWKS rotation)     | Written go/no-go in TECH.md                                                                      |
| 1         | Eager 401 + PRM on `/mcp`; remove the `key` tool argument; Bearer API key keeps working                           | Claude Code shows an auth prompt instead of a false "Connected"                                  |
| 2         | AS + consent page with org picker and balances; JWT verify in the Worker; org → wallet                            | Claude Code and ChatGPT connect end to end; calls meter against the chosen org                   |
| 3         | Grant management UI (list, revoke, move org); replay revocation; immediate membership-loss revocation at the edge | Tests for replay, move, revoke and revocation latency                                            |
| 4         | Publisher upstream `oauth2_client_credentials` with off-path, serialized refresh                                  | Publisher connection test passes against an OAuth upstream; gateway never sees the client secret |
| 5 (later) | Consumer-connected accounts + 428 remediation                                                                     | Only with a real publisher demand                                                                |

Doc updates when built: TECH.md (auth architecture and gateway hot path), FLOW.md (consent screen,
grant management), PRODUCT.md (click-to-connect for agents).
