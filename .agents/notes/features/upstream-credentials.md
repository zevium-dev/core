# Upstream credentials (publisher secrets)

> Status: built (P0; publication with credentials #389 fixed) · Updated: 2026-10-10
> Code: `convex/upstreamCredentials.ts`, `convex/lib/credentialCrypto.ts`, `convex/http.ts` (`/gateway-spec`), `apps/gateway/src/spec-source.ts`, `apps/gateway/src/pipeline.ts`, `apps/web/src/components/project/credentials-card.tsx` (`UpstreamCredentialsCard`), `apps/web/src/routes/app/projects/$projectSlug.tsx`, `apps/web/src/components/project-settings-panel.tsx`, `convex/publishReadiness.ts`, `convex/publishReadiness.test.ts`
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

**Dogfood — 2026-10-10**

- **P0 #389:** credential storage/injection worked in dogfood, but publication with credentials already stored failed repeatedly after passing health checks. See [publishing-specs](publishing-specs.md) for the blocker; injection was tested only after publishing without credentials and then restoring a harmless header.

Evidence, workarounds and scope: [dogfood findings](../findings/dogfood-2026-10-10.md).

- **Readiness binding (#389)**: `upsert` starts `revision` at 1 and increments it on each write, including writes in the same millisecond. Publication and readiness use the same revision calculation, with an `updatedAt` fallback for legacy rows. Credential changes still require a new health test; the complete gate contract is in [quality-signals](quality-signals.md).

- **Fresh deployment (#354)**: removed security audit/migration APIs, their global generation singleton, and the secret-repair helper. Normal credential encryption, reads, writes, and registry projection remain. Keep configured key versions needed to read existing envelopes; there is no bulk rewrap operator.

- **Publisher secrets**: project Settings writes upstream header credentials and webhook signing secrets as dual AES-256-GCM envelopes in server-only rows. `UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS` is JSON `{ current, keys }`: retained pre-v2 values may be arbitrary nonempty strings for legacy SHA-256-derived decryption, while `current` must be canonical padded base64 decoding to exactly 32 bytes before any dual-envelope write. `sealed*` v2 ciphertext uses purpose + stable resource + key-version AAD, blocking row/purpose transplants. `ciphertext` is a temporary legacy-readable rollback envelope. The current reader still supports plaintext-only rows; partial envelopes fail closed. Every normal write decrypts both newly written envelopes before plaintext is scrubbed, and updates explicitly remove legacy plaintext. Webhook CRUD returns metadata only, explicit signing-secret reveal is org-admin-only, and delivery decrypts only inside server action memory. `GATEWAY_INTERNAL_SECRET` authenticates transport only and is never encryption material. Gateway resolves published spec + upstream secrets through shared-secret-authenticated `GET /gateway-spec`, caches the result for 30s, strips consumer `Authorization`/`x-api-key`, then injects publisher headers before upstream fetch. Public catalogue, discovery, mock, OpenAPI, webhook metadata, and delivery-log payloads never contain secret values.

Webhook signing-secret side of this bullet also applies to [webhooks-notifications](webhooks-notifications.md).

Code facts: `upstreamCredentials.upsert`/`remove` require `org:admin` of the owning org (cross-org lookups fail as "Upstream credential unavailable"); `listForProject` returns metadata only (`id`, `name`, `updatedAt`); writes enqueue a published-project projection.

## Decisions

- 2026-07-19 — Gateway injects publisher upstream credentials on forwarded calls (commit `a1026c1`).
- 2026-08-12 — Dual-envelope (`sealed*` v2 + legacy `ciphertext`) encryption with AAD binding (commit `1657325`, "harden control-plane trust boundaries").
- 2026-10-10 — House listings will store Zevium's own aggregator keys (treg, RapidAPI) as publisher credentials. [decision](../decisions/2026-10-10-house-supply-via-aggregators.md)
- 2026-10-10 — Consumer-side OAuth tokens (connected accounts) may reuse this envelope encryption; exploring. [decision](../decisions/2026-10-10-no-byok-connected-accounts.md)

## Open questions

- Encryption envelope simplification remains part of the Convex rebuild (#353).
