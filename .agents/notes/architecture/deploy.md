# Production Deployment

Production uses one path: green `develop` CI, one GitHub `production`
environment approval, then one ordered deployment job.

## Trigger

`.github/workflows/deploy-production.yml` runs after the `Continuous
Integration` workflow succeeds for a push to `develop`.

The deployment job:

1. Checks out the exact CI SHA.
2. Confirms the source run was successful `develop` CI.
3. Confirms the SHA is still current `develop`.
4. Waits for approval on the protected `production` environment.
5. Builds the web Worker before mutating providers.
6. Proves the Convex production target with `convex deploy --dry-run`.
7. Deploys Convex, gateway, then web.
8. Verifies gateway `/health`, web release metadata, catalogue rendering, and
   the stable gateway `404` response.

Concurrency group `production-release` serializes releases and never cancels a
running deployment.

## Configuration

The GitHub `production` environment owns these secrets:

- `CLOUDFLARE_API_TOKEN`
- `CONVEX_PRODUCTION_DEPLOY_KEY`
- `CLERK_PRODUCTION_PUBLISHABLE_KEY`
- `CLERK_PRODUCTION_SECRET_KEY`
- `PRODUCTION_REGISTRY_TRANSPORT_KEYRING`: JSON keyring with a current key ID
  and independently generated 32-byte hexadecimal transport keys. Retain old
  entries when rotating; stored registry envelopes still refer to them.
- `PRODUCTION_REGISTRY_KEY_PROJECTION_HMAC_SECRET`: independently generated
  secret of at least 32 characters, shared by web and Convex key registration.
- `PRODUCTION_UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS`: credential keyring with
  canonical padded base64 keys encoding 32 bytes. Retain previous versions
  through the migration and rollback window.

The workflow validates the registry and credential secrets before provider writes,
then configures both keyrings and the registration secret in Convex. The same
registration secret is included additively in the tagged web Worker upload.
Its temporary runner file has mode `0600`, is removed even on failure, and
never enters deployment artifacts. Other runtime secrets remain configured
in Cloudflare or Convex. Secrets never enter logs or artifacts.

No release API key, release-probe variables, referee SHA, policy-tree digest,
or separate contract/lifecycle/recovery environment is required.

## Ordering

Convex deploys first because gateway and web may depend on expanded control
plane behavior. Schema changes must therefore be backward-compatible with the
currently deployed Workers.

Gateway deploys second. Wrangler applies append-only Durable Object migrations
from `apps/gateway/wrangler.jsonc`; never edit or reuse an existing migration
tag.

Web deploys last. Both Workers upload tagged versions and promote them to 100%
without changing their preconfigured routes. Tags use
`production-<git-sha>-<run-id>-<attempt>` so retry uploads have unique tags,
and gateway `ZEVIUM_RELEASE` plus web metadata expose the same exact SHA.

## Fresh Convex deployments

Finance, registry, and security migration/rollout operators were deleted in
#354. This schema targets fresh deployments; disposable development data may
need resetting when removed fields no longer validate. No migration audit or
rollout command gates runtime writes.

Normal publish/enqueue operations reserve permanent public routes. The
registry outbox and key identity proof remain until #353; the registry-v2
receiver is still pending as documented in [registry-v2.md](registry-v2.md).

## Failure Handling

Default recovery is roll forward:

1. Read the failed GitHub step and provider output.
2. Fix the defect in a new PR.
3. Merge after CI and preview checks pass.
4. Approve the new production run.

Do not roll back Convex schema or shared Durable Object migrations. Cloudflare
version history is manual break-glass only when the prior Worker is known to be
compatible with current Convex and Durable Object state.

If failure occurs before `Deploy Convex`, production is unchanged. If failure
occurs later, assume partial deployment and roll forward immediately.

## Verification

Successful workflow evidence is retained for seven days. Independent checks:

```bash
curl --fail --silent https://gateway.zevium.dev/health
curl --fail --silent https://www.zevium.dev/
curl --fail --silent 'https://www.zevium.dev/catalogue?q=&sort=newest'
```

Gateway health must report `ok: true`, service `zevium-gateway`, contract `1`,
and current `develop` SHA. Web HTML must contain matching `zevium-release`
metadata.

The workflow waits for both services to report the expected release before
checking their contracts; a healthy response from the previous version does not
complete verification.

## Pipeline notes (moved from former TECH.md)

- **Preview verification**: previews are opt-in: adding the `preview` label to a trusted PR deploys isolated Convex, gateway, and web previews and runs required curl-only checks for web `/`, web `/catalogue`, gateway `/health`, gateway CORS preflight, and a stable gateway 404. Opening, reopening, or pushing to a PR does not deploy; remove and re-add `preview` to rebuild after a push, or run **Pull Request Preview** manually with its PR number. After Convex provisioning, gateway deploy and web build run in parallel; web deployment and gateway deployment converge with the exact compliance scan at the smoke job through explicit job outputs/artifacts. Only the smoke job creates a GitHub deployment record, with the web preview URL; other preview and cleanup jobs retain environment secrets with `deployment: false`. The browser runtime and authenticated publisher/consumer journey are opt-in because they are long and stateful: add `full-e2e` to a PR already labeled `preview`, include both labels when requesting a preview, or run the workflow manually. Publisher and consumer remain sequential because consumer verification reads the publisher-created project artifact. Closed PRs invoke the separate preview cleanup workflow.
- **Production releases**: one workflow deploys the exact SHA from a successful `Continuous Integration` push on `develop`. GitHub's protected `production` environment is the human approval and provider-credential boundary. The job rechecks current `develop` before every mutation, builds first, proves the Convex target with `convex deploy --dry-run`, deploys Convex, gateway, then web, and waits for both services to report the exact release before verifying public route contracts. Protected registry secrets supply the Convex transport keyring and matching web/Convex key-registration HMAC; malformed keyrings or weak secrets stop before provider writes. Web secrets accompany the tagged upload through a private temporary file removed even on failure, never an artifact. Worker tags are `production-<sha>-<run-id>-<attempt>` so retry uploads remain unambiguous; Durable Object migrations remain append-only. Failures stop and roll forward with a reviewed commit. Convex and shared DO state never roll back; Cloudflare version rollback is manual break-glass for known Worker-only failures. Operator protocol and credential inventory live in this file.
