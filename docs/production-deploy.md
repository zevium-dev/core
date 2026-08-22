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

Cloudflare Worker runtime secrets remain configured in Cloudflare. Convex
runtime secrets remain configured in Convex. Deployment does not copy runtime
secrets through artifacts or logs.

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
without changing their preconfigured routes. Tags use `production-<git-sha>`,
and gateway `ZEVIUM_RELEASE` plus web metadata expose the same exact SHA.

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
