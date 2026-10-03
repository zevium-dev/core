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

## Initial Registry Migration

Legacy published projects require the existing initial rollout to reserve
their permanent public routes. A rendered empty catalogue is not proof that
this migration completed. After backing up Convex and configuring the
transport keyring, an authenticated production operator runs:

```bash
pnpm exec convex run registryRollout:startOrResume '{}' --prod
pnpm exec convex run registryRollout:get '{}' --prod
```

If credential rows still contain legacy plaintext, first run the bounded
security audit through internal `securityRollout:startAuditOperator` and
`securityRollout:auditPageOperator`. Require a completed zero-corruption audit
for the current generation, then pass its `auditId` to the internal
`upstreamCredentials:migrateLegacyPlaintext` and
`webhooks:migrateLegacyPlaintext` pages. Run a fresh complete audit afterward;
require zero old, plaintext, corrupt, and broken rows. These operator entry
points require deployment credentials and grant no user an application role.
Keep the backup and both encryption key versions for rollback compatibility.
Legacy API keys whose one-time secret hash cannot be recovered are disabled
by the existing registry rollout and need replacement; never invent a hash.

The scheduled bounded job must report `status: "complete"` with matching
production and verification counts/digests. If interrupted, resume the same
job; do not remove its source receipts. Verify an existing published project
through public catalogue/detail reads and compare its immutable spec and
original wallet/earning records against the backup.

This restores the current Convex-backed public read path. The registry-v2
edge receiver remains pending as documented in `TECH.md`; rollout completion
does not claim delivery acknowledgements or change the gateway to that path.

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
