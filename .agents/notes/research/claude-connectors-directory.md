# Research: Claude Connectors Directory submission (#324)

> 2026-10-17, updated same day after owner decisions. Status: **research; submission deferred** ([decision](../decisions/2026-10-17-connectors-directory-deferred.md)). These are inputs to decisions, not decisions. Sources were checked on
> 2026-10-17. The submission portal requires a login, so its exact compliance wording is unverified.
> Related: [agent-surface](../features/agent-surface.md), [mcp-oauth](mcp-oauth.md),
> [landscape](agent-api-marketplace-landscape.md)

## Summary

Zevium is **not ready to submit**. Anthropic's rules don't ban paid or credit-gated connectors. Two rules
still need answers before we submit:

1. **Money-transfer exclusion (Policy 4A).** It is ambiguous for a wallet that is drawn down per call.
2. **First-party / proxy rule (Policy 3F).** It needs a "proxied with permission" story.

Built 2026-10-17 (#324): tool annotations; the catch-all `call_api` split into `call_api_read` and
`call_api_write`; no `key` tool argument; first OAuth connect auto-creates a key. The other remaining
blockers belong to the owner:

- Activate OAuth.
- Publish a privacy policy, terms and support contact.
- Set up a reviewer test account.

## Sources

- [Anthropic Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy) (dated 2026-04-15)
- [Software Directory Terms](https://support.claude.com/en/articles/13145338-anthropic-software-directory-terms)
- [Submission guide](https://claude.com/docs/connectors/building/submission)
- [Review criteria](https://claude.com/docs/connectors/building/review-criteria)
- [Authentication](https://claude.com/docs/connectors/building/authentication)
- [Building / limits](https://claude.com/docs/connectors/building/index)
- Older support article 11503834, the only source for the `claude.com` callback

## Policy answers

### Are paid or credit-gated connectors allowed?

**Yes, as far as the published rules go.** Neither the Policy nor the Terms prohibit paid, usage-billed or
credit-gated tools, and neither has a fee or monetization clause.

Two exclusions still matter.

**4A, money transfer.** Policy 4A excludes software that "transfers money, cryptocurrency, or other financial
assets, or executes financial transactions on behalf of users", "unless otherwise expressly permitted by us in
writing". The portal's Compliance step includes a "financial transactions" acknowledgment.

- Our reading: a `call_api_read`/`call_api_write` call that consumes prepaid service credits is a charge for our own service, not a
  transfer on the user's behalf.
- No Zevium tool tops up, pays out or moves money. Keep it that way.
- x402 wallet sessions would clearly trip the crypto clause. x402 is off ([decision](../decisions/2026-10-11-x402-disabled.md)),
  and it must not be added to the directory server.
- Ambiguity remains. Get written confirmation from `mcp-review@anthropic.com` before submitting.

**4C, advertising.** Policy 4C excludes "advertisements, sponsored content, paid product placements". Paid
ranking or promoted listings in `search_apis` would break it. None exist today.

### Ownership of proxied APIs (Policy 3F)

Policy 3F requires developers to "own or control any API endpoint" their software connects to. The review
criteria add: "Your server must call your own first-party APIs, or APIs you legitimately proxy." The Data
handling step asks whether the API is first-party, "proxied from a partner with permission", or a third
party's that you don't control.

- **Answer:** proxied with permission. Every callable listing was published by its owner, who accepted the
  publisher terms. The `/mcp` domain is Zevium's.
- **Risk:** house or resold listings, and any listing not published by the API owner, weaken that answer.
  See [house-listing-resale-terms](house-listing-resale-terms.md).

### Tool annotations

Annotations are **mandatory**: "every tool includes a `title` and the applicable `readOnlyHint` or
`destructiveHint`" (Policy 5E). `openWorldHint` and `idempotentHint` are not mentioned. We set them anyway,
because Policy 5E says "all applicable".

Tool names may have at most 64 characters. Descriptions must "precisely match actual functionality". They must
not steer the model toward other tools, pull instructions from outside sources, or promote anything.

**Catch-all rule.** The rule says: "A single tool that accepts both safe ... and unsafe methods ... is rejected.
Don't ship a catch-all `api_request` tool with a `method` parameter." The old `call_api` was exactly that.
**Decided 2026-10-17: option (a)**, with `call_api_read` marked `readOnlyHint: true`
([decision](../decisions/2026-10-17-mcp-call-api-read-write-split.md)). Options considered:

- **(a) Split into two tools.** `call_api_read` accepts GET/HEAD only. `call_api_write` takes the other methods
  and is marked destructive. Research suggested `readOnlyHint` false for the read tool because it spends
  credits; the owner chose `true` (no upstream state change).
  - Built: the generated binding (#428) names `call.tool`, generator major 2, CLI supports major 2.
  - Recommended and chosen: it is the smallest change that matches the rule's wording.
- **(b) Per-listing tools.** One tool per operation (#110). This is a bigger change.
- **(c) Ask for an exception.** Ask `mcp-review@anthropic.com` whether a marketplace proxy is exempt. This is
  unlikely to succeed given how explicit the rule is.

### OAuth

Clerk is the authorization server and the gateway is the resource server ([mcp-oauth](mcp-oauth.md)).

| Requirement                                                                                                                                                                               | Zevium state                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| OAuth 2.0 with publicly trusted TLS (5D)                                                                                                                                                  | Clerk + Cloudflare TLS                                                                                            |
| Auth type `oauth_dcr` or `oauth_cimd`                                                                                                                                                     | Both are Clerk features; both are **off until the owner enables them**                                            |
| CIMD needs `client_id_metadata_document_supported: true` and `"none"` token auth in AS metadata                                                                                           | Check Clerk's discovery doc after enabling. Anthropic prefers CIMD over DCR at high volume                        |
| S256 PKCE, advertised in `code_challenge_methods_supported`                                                                                                                               | Clerk-owned; verify in its discovery doc                                                                          |
| 401 + `WWW-Authenticate: Bearer resource_metadata=…` on unauthenticated `/mcp`                                                                                                            | Built (`oauthChallenge`). With OAuth on, every `/mcp` request without credentials gets 401, `tools/list` included |
| RFC 9728 PRM `resource` exactly matches the server URL; first `authorization_servers` entry used                                                                                          | Built; config forces `https://…/mcp` and exposes exactly one issuer                                               |
| Redirect URIs: `https://claude.ai/api/mcp/auth_callback`; `https://claude.com/api/mcp/auth_callback` (allowlist both); Claude Code uses loopback on any port, `localhost` and `127.0.0.1` | Clerk client/redirect policy; owner config                                                                        |
| Refresh on 401 and before expiry; `invalid_grant` for a dead refresh token; rotate refresh tokens for public clients                                                                      | Clerk-owned; rotation and replay revocation unverified ([mcp-oauth](mcp-oauth.md) G8)                             |
| `/token` accepts form encoding; 10 s for discovery/registration/token, 30 s for refresh                                                                                                   | Clerk-owned                                                                                                       |
| Anthropic egress `160.79.104.0/21` must not be blocked, and a 429 from the WAF breaks connect                                                                                             | Check Cloudflare WAF and rate rules on the gateway origin                                                         |
| Protocol 2025-03-26 / 2025-06-18 / 2025-11-25; Streamable HTTP (5F)                                                                                                                       | All supported; stateless Streamable HTTP, no SSE                                                                  |

Dead-token loops: G2 fixed 2026-10-17. A user with no API key gets an authenticated session, and the first
connect auto-creates their key ([decision](../decisions/2026-10-17-mcp-auto-created-key.md)); calls say
"retry in ~15 s" meanwhile. If creation is not permitted, or the user revoked that key, the execute tools
explain and link `/app/settings/keys` instead of a dead `invalid_token`. Reviewer test account still needs credits.

### Privacy, support, docs

| Requirement                                                                                        | Zevium state                                                                                                  |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Privacy policy URL covering collection, use and retention (3A; the portal asks remote servers too) | **Missing.** No privacy route in `apps/web`. Owner/legal must write it                                        |
| Verified support contact and channels (3B)                                                         | **Missing.** No support email or page                                                                         |
| Terms of service                                                                                   | **Missing.** Not strictly listed for the directory, but needed for consumers and ties into #315               |
| Public docs by the publish date                                                                    | `/docs/agents` exists (MCP config, tools, discovery)                                                          |
| At least 3 working example prompts or use cases (3E)                                               | Draft below                                                                                                   |
| Reviewer test account "with sample data" (3D)                                                      | **Owner.** Needs a Clerk user + org with a current key, a funded wallet, and at least one live priced listing |
| Paid Claude plan to submit                                                                         | Owner                                                                                                         |

### Other limits

- **Result size.** claude.ai and Desktop allow about 150,000 characters per result; Claude Code allows 25k
  tokens. The MCP adapter buffers up to 1 MiB, so a large upstream body passes our cap but can be truncated
  or rejected by Claude.
  - Policy 5B wants "roughly commensurate" output.
  - Consider capping `call_api_read`/`call_api_write` and `get_api_docs` results nearer 150k characters for directory traffic.
- **Tool time.** The limit is 240 s per call; our 10 s execution timeout is well within it.
- **Errors (5A).** Messages must be helpful; a generic "Internal Server Error" fails review. Tool errors already
  return reason and recovery (#396). The generic "Tool execution failed. Please try again." path is a
  candidate for review feedback.
- **Data (1D, 1F).** Collect no extra conversation data. We store none.
- **Secrets in context.** Removed 2026-10-17: no tool takes a `key` argument, and a call that passes one is
  refused ([decision](../decisions/2026-10-17-mcp-no-key-argument.md); [mcp-oauth](mcp-oauth.md) G3).
- **Review tiers.** Listings get the Community label by default; Anthropic may escalate to Verified, which
  runs functional tests of every tool.

## Code state (2026-10-17)

- `apps/gateway/src/mcp.ts`: every tool has a top-level `title` and an `annotations` block with `title`,
  `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`.
  - `search_apis` and `get_api_docs`: read-only, idempotent, closed-world.
  - `call_api_read` (GET/HEAD): read-only, not destructive. `call_api_write` (other methods): destructive.
    Both not idempotent (each call bills) and open-world. Method enums per tool; each refuses the other's
    methods.
  - No `key` property in any schema; a passed `key` is refused.
  - Tests: `apps/gateway/test/discovery-mcp.test.ts` ("tools/list annotates every tool for directory review",
    "tools/list returns four tools"), `apps/gateway/test/mcp-oauth.test.ts` (key/method refusal, provisioning).
- First-connect key auto-creation: `convex/mcpKeys{,Node}.ts`, `tests/mcpKeys.test.ts`.
- Not changed: result cap.

## Submission checklist

- [x] Every tool has `title` + `readOnlyHint` / `destructiveHint`
- [x] Split `call_api` into `call_api_read` / `call_api_write` (option a), 2026-10-17
- [ ] Email `mcp-review@anthropic.com`: confirm per-call credit metering is acceptable under 4A, and the 3F
      "proxied with permission" answer
- [ ] Activate OAuth: enable Clerk DCR (and CIMD if offered), S256, scopes, and redirects for
      `claude.ai` / `claude.com` callbacks plus loopback. Set the Worker issuer/resource
      ([convex-activation](../architecture/convex-activation.md))
- [ ] Live acceptance: add `/mcp` as a custom connector in claude.ai with a keyless user, complete connect,
      confirm the auto-created key, refresh, `call_api_read` and `call_api_write`; run every tool in MCP Inspector
- [x] Fix G2 (clear error instead of a dead `invalid_token`), 2026-10-17
- [x] Drop the `key` tool argument, 2026-10-17
- [x] Auto-create the member's key on first OAuth connect, 2026-10-17
- [ ] Allow `160.79.104.0/21` in WAF and rate rules
- [ ] Publish a privacy policy (collection, use, retention), terms, and a support email or page. **Owner/legal**
- [ ] Reviewer test account: user + org, funded credits (the key auto-creates on connect), at least 1 priced
      live listing with a GET and a write operation, at least 1 free (`0`) operation
- [ ] Icon, company details, primary contact, paid Claude plan
- [ ] Optional: cap result size near 150k characters

## Draft submission answers

- **Name:** Zevium
- **One-liner (≤200):** Find and call paid APIs from Claude, with per-call prices shown up front and prepaid
  credits that can't overspend.
- **Description (≤2,000):** Zevium is an API marketplace built for agents. Claude can search the catalogue,
  read the docs and per-endpoint prices for an API, and call it through Zevium's metered gateway. Calls are
  paid from your organization's prepaid credits. When the balance hits zero, calls stop, so there are no
  surprise overages. A call is charged only when it fully succeeds. Publishers list their own APIs from an
  OpenAPI spec, and that spec sets the price.
- **Categories:** Developer tools; Data. Confirm against the portal's list.
- **Connection URL:** `https://<gateway-host>/mcp` (single URL)
- **Auth type:** `oauth_dcr`, or `oauth_cimd` once Clerk advertises it
- **Reads or writes:** both. Search, docs and `call_api_read` (GET/HEAD) are read-only; `call_api_write` may
  write to the third-party API. Both call tools spend credits.
- **Prerequisites:** a Zevium account and an organization with purchased credits. The first connect creates
  the member's API key if they have none.
- **Example prompts:**
  1. "Find an API that geocodes street addresses and tell me what one call costs."
  2. "Show me the parameters and price for the `<publisher>/<api>` search endpoint."
  3. "Use `<publisher>/<api>` to look up `<query>` and summarize the result."
- **API ownership:** proxied with permission. Each publisher lists its own API and accepts Zevium's publisher
  terms.
- **Health data:** no. **Sponsored content:** no.
- **Privacy policy URL / support contact / docs URL:** `<missing>` / `<missing>` / `https://<site>/docs/agents`

## Unverified

- The exact wording of the portal's seven compliance acknowledgments (behind login).
- Whether 4A is applied differently to Community and Verified listings.
- That the `claude.com` callback is in use. Allowlist it anyway.
- Rate-limit or uptime requirements. Only an older best-practices article mentions 99% uptime and under 1 s
  responses.
