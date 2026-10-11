# Deployment after the Convex cutover

Updated: 2026-10-11. Root `convex/` is canonical. PR 7 changes code only; shared development, preview, and production activation have **not** been performed.

**First activation requires the owner-only [Convex activation runbook](convex-activation.md).** It includes matched destinations and keyrings, Clerk/OAuth, Stripe test-mode webhook destinations, Resend, disposable-data reset, the destructive WalletSqliteDO deletion migration, deployment order, browser gates, and rollback limits. Do not run routine automation to perform that initial cutover.

## Deployment gates

Production workflow `.github/workflows/deploy-production.yml` requires repository variable `CONVEX_REBUILD_ACTIVATED=true`, successful `develop` CI at the exact current SHA, and approval through the protected `production` environment. Preview workflow requires `CONVEX_REBUILD_PREVIEW_ACTIVATED=true` and its existing explicit preview request. Leave both activation variables unset until the owner completes the applicable runbook. Opening this PR does not authorize deployment.

Routine production order is: build web, prove Convex target, validate paired configuration, configure Convex, deploy root Convex, upload/promote gateway, upload/promote web, then verify exact release SHA and gateway contract `2`. The production concurrency group never cancels an active release. A first-time Durable Object migration requires the owner's explicit Worker deployment before version-only uploads resume.

## Configuration ownership

The runbook's tables are the authoritative names-only inventory. GitHub environment secrets use `PRODUCTION_` or `PREVIEW_` prefixes for `NEXT_SNAPSHOT_KEYS`, `NEXT_ADMISSION_KEYS`, `NEXT_TRANSPORT_KEYS`, `GATEWAY_INTERNAL_SECRET`, `REGISTRY_KEY_PROJECTION_HMAC_SECRET`, `UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS`, and `NEXT_WEB_SEARCH_SECRET`. Cloudflare, Convex deploy, and Clerk credentials retain their workflow-specific names. Production variables supply `PRODUCTION_DEPLOYMENT_ID`, `PRODUCTION_CONVEX_URL`, `PRODUCTION_CONVEX_SITE_URL`, `PRODUCTION_GATEWAY_URL`, and `PRODUCTION_WEB_URL`.

`NEXT_*` identifies the accepted signed protocol, not a runtime mode. There is no control-plane switch. The three independent transport/admission/snapshot keyrings and deployment ID must match Convex and gateway. Credential encryption keys stay in Convex; key-registration HMAC matches Convex and web; web search HMAC matches Convex and web. Preserve old key IDs through drain and rotation. Never reuse one ring for all purposes.

`pnpm activation:check .tmp/activation.json` validates a private names-to-values configuration bundle offline without printing secrets or contacting providers. Files containing credentials must remain ignored, mode 0600, and outside artifacts. Workflows remove their temporary Worker secret files even on failure.

## Verification and recovery

Gateway `/health` reports `ok: true`, service `zevium-gateway`, contract `2`, and the expected release. Web HTML exposes the same `zevium-release`. Verify catalogue, project disclosure, mock response, API-key/MCP metering, wallet ledger conservation, and payment/refund exceptions using the runbook. Public curl checks do not satisfy the authenticated money journey.

Default recovery after money or schema changes is roll forward. Never restore an old Worker against incompatible new schema or Durable Objects. Migration tags are append-only: `v5-next-edge` creates the accepted namespaces; `v6-control-plane-cutover` deletes `WalletSqliteDO` and its data. An old Worker version cannot resurrect deleted DO data. Owner must explicitly attest emptiness or export/reconcile old state before deletion. Detailed stop/rollback boundaries are in the activation runbook.

## Local verification

`VITEST_MAX_WORKERS=2 pnpm ci:pr` validates root contracts/schema, real anonymous-backend races, the locally running Worker with production migration declarations, shared/web/gateway tests, and production builds. Schema and race scripts create guarded scratch projects under `.tmp/`, discard inherited Convex destinations, and refuse non-loopback anonymous targets. These commands do not deploy shared development or production.
