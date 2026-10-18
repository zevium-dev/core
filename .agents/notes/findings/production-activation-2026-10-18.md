---
name: production-activation-2026-10-18
description: Gotchas from the first production activation; untagged Worker versions fail health, a stale waiting deploy blocked the release queue, Stripe v2 secrets are dashboard-only
---

# Production activation gotchas (2026-10-18)

Activation ran on dev (`doting-warbler-454`) and production (`polite-ermine-809`, `zevium-gateway`, `zevium-dev`), and previews were enabled. Three things went wrong or could not be automated:

- **`wrangler secret put` breaks gateway health.** It publishes a new Worker version with no version tag, so `/health` reports `ok:false` (deployment proof invalid). The release preflight then refuses to run. Pass secrets through `--secrets-file` on a tagged `wrangler deploy`, or let the release workflow set them. If it happens, `wrangler versions deploy <tagged-version>@100%` restores health.
- **A stale waiting deploy blocks every release.** `deploy-production.yml` uses one concurrency group without cancel-in-progress, so a run waiting on the protected `production` environment holds the group. A 2026-10-04 legacy run sat waiting for two weeks, and every new run queued as `pending` with no jobs. Find it with `gh api 'repos/zevium-dev/core/actions/runs?status=waiting'`. Cancel stale runs; never approve one, because it would deploy old code over the new system.
- **Stripe v2 event destination signing secrets are dashboard-only.** The API returns `signing_secret: null` on create and retrieve. The owner copies it from Workbench and pipes it into `convex env set NEXT_STRIPE_V2_WEBHOOK_SECRET`. Until that happens, `/stripe-connect-v2-webhook` answers 503 and the destination stays disabled.

The first automated release after cutover (`ab95d0bd`) deployed green once the stale run was cancelled. Related: [activation runbook](../architecture/convex-activation.md), [deploy](../architecture/deploy.md).
