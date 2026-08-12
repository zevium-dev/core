# Production deployment protocol

Production release is a recoverable state transition across Convex and
Cloudflare, not one atomic transaction. Convex code becomes live on deploy and
has no generic rollback. Cloudflare Worker code is versioned, but Durable Object
storage and lifecycle are not. Release automation preserves those boundaries.

## Release lanes

All production mutations share concurrency group `production-release` with
cancellation disabled:

- **Deploy Production** ships backward-compatible Convex expansion, gateway,
  then web. It never carries a Durable Object lifecycle diff or unapplied
  Convex contract.
- **Contract Production Schema** applies one reviewed semantic Convex
  contraction after proving old consumers against staging and production. Exact
  parent/target contract inventories decide eligibility; commit subjects and
  non-Convex companion files carry no authority.
- **Gateway Durable Object Lifecycle** owns every staging and production DO
  lifecycle mutation. Generic release classifies complete lifecycle state before
  any staging environment or provider mutation and exits successfully with
  `eligible=false` whenever lifecycle differs.
- **Recover Production** is separately dispatchable and protected by
  `production-recovery`. It consumes one failed run's persisted manifest,
  re-resolves current provider state, and performs only bounded roll-forward or
  rollback allowed by that manifest.

GitHub retains one running and newest pending member of a concurrency group.
Coalescing is intentional: only current `develop` may run, and a superseded
normal SHA remains an ancestor of newest `develop`, so newest release includes
it. Protected contract/lifecycle commits cannot disappear: generic preflight
enumerates every such commit between active production and candidate and blocks
until each exact commit has verified protected-workflow provenance. Dedicated
workflows accept `contract_sha` or `lifecycle_sha` when protected commit is
buried under later commits. Contract runs require every earlier protected
requirement through target parent to have verified provenance, then install and
deploy target commit from its own frozen checkout; later protected commits stay
undeployed and blocked until their own ordered run. Contract recovery deploys
only its reviewed one-commit Convex roll-forward fix. Thus replacement can
coalesce normal releases, but cannot silently bypass or deadlock multiple
protected releases.

## Compatibility rule

Normal release is expand-only:

- Add optional fields, functions, indexes, tolerant readers, and dual paths.
- Retain old Convex functions, validators, fields, indexes, and response shapes
  while any deployed Worker can use them.
- Run idempotent backfills separately and prove completion.
- Remove old behavior only in a later reviewed candidate whose exact
  parent/target semantic inventory proves contraction.

Prefer split pull requests for expansion and contraction. Release automation
does not trust naming discipline: it inventories every public and internal
query, mutation, and action (arguments and return validators), every table and
full index/search/vector configuration, typed validator literals, and HTTP
route identity directly from exact git objects. Convex failure after a deploy
starts is ambiguous and always recovers by compatible roll-forward.

## Trust and provenance

Every approved job performs candidate-independent GitHub API checks before
checkout, cache restore, Node setup, or dependency install. It requires exact
lowercase 40-character current `develop` SHA and exactly one successful push run
of `.github/workflows/ci.yml`. Remote actions use full commit SHAs. Node is fixed
at `24.15.0`, pnpm at `11.8.0`, and install is frozen. Candidate-controlled Mise
or global package installation is forbidden. Browser E2E executes exact
workspace `agent-browser` binary whose package tarball integrity is frozen in
`pnpm-lock.yaml`; no ad-hoc npm install runs before protected credentials enter
a step.

Raw commit status is never trusted. Contract and lifecycle production jobs emit
GitHub-signed custom attestations whose predicate binds:

- exact protected workflow ID and path;
- successful run ID, attempt, run head, and protected target commit;
- exact single-parent protected base and active production base;
- reviewed GitHub environment and deployment success;
- phase and canonical lifecycle/contract digest.

Generic descendant release downloads exact target artifact, verifies GitHub's
signature and signer workflow, queries run/workflow/deployment APIs, re-computes
digest from git objects, and proves target ancestry under run head. Missing,
ambiguous, stale, or unverifiable provenance blocks release.

Immediately before every upload, deploy, or traffic mutation, same shell block
rechecks current GitHub identity and exact provider state. Cloudflare blocks
re-list active deployments, inspect exact version metadata, and compare captured
version IDs/config. Convex blocks run production `deploy --dry-run` and require
reported target URL to equal reviewed deployment before live deploy.

## Paid release proof

Each probe creates fresh cryptographically random 32-byte challenge. Challenge
travels only in authenticated gateway request, is stripped before upstream, and
is atomically persisted with settled usage plus stamped gateway release.
Accounting lookup binds exact request ID, challenge, not-before timestamp, and
expected immutable release. It additionally proves:

- positive-cost successful usage is fresh and unique;
- settlement ledger row references wallet owned by consumer organization;
- latest wallet ledger sequence/checkpoint and materialized balance agree;
- publisher gross, platform fee, and net split match settlement exactly.

Challenge is one-time and globally rate-gated. Replay, stale row, duplicate
request/settlement, cross-wallet linkage, checkpoint drift, wrong release, or
pending async ingest fails closed. Endpoint accepts only bounded JSON POST,
bounded secret/challenge fields, fixed-size digest comparison, and returns only
minimal proof totals. It never exposes organization, key, wallet balance,
sequence, lifecycle status, request headers, or response body.

Browser E2E captures gateway request ID and challenge, then requires one
activity row carrying both exact values. Project/route/cost/status alone cannot
satisfy test.

## Clerk release-key resolution

No production or staging API key secret is stored in GitHub. Immediately before
every paid staging, production, contract, lifecycle, or recovery probe,
`with-clerk-release-key.mjs` uses protected Clerk secret key to:

1. paginate organizations and resolve exactly one configured slug;
2. paginate memberships and resolve exact configured member user ID;
3. paginate all API keys, including invalid rows;
4. select exactly one active `api_key` whose subject, creator, and `org_id`
   claim match member and organization;
5. optionally require exact configured `ak_` key ID;
6. fetch key material; immediately mask the retrieved value before any other
   output, verify it, and pass it
   only through child-process environment.

Zero or multiple matches fail. Resolver rejects malformed Clerk payloads,
revoked/expired keys, cross-org claims, wrong creators, and wrong subjects. It
never writes secret to output, artifact, argv, or file; child loses Clerk,
Cloudflare, Convex, and GitHub credentials.

## Normal release sequence

1. Secret-free preflight resolves current active public release, classifies
   complete DO lifecycle projection, verifies all protected attestations, and
   runs uncached release CI.
2. Staging approval re-runs GitHub guard before checkout. Convex dry-run target,
   active gateway lifecycle metadata, and active web version are checked in same
   blocks as staging deploys.
3. Staging paid contract and browser E2E prove exact accounting.
4. Production approval re-verifies current tip, active public identity, and all
   protected provenance.
5. Exact gateway/web rollback pointers and intent manifest are captured and
   uploaded before first mutation.
6. Both immutable Worker candidates upload. Candidate IDs enrich and re-upload
   manifest before Convex or traffic mutation.
7. Convex expansion deploys; old Workers are probed against expanded control
   plane.
8. Gateway enters 0% deployment, is paid-probed through exact version override,
   then moves to 100% after weights/config recheck.
9. Web enters 0%, stamped HTML and referenced hashed assets are checked through
   override, then web moves to 100%.
10. Final public paid accounting proves convergence and exact active release.

## Durable Object lifecycle

Canonical lifecycle digest contains selected Wrangler environment, effective
Worker name, DO bindings (`name`, `class_name`, `script_name`, `environment`),
legacy migration history, declarative live exports, and tombstones. Named-env
bindings are non-inheritable; migrations and exports inherit. Local bindings
must point to live declared classes. Provider proof compares exact DO bindings,
named class handlers, migration tag, and readable live exports.

Legacy mode is append-only. New KV/SQLite classes are expansion; rename/delete
are contract; cross-Worker `transferred_classes` is expansion on receiving
Worker but requires source inspection. Applied tags/steps cannot change or
disappear.

Declarative `exports` and legacy `migrations` are mutually exclusive. Supported
legacy-to-exports transition is one-way and must preserve every live class and
known storage exactly. New declarative namespaces use SQLite; `legacy-kv` is
accepted only when preserving existing namespace.

Declarative state machine:

- `created` is live and has immutable `storage`.
- `deleted`, `renamed`, and `transferred` are tombstones. Delete removes code
  and local binding. Rename requires live target. Transfer source requires
  matching target `expecting-transfer` first.
- `expecting-transfer` is target preparation. It names exact source and has no
  local self-binding until source commits transfer. Final target changes to
  `created` and adds binding.
- Tombstone removal is allowed only after Cloudflare reconciliation lists exact
  entry in `removable_entries`.

Cloudflare version reads omit write-only tombstone destinations and cannot prove
all reconciliation state. Current automation therefore marks delete/rename/
transfer, pending-transfer cancellation/finalization, and tombstone cleanup as
`manualInspectionRequired` and fails dedicated secret-free preflight before
staging or provider mutation. Never weaken this to inferred state. Extend
provider proof with authoritative reconciliation/source/target metadata first.

Lifecycle changes use `wrangler deploy`; `wrangler versions upload` cannot apply
them. Lifecycle is non-rollbackable because Worker version rollback does not
roll back DO storage. Dedicated recovery only re-resolves and rolls forward if
current state still equals captured base or candidate; it never rolls across
lifecycle.

## Cancellation and recovery

Signal traps do one fast local action: atomically record
`ambiguous_recovery_required`, then exit. They do not call providers, probe, or
claim rollback. Every production lane also handles `failure() || cancelled()`
and uploads available evidence.

Dispatch **Recover Production** with failed run ID and reviewed action. Failed,
cancelled, or timed-out deploy, lifecycle, and recovery runs are valid sources.
Resolution binds exact run attempt and downloads its exact attempt-named
manifest artifact. Stable release/root identity survives recursive recovery.

Every source manifest contains a SHA-256 candidate lineage. Each recovery run
persists a new attempt token before provider mutation, stamps that token into
uploaded Worker metadata, finalizes exact gateway/web version IDs into the hash
chain, and uploads the finalized attempt manifest before traffic convergence.
An active version is accepted only when its ID is finalized in that chain or
when exact provider metadata proves a still-pending lineage token; arbitrary
lookalike versions fail closed. This also covers cancellation after a recovery
candidate becomes active. Missing, partial, tampered, mixed, or expired lineage
fails.

Convex ambiguous/contract state forces roll-forward. Normal gateway/web may
roll forward to lineage-bound candidates or roll back to captured previous
versions when lifecycle digest allows. Lifecycle always rolls forward.
Recovery ends only after exact provider state and paid accounting proof;
protected lifecycle recovery emits signed recovery attestation bound to root
failed lifecycle run.

## Required GitHub environments

Use required reviewers, prevent self-review, restrict deployment branches to
`develop`, and disable admin bypass where policy allows.

| Environment            | Variables                                                                                                                                                                                                                                                                                                                             | Secrets                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `staging`              | `STAGING_WEB_URL`, `STAGING_GATEWAY_URL`, `STAGING_CONVEX_URL`, `STAGING_CONVEX_SITE_URL`; probe paths/methods/content type; `RELEASE_PROBE_CONSUMER_ORG_SLUG`, `RELEASE_PROBE_CONSUMER_MEMBER_USER_ID`, optional `RELEASE_PROBE_API_KEY_ID`; `STAGING_E2E_ORG_SLUG`, `STAGING_E2E_MEMBER_USER_ID`, optional `STAGING_E2E_API_KEY_ID` | Cloudflare token; staging Clerk publishable/secret keys; staging Convex deploy key; staging probe secret/body; E2E email/password/optional OTP |
| `production`           | Probe paths/methods/content type; exact consumer org/member/optional key ID                                                                                                                                                                                                                                                           | Cloudflare token; production Clerk publishable/secret keys; production Convex deploy key; production probe secret/body                         |
| `production-contract`  | Same production probe variables                                                                                                                                                                                                                                                                                                       | Production Clerk secret key; Convex deploy key; probe secret/body                                                                              |
| `production-lifecycle` | Same production probe variables                                                                                                                                                                                                                                                                                                       | Cloudflare token; production Clerk publishable/secret keys; Convex deploy key; probe secret/body                                               |
| `production-recovery`  | Same production probe variables                                                                                                                                                                                                                                                                                                       | Same production provider, Clerk, Convex, and probe secrets needed by bounded recovery                                                          |

`RELEASE_PROBE_REQUEST_BODY` is required only for body methods. JSON body must
match content type and operation schema. Probe fixture must be public,
positive-cost, outside free tier, reliable, funded, and owned by exact consumer
org. Keep credits for staging, baseline, candidate, convergence, and recovery.

There is deliberately no `PRODUCTION_RELEASE_PROBE_API_KEY`, staging equivalent,
or E2E API-key secret.

## Evidence and external bootstrap

Artifacts contain SHAs, run IDs and attempts, candidate-lineage digests,
timestamps, state, provider version pointers, minimal accounting totals, and
failure screenshots. They exclude keys, challenge,
headers, cookies, request/response bodies, environment dumps, and consumer
identity. Staging retention is 14 days; production/recovery 30 days; protected
attestation subject 90 days.

Repository cannot enforce or verify these external controls:

- GitHub environment reviewers, self-review/admin bypass, deployment branch
  rules, and secret placement;
- Cloudflare token least privilege and current active provider state;
- Convex deploy-key scope, production environment variables, deployed bootstrap
  schema, and secret rotation;
- Clerk dedicated member/key fixture and funded consumer wallet;
- first deployment of `/release-probe-accounting` expansion. Until endpoint and
  `RELEASE_PROBE_SECRET` exist in production, HTTP 404/401/503 blocks release.

Bootstrap these under reviewed provider procedures. Never bypass failed checks,
paste API-key secret into commands, or manually forge provenance.
