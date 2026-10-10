# Upstream credentials (publisher secrets)

> Status: built (P0) · Updated: 2026-10-10
> Code: `convex/upstreamCredentials.ts`, `convex/lib/credentialCrypto.ts`, `convex/admin.ts` (`securityRolloutPreflight`, `migrateSecurityRollout`), `convex/securityRollout.ts`, `convex/http.ts` (`/gateway-spec`), `apps/gateway/src/spec-source.ts`, `apps/gateway/src/pipeline.ts`, `apps/web/src/components/project-settings-panel.tsx` (`UpstreamCredentialsCard`), `apps/web/src/routes/app/projects/$projectSlug.tsx`
> Related: [gateway](gateway.md), [publishing-specs](publishing-specs.md), [webhooks-notifications](webhooks-notifications.md), [accounts-orgs](accounts-orgs.md)

Publishers store the credentials their upstream API requires; the gateway attaches them to every forwarded call on the publisher's behalf. Consumers never see or supply them. Without this, no real authenticated API can be listed.

## Product

- P0 #3 — Publisher upstream credentials attached to forwarded calls (without this, no real authenticated API can be listed). [roadmap](../product/roadmap.md)
- On a call, Zevium forwards the request to the publisher's upstream "attaching the publisher's upstream credentials on their behalf" ([gateway](gateway.md) step 4).

## Flow

### Project page Settings tab — `.../projects/{project}` (current route `/app/projects/{project}`)

- Settings tab: admin-only … **upstream credentials** (encrypted secrets attached to forwarded calls) — same tab also holds description, tags, webhook secret/config, spec variables, danger zone (owned by sibling features).
- Publisher golden path step: "attach upstream credentials" before validate → Save draft → Publish.

## Tech

- **Publisher secrets**: project Settings writes upstream header credentials and webhook signing secrets as dual AES-256-GCM envelopes in server-only rows. `UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS` is JSON `{ current, keys }`: retained pre-v2 values may be arbitrary nonempty strings for legacy SHA-256-derived decryption, while `current` must be canonical padded base64 decoding to exactly 32 bytes before any dual-envelope write or migration. `admin:migrateSecurityRollout` returns this preflight and refuses writes until current key is v2-ready. `sealed*` v2 ciphertext uses purpose + stable resource + key-version AAD, blocking row/purpose transplants. `ciphertext` is a temporary legacy-readable rollback envelope. Plaintext-only rollout rows remain readable until migration; partial envelopes fail closed. Every normal write and migration decrypts both newly written envelopes before plaintext is scrubbed, and updates explicitly remove legacy plaintext. Webhook CRUD returns metadata only, explicit signing-secret reveal is org-admin-only, and delivery decrypts only inside server action memory. `GATEWAY_INTERNAL_SECRET` authenticates transport only and is never encryption material. Gateway resolves published spec + upstream secrets through shared-secret-authenticated `GET /gateway-spec`, caches the result for 30s, strips consumer `Authorization`/`x-api-key`, then injects publisher headers before upstream fetch. Public catalogue, discovery, mock, OpenAPI, webhook metadata, and delivery-log payloads never contain secret values.
  - **Staged migration / rollback runbook**: (1) back up Convex and current keyring; add a generated 32-byte base64 key without removing any old version. (2) Deploy optional `sealed*` schema plus dual-read/dual-write code. Previous release can still roll back because legacy envelope stays current and readable. (3) Run read-only `pnpm exec convex run admin:securityRolloutPreflight '{}' --identity '{"subject":"<admin-user-id>"}'`; require `boundEnvelopeReady: true` and inspect `legacyOnlyVersions` before any migration write. (4) Run `pnpm exec convex run admin:migrateSecurityRollout '{"credentialsCursor":null,"webhookCursor":null,"numItems":50}' --identity '{"subject":"<admin-user-id>"}'`; feed each returned `continueCursor` into next call until both `isDone` values are true. Every page reports exact `current`, `old`, `broken`, `corrupt`, `plaintext`, `recovered`, `rewrapped`, and `scrubbed` counts. (5) Run a second complete audit pass from null. Stop on any `broken`, `old`, or `plaintext` row; recover from backup or retained plaintext/legacy envelope. (6) To rotate, set new version as `current`, keep old keys, repeat two passes, and remove an old key only after full audit reports zero old/broken/plaintext rows. (7) Tighten schema to require both envelopes and remove `secret` only after verified zero; retain legacy envelope through rollback window. Reverse recovery is deploy previous reader against retained legacy envelope. Never retire legacy envelope and old application release in same deployment.

Webhook signing-secret side of this bullet also applies to [webhooks-notifications](webhooks-notifications.md).

Code facts: `upstreamCredentials.upsert`/`remove` require `org:admin` of the owning org (cross-org lookups fail as "Upstream credential unavailable"); `listForProject` returns metadata only (`id`, `name`, `updatedAt`); writes bump the security-rollout generation and enqueue a published-project projection.

## Decisions

- 2026-07-19 — Gateway injects publisher upstream credentials on forwarded calls (commit `a1026c1`).
- 2026-08-12 — Dual-envelope (`sealed*` v2 + legacy `ciphertext`) encryption with AAD binding (commit `1657325`, "harden control-plane trust boundaries").
- 2026-10-10 — House listings will store Zevium's own aggregator keys (treg, RapidAPI) as publisher credentials. [decision](../decisions/2026-10-10-house-supply-via-aggregators.md)
- 2026-10-10 — Consumer-side OAuth tokens (connected accounts) may reuse this envelope encryption; exploring. [decision](../decisions/2026-10-10-no-byok-connected-accounts.md)

## Open questions

- Doc/code conflict: runbook step (4) omits a required arg. `admin:migrateSecurityRollout` in `convex/admin.ts` requires `auditId: v.string()` and calls `requireCompletedSecurityAudit`, so an audit must first be started/completed (`securityRollout.startAudit` / `auditPage`). Runbook command as written fails validation. Code wins; runbook needs the audit step.
- Doc/code conflict: `migrateSecurityRollout` also runs `organizations.backfillPublicHandles` per call; runbook does not mention it. Preflight additionally returns `generation` and `auditRequired: true`.
