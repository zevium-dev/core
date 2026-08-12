# Cloudflare deployment broker

`apps/deploy-broker` removes account-wide Cloudflare credentials from GitHub. For Cloudflare access, GitHub jobs receive only a five-minute GitHub OIDC JWT. Broker holds one scoped Cloudflare API token as encrypted Worker secret and converts signed, source-verified manifests into narrow Durable Object sessions.

## Trust and request flow

1. Reusable deployment workflow builds a canonical manifest from immutable GitHub runner values. Manifest fixes environment, PR/source CI, head and runner SHA, exact target name, bindings, migration, secret names plus SHA-256 value digests, asset mode, version tag, and operations. Secret values never enter manifest.
2. Registration helper hashes canonical manifest, including exact Worker module and static-asset bytes, and asks GitHub's runner OIDC endpoint for audience `urn:zevium:cloudflare-deploy:v2:<sha256>`.
3. Broker fetches GitHub's rotating JWKS, caches it for one hour during live registration, allows only `RS256`, verifies signature, then enforces exact `iss`, `aud`, `exp`, `nbf`, `iat`, `jti`, repository/owner/actor numeric IDs, visibility, environment, event, ref, SHA, run ID/attempt, caller `workflow_ref`, reusable `job_workflow_ref`, and both workflow SHAs. Remote dry-run bypasses every Durable Object write and all Cache API/JWKS state. Read-only GitHub API check on 2026-08-12 confirmed this pre-July-2026 repository uses default mutable-name subject format (`use_default=true`, `use_immutable_subject=false`), so exact subject is `repo:zevium-dev/core:environment:<environment>`; any OIDC subject-policy change requires reviewed broker policy update.
4. Broker independently reads public GitHub API provenance. Preview requires same-repository PR against `develop`, exact head/merge SHAs, state, and head/base refs. Production requires named successful `Continuous Integration` push run on `develop`, exact source run and head SHA. Redirects fail closed.
5. Live registration creates a Durable Object session keyed by `sha256(jti + NUL + manifestDigest)`. Every request re-verifies same JWT and JTI binding. Session expires with JWT. Mutations are one-shot; request and registration rates are bounded.
6. Repo-owned publisher sends exact Cloudflare API requests. Broker validates raw canonical account path/query before URL normalization, rejects percent/backslash/dot traversal, validates strict duplicate-free JSON and streaming multipart metadata, then replaces GitHub JWT with broker token. Version multipart must contain complete explicit plain-text, Durable Object, and secret bindings; inheritance fields and undeclared bindings are rejected. Static-asset path, size, SHA-256, Cloudflare hash, and MIME type are signed. Cloudflare asset JWTs are accepted only after hashing and binding them to broker-created asset state.
7. Successful version upload does not authorize traffic. Broker validates signed tag on outbound metadata, captures UUID returned by that exact upload, then reads immutable version state directly from Cloudflare and proves same UUID, compatibility settings, script etag, and closed binding names/types before sealing it in session storage. Secret values were already proven from multipart bytes against signed digests; Cloudflare does not expose them on readback. Deployment accepts only sealed UUID, repeats version readback immediately before mutation, then proves active deployment is one version at 100%. Gateway activation additionally proves signed Durable Object migration tag.
8. Upstream redirects fail closed. Normal responses stream. Broker forwards only `content-type`, `etag`, and `retry-after`; cookies, auth challenges, locations, Cloudflare control headers, and hop-by-hop headers die. Audit records contain decision metadata, never request bodies, OIDC JWTs, asset JWTs, Cloudflare token, or secret values.

GitHub OIDC has `sha`, not `head_sha`. Broker therefore binds `sha` as `oidcSha`, binds desired source revision separately as manifest `headSha`, and proves latter through GitHub PR or workflow-run API. This avoids `workflow_run` default-branch SHA ambiguity and PR merge-ref ambiguity.

## Allowed Cloudflare surface

Account is compiled to `1ea9299555b026a6a7484c8323c5a953`. Script names are one of signed profile targets. `zevium-deploy-broker` and test broker name are always forbidden.

| Method   | Endpoint                                         | Purpose                                                          |
| -------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `GET`    | `/workers/services/:script`                      | Gateway Durable Object lifecycle state only                      |
| `POST`   | `/workers/scripts/:script/versions`              | Closed, explicit-binding version multipart                       |
| `POST`   | `/workers/scripts/:script/deployments`           | Sealed UUID as sole version at 100% traffic                      |
| `POST`   | `/workers/scripts/:script/subdomain`             | Preview-only exact `enabled=true`, `previews_enabled=true`       |
| `DELETE` | `/workers/scripts/:script`                       | Closed-preview cleanup only                                      |
| `POST`   | `/workers/scripts/:script/assets-upload-session` | Signed web target asset manifest                                 |
| `POST`   | `/workers/assets/upload?base64=true`             | Session-bound bulk assets with signed bytes, length, and MIME    |
| `POST`   | `/workers/assets/upload/:hash`                   | Session-bound exact-length single asset with signed content type |

All paths above are under `/client/v4/accounts/<fixed-account-id>`. Broker-owned post-write verification calls Cloudflare directly and cannot be selected by client. No account/script inventory, secret mutation, version discovery, routes, custom domains, DNS, KV/R2/D1, account settings, user/token endpoints, service names outside manifest, multiple traffic versions, force deployments, binding inheritance, or `script-settings` PATCH exist in client policy.

| Signed profile       | GitHub environment | Exact target(s)                                | Lifecycle capability                                         |
| -------------------- | ------------------ | ---------------------------------------------- | ------------------------------------------------------------ |
| `preview-gateway`    | `preview`          | `zevium-gateway-pr-<PR>`                       | version, 100% deploy, two signed secrets                     |
| `preview-web`        | `preview`          | `zevium-web-pr-<PR>`                           | assets, version, 100% deploy, signed secret                  |
| `preview-cleanup`    | `preview`          | `zevium-gateway-pr-<PR>`, `zevium-web-pr-<PR>` | delete only after PR closes                                  |
| `production-gateway` | `production`       | `zevium-gateway`                               | version, 100% deploy, two signed secrets, `WalletDO` v1 only |
| `production-web`     | `production`       | `zevium-dev`                                   | assets, version, 100% deploy, signed secret                  |

Repo has no separate Cloudflare staging Worker. PR-isolated `preview` environment is nonproduction staging/contract lane; production lane remains successful `develop` CI only.

### Exact publisher protocol and Wrangler regression evidence

`scripts/publish.ts` is sole client for mutating version publication. Gateway first reads exact service lifecycle state. Web initializes asset session, uploads only provider-requested signed hashes using signed MIME types, and requires a completion JWT. Both profiles upload multipart with metadata first, exact module bytes, complete explicit bindings, no query, no `keep_bindings`, and no `keep_assets`; deployment then uses returned sealed UUID directly. Preview workers.dev settings are written last with exact booleans.

Actual publisher tests execute both gateway and web clients against byte-inspecting mocked HTTP and compare full call sequences with `transcripts/exact-api-v1-{gateway,web}.json`. They decode multipart, prove module and asset bytes, MIME, secret closure, migration behavior, asset JWT, exact UUID activation, and absence of inheritance fields. Integration tests run same policy in workerd/Miniflare and prove unsealed/wrong IDs, provider-state drift, replay, forged secrets, and dry-run writes fail closed.

Pinned Wrangler 4.119.0 remains only for gateway `--dry-run` bundling. Source and recorded negative fixtures prove its mutating `versions upload` forces `keep_bindings: ["secret_text", "secret_key"]` even with a secrets file, and its deploy flow performs broad discovery reads. Broker rejects that transcript. `wrangler versions upload`, `wrangler versions deploy`, `wrangler secret put`, and `wrangler deploy` are forbidden publication paths.

Gateway metadata is locked to `index.js`, `CONVEX_URL`, `CONVEX_SITE_URL`, `WALLET` → `WalletDO`, compatibility date/flags, exact `workers/tag`, and exactly `{CLERK_SECRET_KEY, GATEWAY_INTERNAL_SECRET}`. Exact target-service state determines whether declared `v1` `new_sqlite_classes` initialization is required; existing state must already equal `v1`. Web is locked to built compatibility settings, exactly `{CLERK_SECRET_KEY}`, no migrations, and broker-issued asset completion JWT.

Provider inventory on 2026-08-12 found 19 inherited legacy secrets on production web active version `ddc4f56c`. Raw exact upload sends only `CLERK_SECRET_KEY`; broker refuses to seal or activate candidate if Cloudflare readback exposes any extra binding. Keep previous version ID as recoverable rollback pointer until exact paid-call/accounting proof passes. Never delete secrets directly as cleanup.

`.github/workflows/deploy-production.yml` and `cloudflare-production.yml` are deliberately non-mutating preflights. They prove current `develop`, exact successful source CI, signed module/static-asset inventory, and exact secret digests through broker's remote dry-run. Convex deploy, Cloudflare upload, traffic activation, and production verification belong only to protected release protocol, where active-release state, protected attestations, and exact paid-call/accounting proof are enforced as one transaction boundary.

Production environment must provide `CLERK_PRODUCTION_SECRET_KEY` and `GATEWAY_PRODUCTION_INTERNAL_SECRET`; workflow maps them to exact runtime binding names before manifest construction. Missing either blocks gateway authorization. As of 2026-08-12, repository environment inventory lacks `GATEWAY_PRODUCTION_INTERNAL_SECRET`, so production gateway release remains deliberately fail-closed until operator provisions it through GitHub's protected environment controls.

## Cloudflare token

Create account token with only:

- Account → Workers Scripts → Write

No Account Settings or Workers Routes permission is needed during normal operation. One-time broker custom-domain bootstrap needs Zone → Workers Routes → Write for `zevium.dev`; remove it from steady-state token afterward. Do not copy the broad "Edit Cloudflare Workers" template's KV, R2, or Tail permissions. Token must target one Zevium account and one zone where applicable. Broker policy still limits token use to exact endpoints above.

## Bootstrap

Bootstrap is only provider mutation requiring human-reviewed local credential:

1. Review branch, built bundle, `wrangler.jsonc`, manifest policies, tests, and token scope.
2. On trusted local workstation, export scoped token in shell. Never save it in repo, `.dev.vars`, GitHub, ticket, or command history.
3. Deploy broker once from local checkout: `pnpm --filter @zevium/deploy-broker exec wrangler deploy`.
4. Store token into deployed broker: `printf '%s' "$TOKEN" | pnpm --filter @zevium/deploy-broker exec wrangler secret put CLOUDFLARE_BROKER_API_TOKEN`.
5. Clear shell value. Verify `https://deploy-broker.zevium.dev/health` returns 200.
6. Remove legacy `CLOUDFLARE_API_TOKEN` GitHub secret. Workflows contain no `${{ secrets.CLOUDFLARE_API_TOKEN }}` reference.

This repo does not automate bootstrap because broker cannot safely create/update itself and GitHub must never receive token.

## Rotation

1. Create replacement scoped token locally; retain old token.
2. Review token restrictions and broker health.
3. Replace only broker secret with local `wrangler secret put` command above.
4. Run remote manifest dry-run from trusted workflow, then normal preview deployment.
5. Revoke old token after successful preview. If health works but deployment fails, restore old token locally and investigate audit logs.

GitHub changes: none. Token is never copied there.

## Recovery

Broker deliberately cannot deploy, delete, version, route, secret-update, or otherwise modify itself. If broker code, route, Durable Object migration, or credential breaks:

1. Stop deploy workflows or rely on fail-closed errors.
2. Review exact known-good commit and local dry-run/build/test results.
3. Use human-held emergency token locally for one broker-only deploy/secret repair.
4. Re-run health, remote dry-run, and preview.
5. Rotate emergency token after incident and record metadata without token/body.

Never temporarily restore Cloudflare token to GitHub. Never widen broker target policy to repair broker.

## Local verification

```bash
pnpm --filter @zevium/deploy-broker test
pnpm --filter @zevium/deploy-broker typecheck
pnpm --filter @zevium/deploy-broker build

GITHUB_EVENT_NAME=workflow_run \
GITHUB_REF=refs/heads/develop \
GITHUB_SHA=<caller-sha> \
GITHUB_RUN_ID=1 GITHUB_RUN_ATTEMPT=1 \
DEPLOY_HEAD_SHA=<source-ci-sha> SOURCE_RUN_ID=1 \
pnpm --filter @zevium/deploy-broker manifest:dry-run
```

Unit suite covers forged claims/signatures, canonical manifests, path/query/encoding/traversal, body schemas, multipart chunk boundaries, exact publisher transcripts, assets, migrations, secrets, sealing, traffic, and rejected Wrangler transcripts. Integration suite runs in workerd/Miniflare with real Durable Object storage and checks auth substitution, provider readback, replay, cross-environment tokens, storage-free dry-runs, rate limits, and forbidden paths.

## Sources checked 2026-08-12

- [GitHub Actions OIDC reference](https://docs.github.com/en/actions/reference/security/oidc) — issuer, claims, reusable `job_workflow_ref`, audience retrieval
- [GitHub OIDC discovery](https://token.actions.githubusercontent.com/.well-known/openid-configuration) and [JWKS](https://token.actions.githubusercontent.com/.well-known/jwks) — rotating `RS256` keys and key IDs
- [Cloudflare Wrangler system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) — `CLOUDFLARE_API_BASE_URL`, account and token inputs
- [Cloudflare Workers API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/) — script/version/deployment/secret endpoints
- [Cloudflare Workers direct upload](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/) and [static asset direct upload](https://developers.cloudflare.com/workers/static-assets/direct-upload/) — multipart metadata and asset-session flow
- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) — Workers Scripts and account read scopes
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) — request URL/header/body, CPU, memory, and Worker size limits
