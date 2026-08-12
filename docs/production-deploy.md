# Production deployment protocol

Production deploys are recoverable state transitions across Convex and
Cloudflare. They are not atomic transactions. Convex changes production code
immediately and has no first-class release rollback; Cloudflare Workers support
immutable versions and rollback. Workflow encodes those facts instead of
claiming cross-vendor atomicity.

## Compatibility rule

Every normal release is **expand-only**:

- Add optional fields, new functions, tolerant readers, and dual-read/write
  paths first.
- Keep old Convex functions, validators, fields, indexes, and response shapes
  while any deployed gateway or web version can use them.
- Backfill with idempotent mutations and prove completion separately. Never
  hide migration work inside deploy command.
- Remove old behavior only in a later contract-only commit after at least one
  fully verified production release uses new shape.

Pull requests containing destructive schema changes must be split. Normal
`Deploy Production` workflow must never carry contract step.

## Truthful state machine

| State                                                  | Traffic                             | Safe action                                      |
| ------------------------------------------------------ | ----------------------------------- | ------------------------------------------------ |
| `validated`                                            | Old release                         | Fix candidate; no recovery needed.               |
| `candidate_verified`                                   | Staging candidate; production old   | Approve production or abandon candidate.         |
| `rollback_pointers_captured_no_traffic_mutation`       | Production old                      | Fix upload; no traffic recovery needed.          |
| `artifacts_uploaded_no_traffic_mutation`               | Production old                      | Resume same SHA or abandon uploaded versions.    |
| `convex_mutation_started`                              | Old Workers; Convex outcome unknown | Inspect deployment, then fix forward.            |
| `convex_expanded`                                      | Old Workers + new compatible Convex | Roll forward. Do not revert schema blindly.      |
| `gateway_active`                                       | New gateway + old web + new Convex  | Deploy web or roll gateway back.                 |
| `web_active`                                           | New Workers + new Convex            | Run deep probe; rollback Workers if it fails.    |
| `verified`                                             | New release                         | Observe, then schedule later contract if needed. |
| `aborted_without_traffic_change`                       | Old Workers and Convex              | Fix configuration/artifact upload and rerun.     |
| `workers_rolled_back_control_plane_change_possible`    | Old Workers; Convex outcome unknown | Inspect Convex, then fix forward.                |
| `workers_rolled_back_control_plane_expansion_retained` | Old Workers + expanded Convex       | Verify evidence; fix forward.                    |
| `manual_recovery_required`                             | Inspect evidence                    | Use recovery matrix below.                       |

Workflow serializes both expand and contract operations with
`production-release` concurrency. Stable candidate data and secrets live in the
`staging` GitHub environment. `production` and `production-contract` require
independent reviewers with self-review disabled. Stale CI SHAs are rejected
before candidate creation. Production jobs repeat GitHub API resolution of
current `develop` and resolve live web plus gateway release identities after
environment approval, immediately before first paid write/provider mutation.
Uploaded code never gets authority merely because an earlier preflight passed.

## Gates before production traffic

1. Exact 40-character git SHA is checked out and matched to current `develop`.
2. Formatting, type checks, unit/contract tests, and workflow invariants pass.
3. Same SHA deploys to stable staging Convex and immutable staging Worker
   versions.
4. Cross-service contract waits through bounded provider propagation, then
   validates SSR release metadata, gateway release/contract identity, live
   Convex discovery price, CORS, zero-credit mock headers, and a positive-cost
   metered wallet/upstream call with a canonical request id. Probe then polls a
   dedicated Convex endpoint for exact usage event, consumer ledger debit, and
   publisher gross/fee/net settlement linkage before gate can pass.
5. Authenticated browser E2E creates, publishes, discovers, and calls a staging
   API, then proves the exact call reached the activity ledger.
6. Human production approval occurs only after candidate gates pass.
7. After approval and before any production paid probe/provider write, current
   `develop` must still equal exact release SHA and current web/gateway identity
   must agree with approved active release. Full paid contract runs against that
   identity. Invalid probe key, stale `RELEASE_PROBE_SECRET`, stale
   `GATEWAY_INTERNAL_SECRET`, stuck async ingest, empty wallet, upstream outage,
   or stale listing fails closed.

In production, both Worker versions upload before mutation and exact uploaded
version IDs are recorded. Convex expansion deploys first, then old gateway and
web catalogue are probed against new Convex. Each new Worker joins a deployment
at 0% traffic and is addressed with Cloudflare's version-override header. Web
verification fetches stamped HTML plus every referenced hashed asset through
the same override, avoiding frontend version skew. Only verified versions move
to 100%, gateway then web. Deep probes run after full convergence.

First rollout from the pre-protocol deployment accepts one explicit `legacy`
identity only when both healthy public services lack release stamps and git
history contains no contract commits. Any partial identity or disagreement
fails closed. Successful rollout replaces legacy; later legacy reappearance can
only come from explicit rollback and still cannot cross a contract commit.

## Required GitHub configuration

Configure environments, never repository-wide plaintext values. GitHub
environment secrets may be backed by repository or organization secrets, but
names below must resolve inside referenced environment.

| Environment           | Variables                                                                                                                                                                                                                                                                              | Secrets                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `staging`             | `STAGING_WEB_URL`, `STAGING_GATEWAY_URL`, `STAGING_CONVEX_URL`, `STAGING_CONVEX_SITE_URL`, `STAGING_E2E_ORG_SLUG`, `RELEASE_PROBE_MOCK_PATH`, `RELEASE_PROBE_MOCK_METHOD`, `RELEASE_PROBE_METERED_PATH`, `RELEASE_PROBE_METERED_METHOD`; `RELEASE_PROBE_CONTENT_TYPE` for non-GET/HEAD | `CLOUDFLARE_API_TOKEN`, `CLERK_STAGING_PUBLISHABLE_KEY`, `CLERK_STAGING_SECRET_KEY`, `GATEWAY_STAGING_INTERNAL_SECRET`, `CONVEX_STAGING_DEPLOY_KEY`, `STAGING_RELEASE_PROBE_API_KEY`, `STAGING_RELEASE_PROBE_SECRET`, `STAGING_E2E_EMAIL`, `STAGING_E2E_PASSWORD`, `STAGING_E2E_API_KEY`; `STAGING_RELEASE_PROBE_REQUEST_BODY` required for non-GET/HEAD; optional `STAGING_E2E_OTP` |
| `production`          | `RELEASE_PROBE_MOCK_PATH`, `RELEASE_PROBE_MOCK_METHOD`, `RELEASE_PROBE_METERED_PATH`, `RELEASE_PROBE_METERED_METHOD`; `RELEASE_PROBE_CONTENT_TYPE` for non-GET/HEAD                                                                                                                    | `CLOUDFLARE_API_TOKEN`, `CLERK_PRODUCTION_PUBLISHABLE_KEY`, `CLERK_PRODUCTION_SECRET_KEY`, `CONVEX_PRODUCTION_DEPLOY_KEY`, `PRODUCTION_RELEASE_PROBE_API_KEY`, `PRODUCTION_RELEASE_PROBE_SECRET`; `PRODUCTION_RELEASE_PROBE_REQUEST_BODY` required for non-GET/HEAD probe                                                                                                            |
| `production-contract` | Same five `RELEASE_PROBE_*` path/method/content variables as `production`                                                                                                                                                                                                              | `CONVEX_PRODUCTION_DEPLOY_KEY`, `PRODUCTION_RELEASE_PROBE_API_KEY`, `PRODUCTION_RELEASE_PROBE_SECRET`; `PRODUCTION_RELEASE_PROBE_REQUEST_BODY` required for non-GET/HEAD probe                                                                                                                                                                                                       |
| `gateway-do-staging`  | Same stable staging origins and probe variables as `staging`                                                                                                                                                                                                                           | `CLOUDFLARE_API_TOKEN`, `STAGING_RELEASE_PROBE_API_KEY`, `STAGING_RELEASE_PROBE_SECRET`; `STAGING_RELEASE_PROBE_REQUEST_BODY` required for body methods                                                                                                                                                                                                                              |
| `gateway-do-expand`   | Same probe variables as `production`                                                                                                                                                                                                                                                   | `CLOUDFLARE_API_TOKEN`, `PRODUCTION_RELEASE_PROBE_API_KEY`, `PRODUCTION_RELEASE_PROBE_SECRET`; `PRODUCTION_RELEASE_PROBE_REQUEST_BODY` required for body methods                                                                                                                                                                                                                     |
| `gateway-do-contract` | Same probe variables as `production`                                                                                                                                                                                                                                                   | Same as `gateway-do-expand`; use separate required reviewers for destructive lifecycle approval                                                                                                                                                                                                                                                                                      |

Staging origins must be HTTPS, credential-free, and distinct from production.
Probe content type must match published operation request media type. Body is
sent byte-for-byte; JSON syntax is additionally validated for JSON media types.
`STAGING_WEB_URL` and `STAGING_GATEWAY_URL` point to stable
`zevium-web-staging` and `zevium-gateway-staging` Workers. Tagged staging
deploys create those Workers on first use and immutable versions thereafter.
Workflow provisions their Clerk/internal secrets through temporary 0600 files,
then deletes those files before artifact upload. Same
`GATEWAY_STAGING_INTERNAL_SECRET` must be configured on staging Convex as
`GATEWAY_INTERNAL_SECRET`; mismatch fails gateway readiness and metering.
Configure independent high-entropy `RELEASE_PROBE_SECRET` values in staging and
production Convex, then mirror them only into corresponding protected GitHub
environment secrets. This credential can read one request-scoped accounting
projection. It cannot ingest usage, deploy, query wallets, or reveal consumer
identity/key/balance. Rotate it independently from `GATEWAY_INTERNAL_SECRET`.

Activation is fail-closed: current production Convex must already expose
`/release-probe-accounting` before normal production release can pass baseline.
For first adoption, review and deploy only this backward-compatible Convex
query/httpAction expansion under production approval, configure secret, then
rerun exact unchanged release SHA. HTTP 404/401/503 or pending settlement blocks
normal workflow; never weaken baseline to bootstrap it.

Provision stable staging state before enabling release workflow: Convex
deployment, staging Clerk instance and E2E account/org, public positive-cost
probe project with reliable test upstream, and funded org-scoped API key. At
minimum, staging Convex needs `CLERK_JWT_ISSUER_DOMAIN`, `APP_ORIGIN`, and
`GATEWAY_INTERNAL_SECRET`; values must match staging Clerk/web/gateway config.
Configure other feature secrets required by staged journeys. Workflow deploys
code and Worker versions; it deliberately does not manufacture identity,
wallet, catalogue, or upstream fixtures during release.

Before every Convex mutation, workflow runs `convex deploy --dry-run`, parses
CLI-selected deployment URLs, and requires every reported target to equal
reviewed expected origin. A staging key aimed at production, or inverse, fails
before code push. Parser fails closed when Convex omits or changes target output.

Cloudflare token needs Worker Versions upload/deploy/rollback, deployment-list,
version-view, and relevant Worker script permissions only. Probe API keys must
be dedicated, org-scoped, capped, rotatable, outside free tier, and funded for
at least four charged calls (baseline, expanded control plane, zero-traffic
gateway candidate, convergence). Keep capacity for one rollback proof too.
Workflow never prints or captures them.

Enable required reviewers and prevent self-review for production environments.
Keep branch protection requiring `Continuous Integration` and preview contract
checks.

## Evidence safety

Artifacts contain release SHA, timestamps, HTTP status/timing, Cloudflare
version pointers, failure screenshots, and failing page URLs. Accessibility
snapshots are deliberately excluded because form values can contain credentials.
Contract probe never writes response bodies, request headers, API keys, cookies,
deploy keys, or environment dumps. Accounting evidence contains request id,
settlement reference, charged credits, and publisher split totals only; no
consumer org, key id, wallet balance, or secret. Retention is 14 days for
staging and 30 days for production.

Browser failure snapshots can contain user-visible staging data. Dedicated E2E
accounts must contain no personal or production data.

## Recovery matrix

1. Open run artifact `state.json`; identify last completed state. Check provider
   dashboards before rerunning anything.
2. If failure occurred before `convex_mutation_started`, abandon candidate or
   rerun exact SHA. If state is `convex_mutation_started`, inspect Convex: CLI
   failure can occur after provider commit, so mutation outcome is unknown.
3. If Convex expanded but no Worker moved, leave compatible expansion live and
   fix forward. Convex has no safe generic rollback command.
4. If gateway or web moved, workflow attempts explicit rollback to version IDs
   captured before deploy only after lifecycle gate proved both versions share
   same DO lifecycle. Rollback success requires full authenticated paid probe
   plus exact Convex accounting, not `/health`. Never assume rollback succeeded
   because job ended.
5. If old Workers fail against expanded Convex, expansion violated protocol.
   Restore compatibility with smallest roll-forward Convex patch from a new,
   reviewed SHA. Do not deploy a stale schema snapshot over live data.
6. If new Workers are healthy and only probe dependency is failing, keep last
   known compatible combination, document incident, and rerun probe after
   dependency recovery. Do not contract.
7. If failure occurs after a Convex contract, roll forward missing compatibility
   immediately. Cloudflare rollback may be unsafe because contracted schema may
   no longer serve old Workers. Create exactly one `fix(convex):` child commit
   touching only `convex/`, then rerun `Contract Production Schema` with
   `recovery_of` set to failed contract SHA. Recovery still rehearses staging,
   requires production-contract approval, applies final state, and deep-probes
   before unblocking normal releases.

Manual Cloudflare recovery uses captured `previousVersion` values:

```bash
pnpm --filter gateway exec wrangler rollback <gateway-version-id> --yes
pnpm --filter web exec wrangler rollback <web-version-id> --config dist/server/wrangler.json --yes
```

Run `release-contract.mjs` with expected active SHA after recovery. Never paste
probe keys into command line; provide `RELEASE_PROBE_API_KEY` and
`RELEASE_PROBE_SECRET` through protected environment.

## Durable Object lifecycle phase

Generic `Deploy Production` rejects any gateway binding, class export, legacy
migration history, migration tag, class add/rename/delete/transfer, or binding
target change not already applied by reviewed lifecycle workflow. It compares
candidate config with active release source and authoritative metadata from
active Cloudflare version before `versions upload`. Therefore generic Worker
rollback never crosses DO lifecycle/storage state and never claims it can.

Create one isolated commit after active release touching only `apps/gateway/`.
Keep migration history append-only. Run **Gateway Durable Object Lifecycle**
with exact current `develop`, exact active release, and reviewed phase:

- `expand`: add class/binding and appended `new_classes` or
  `new_sqlite_classes`. Keep old class/binding readable.
- `contract`: rename/delete/transfer class, change/remove binding, or remove
  export only after separate data migration and observation proved old state
  unused. This is irreversible approval, not rollback.

Workflow rehearses identical phase against staging, validates active Cloudflare
metadata equals reviewed base, then enters `gateway-do-expand` or
`gateway-do-contract`. Production uses atomic `wrangler deploy` because
Cloudflare Versions upload cannot carry DO lifecycle migrations. Worker release
identity intentionally remains old while lifecycle-only code lands. Full paid
accounting runs before and after. Success stamps
`zevium/gateway-do-lifecycle`; later normal release may upload code only when
source diff, remote lifecycle, and marker agree. Failure has no automatic
rollback. Freeze releases, inspect migration/storage state, and roll forward
with another isolated reviewed phase.

Class rename follows staged provider protocol: add new class/binding in expand,
migrate/read both, then append rename/remove old binding in contract. Never mix
expand and contract operations in one lifecycle commit. Applied migration steps
may not be edited or removed.

## Contract phase

Contract change must be exactly one commit after active release, touch only
`convex/`, use `contract(convex):` subject, and remain current `develop` tip.
Normal production workflow recognizes that subject and does not deploy it. Run
`Contract Production Schema` manually with contract SHA and verified active
release SHA. Workflow rehearses contract on staging and runs authenticated,
metered E2E. Separate `production-contract` approval then re-proves active
consumers, applies contract, and runs deep probes again.

Immediately before production contraction, workflow records pending commit
status context `zevium/convex-contract`; successful post-contract probes change
it to success. Normal releases scan every contract commit since active Worker
release and refuse deployment unless each latest marker is successful. This
prevents a later normal commit from silently carrying an unapplied contraction.
Interrupted or failed contractions remain blocking until reviewed recovery and
a successful contract or recovery run.

Contract rollback is intentionally absent. Removed schema/functions may make
old Workers incompatible and Convex cannot atomically restore code plus data.
Failure response is a reviewed roll-forward compatibility patch. Recovery mode
accepts only one `fix(convex):` commit immediately after one failed
`contract(convex):` commit, requires both commits after active Worker release to
touch only `convex/`, and refuses recovery when original marker already passed.
Because broken contracted state may fail paid pre-probe, recovery first proves
unchanged Worker identities, then requires full paid probe after repair. Success
marks original contract context recovered with recovery SHA in description.

## Provider limitations

- Convex production deploy changes live functions/schema immediately. No
  first-class immutable deployment selection, traffic split, or atomic data/code
  rollback exists. Deployment history is not a substitute for compatible
  roll-forward.
- Cloudflare Worker code supports immutable versions, 0%-traffic version
  overrides, weighted traffic, and rollback. Durable Object storage and class
  migrations are shared state, not versioned with Worker code. DO migrations
  must also be expand-only. A version override proves Worker code/bindings, not
  unrelated zone configuration.
- Worker secrets persist outside source artifacts. Staging candidate uploads
  carry reviewed Clerk/internal secrets in temporary files; production uploads
  preserve existing remote secrets. Production rotation remains separate
  controlled work and every release probe proves resulting bindings function.
- GitHub concurrency and environment approvals serialize this workflow, not
  vendor consoles or emergency manual commands. Operators must check provider
  activity before recovery.
- Staging proves contracts against separate vendor tenants and test data. It
  reduces risk but cannot prove production data shape or third-party uptime.

## Threat and failure model

- Fork/ref injection: manual release input enters secret-free resolver as an
  environment value, must match lowercase full SHA regex and GitHub API current
  `develop`, is emitted as job output, then exact output is checked out. Cache
  restore and Mise execute only after trusted checkout. No input becomes shell
  syntax, checkout ref, cache expression, or command fragment.
- Approval delay: every production environment job re-resolves current
  `develop` and active production identities after approval. Normal deploy also
  repeats SHA check directly before first Cloudflare write. Stale approval dies
  before paid baseline or provider mutation.
- Concurrency: expand, contract, and DO lifecycle workflows share
  `production-release` with cancellation disabled. GitHub ordering is not
  assumed. Vendor-console/manual writes remain out of band and active metadata
  checks catch them.
- Cancellation: workflow cancellation or runner death can happen between any
  vendor calls despite `cancel-in-progress: false`. State markers are written
  before ambiguous Convex mutation; captured Cloudflare version IDs and paid
  evidence drive recovery. DO lifecycle cancellation is roll-forward only.
- Async failure: gateway returns before usage ingest. Every paid gate polls
  boundedly for same request id and exact usage/ledger/publisher settlement.
  Missing ingest, stale internal secret, duplicate/wrong linkage, or timeout
  fails gate. No public health success substitutes for accounting.
- Credential/log failure: release accounting secret is query-only and distinct
  from ingest/deploy keys. Requests use headers; scripts persist no headers,
  bodies, environment, or credentials. HTTP errors return generic messages and
  server logs never include supplied secret.
