# Cloudflare deployment broker

`apps/deploy-broker` removes account-wide Cloudflare credentials from GitHub. For Cloudflare access, GitHub jobs receive only a five-minute GitHub OIDC JWT. Broker holds one scoped Cloudflare API token as encrypted Worker secret and converts signed, source-verified manifests into narrow Durable Object sessions.

## Trust and request flow

1. Reusable deployment workflow builds a canonical manifest from immutable GitHub runner values. Manifest fixes environment, PR/source CI, head and runner SHA, exact target name, bindings, migration, secret names plus SHA-256 value digests, asset mode, version tag, and operations. Secret values never enter manifest.
2. Registration helper hashes canonical manifest, including exact Worker module and static-asset bytes, and asks GitHub's runner OIDC endpoint for audience `urn:zevium:cloudflare-deploy:v2:<sha256>`.
3. Broker fetches GitHub's rotating JWKS, caches it for one hour, allows only `RS256`, verifies signature, then enforces exact `iss`, `aud`, `exp`, `nbf`, `iat`, `jti`, repository/owner/actor numeric IDs, visibility, environment, event, ref, SHA, run ID/attempt, caller `workflow_ref`, reusable `job_workflow_ref`, and both workflow SHAs. Read-only GitHub API check on 2026-08-12 confirmed this pre-July-2026 repository uses default mutable-name subject format (`use_default=true`, `use_immutable_subject=false`), so exact subject is `repo:zevium-dev/core:environment:<environment>`; any OIDC subject-policy change requires reviewed broker policy update.
4. Broker independently reads public GitHub API provenance. Preview requires same-repository PR against `develop`, exact head/merge SHAs, state, and head/base refs. Production requires named successful `Continuous Integration` push run on `develop`, exact source run and head SHA. Redirects fail closed.
5. Registration creates a Durable Object session keyed by `sha256(jti + NUL + manifestDigest)`. Every request re-verifies same JWT and JTI binding. Session expires with JWT. Mutations are one-shot; request and registration rates are bounded.
6. Broker validates raw canonical account path/query before URL normalization, rejects percent/backslash/dot traversal, validates strict duplicate-free JSON and streaming multipart metadata, then replaces GitHub JWT with broker token. Cloudflare asset-upload JWT is preserved only after it is hashed and bound to broker-created asset session.
7. Upstream redirects fail closed. Normal responses stream. Broker forwards only `content-type`, `etag`, and `retry-after`; cookies, auth challenges, locations, Cloudflare control headers, and hop-by-hop headers die. Audit records contain decision metadata, never request bodies, OIDC JWTs, asset JWTs, Cloudflare token, or secret values.

GitHub OIDC has `sha`, not `head_sha`. Broker therefore binds `sha` as `oidcSha`, binds desired source revision separately as manifest `headSha`, and proves latter through GitHub PR or workflow-run API. This avoids `workflow_run` default-branch SHA ambiguity and PR merge-ref ambiguity.

## Allowed Cloudflare surface

Account is compiled to `1ea9299555b026a6a7484c8323c5a953`. Script names are one of signed profile targets. `zevium-deploy-broker` and test broker name are always forbidden.

| Method   | Endpoint                                                            | Purpose                                                           |
| -------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `GET`    | `/workers/services/:script`                                         | Wrangler pre-upload metadata                                      |
| `GET`    | `/workers/scripts`                                                  | Exact-service-probed target-only list; account list never exposed |
| `GET`    | `/workers/scripts/:script/{settings,secrets,deployments,subdomain}` | Wrangler reads                                                    |
| `GET`    | `/workers/subdomain`                                                | Account workers.dev name read                                     |
| `POST`   | `/workers/scripts/:script/versions?bindings_inherit=strict`         | Validated version multipart upload                                |
| `GET`    | `/workers/scripts/:script/versions?deployable=true`                 | Resolve exact signed version tag                                  |
| `GET`    | `/workers/scripts/:script/versions/:uuid`                           | Version read and broker deployment re-verification                |
| `POST`   | `/workers/scripts/:script/deployments`                              | One exact version at 100% traffic                                 |
| `PUT`    | `/workers/scripts/:script/secrets`                                  | Preview allowlisted secret names only                             |
| `POST`   | `/workers/scripts/:script/subdomain`                                | Exact `enabled=true`, `previews_enabled=true`                     |
| `DELETE` | `/workers/scripts/:script`                                          | Closed-preview cleanup only                                       |
| `POST`   | `/workers/scripts/:script/assets-upload-session`                    | Signed web target asset manifest                                  |
| `POST`   | `/workers/assets/upload?base64=true`                                | Session-bound bulk asset upload                                   |
| `POST`   | `/workers/assets/upload/:hash`                                      | Session-bound exact-length single asset                           |

All paths above are under `/client/v4/accounts/<fixed-account-id>`. No routes, custom domains, DNS, KV/R2/D1, account settings, user/token endpoints, service names outside manifest, multiple traffic versions, force deployments, or `script-settings` PATCH exist in policy.

| Signed profile       | GitHub environment | Exact target(s)                                | Lifecycle capability                        |
| -------------------- | ------------------ | ---------------------------------------------- | ------------------------------------------- |
| `preview-gateway`    | `preview`          | `zevium-gateway-pr-<PR>`                       | version, 100% deploy, two signed secrets    |
| `preview-web`        | `preview`          | `zevium-web-pr-<PR>`                           | assets, version, 100% deploy, signed secret |
| `preview-cleanup`    | `preview`          | `zevium-gateway-pr-<PR>`, `zevium-web-pr-<PR>` | delete only after PR closes                 |
| `production-gateway` | `production`       | `zevium-gateway`                               | version, 100% deploy, `WalletDO` v1 only    |
| `production-web`     | `production`       | `zevium-dev`                                   | assets, version, 100% deploy                |

Repo has no separate Cloudflare staging Worker. PR-isolated `preview` environment is nonproduction staging/contract lane; production lane remains successful `develop` CI only.

### Observed Wrangler 4.119.0 transcript

Hermetic recorder run of `wrangler versions upload` for gateway observed, in order:

1. `GET /workers/services/zevium-gateway`
2. `GET /workers/scripts/zevium-gateway/secrets`
3. `GET /workers/scripts`
4. `GET /workers/scripts/zevium-gateway/settings`
5. `POST /workers/scripts/zevium-gateway/versions?bindings_inherit=strict`
6. `GET /workers/scripts/zevium-gateway/subdomain`
7. `GET /workers/subdomain` when preview URLs are enabled

Recorder fixtures under `apps/deploy-broker/transcripts/` cover gateway upload and version deployment; tests assert every request stays allowed. Version deployment reads deployments, deployable versions, current version detail, posts deployment, then reads service metadata. It uses `wrangler-client.jsonc`, which intentionally has no non-versioned settings; otherwise Wrangler issues undeclared `script-settings` PATCH after deployment. Web version upload initializes/uploads static assets first. Repeated paths may share one content hash only when declared sizes match; unique asset bytes stay under signed-session limits. Preview and protected release workflows use explicit `versions upload` plus `versions deploy`; `wrangler deploy` is forbidden because its endpoint choice changes with remote Worker state and can also issue `script-settings` PATCH.

Observed gateway upload metadata is locked to `index.js`, `CONVEX_URL`, `CONVEX_SITE_URL`, `WALLET` → `WalletDO`, compatibility date/flags, exact `workers/tag`, and secret-only `keep_bindings`. Exact target-service probe tells Wrangler whether script is new: broker permits declared `v1` `new_sqlite_classes` only for initialization and permits omitted migration only as rerun no-op after remote tag is exactly `v1`. Web is locked to built compatibility settings, one manifest-digest-bound `CLERK_SECRET_KEY`, no inherited bindings, no migrations, and broker-issued asset completion JWT.

Production web's exact allowed secret set is `{CLERK_SECRET_KEY}`. Provider inventory on 2026-08-12 found 19 inherited legacy secrets on active version `ddc4f56c`; none are allowed into replacement version. Protected release workflow must upload `CLERK_SECRET_KEY` explicitly with `--secrets-file` and omit `keep_bindings`, which retires provider drift only in new version. Keep previous version ID as recoverable rollback pointer until exact paid-call/accounting proof passes. Never delete secrets directly as cleanup.

`.github/workflows/deploy-production.yml` and `cloudflare-production.yml` are deliberately non-mutating preflights. They prove current `develop`, exact successful source CI, signed module/static-asset inventory, and exact secret digests through broker's remote dry-run. Convex deploy, Cloudflare upload, traffic activation, and production verification belong only to protected release protocol, where active-release state, protected attestations, and exact paid-call/accounting proof are enforced as one transaction boundary.

## Cloudflare token

Create account token with only:

- Account → Workers Scripts → Write
- Account → Account Settings → Read, required by Wrangler's workers.dev subdomain lookup

No Workers Routes permission is needed during normal operation. One-time broker custom-domain bootstrap needs Zone → Workers Routes → Write for `zevium.dev`; remove it from steady-state token afterward. Do not copy the broad "Edit Cloudflare Workers" template's KV, R2, or Tail permissions. Token must target one Zevium account and one zone where applicable. Broker policy still limits token use to exact endpoints above.

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

Unit suite covers forged claims/signatures, canonical manifests, path/query/encoding/traversal, body schemas, multipart chunk boundaries, assets, migrations, secrets, traffic, and recorded Wrangler transcript. Integration suite runs in workerd/Miniflare with real Durable Object storage and checks auth substitution, replay, cross-environment tokens, rate limits, and forbidden paths.

## Sources checked 2026-08-12

- [GitHub Actions OIDC reference](https://docs.github.com/en/actions/reference/security/oidc) — issuer, claims, reusable `job_workflow_ref`, audience retrieval
- [GitHub OIDC discovery](https://token.actions.githubusercontent.com/.well-known/openid-configuration) and [JWKS](https://token.actions.githubusercontent.com/.well-known/jwks) — rotating `RS256` keys and key IDs
- [Cloudflare Wrangler system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) — `CLOUDFLARE_API_BASE_URL`, account and token inputs
- [Cloudflare Workers API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/) — script/version/deployment/secret endpoints
- [Cloudflare Workers direct upload](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/) and [static asset direct upload](https://developers.cloudflare.com/workers/static-assets/direct-upload/) — multipart metadata and asset-session flow
- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) — Workers Scripts and account read scopes
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) — request URL/header/body, CPU, memory, and Worker size limits
