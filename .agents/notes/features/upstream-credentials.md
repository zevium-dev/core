# Upstream credentials (publisher secrets)

> Status: root cutover implemented; owner activation pending · Updated: 2026-10-11
> Code: `convex/upstreamCredentials.ts`, `convex/lib/credentialCrypto.ts`, `packages/shared/src/edge/replication.ts`, `apps/gateway/src/next/pipeline.ts`
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

One required AES-GCM envelope binds purpose/resource/generation/key version. Canonical padded base64 32-byte DB keys are independent of edge signing and transport keys. Credential changes invalidate readiness and advance route revisions. Only executing Worker memory receives decrypted upstream headers; public DTOs, catalogue snapshots and persistent edge storage contain no plaintext. Retain old key versions until all referenced envelopes/journals are gone.

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

## Decisions

- 2026-07-19 — Gateway injects publisher upstream credentials on forwarded calls (commit `a1026c1`).
- 2026-08-12 — Dual-envelope (`sealed*` v2 + legacy `ciphertext`) encryption with AAD binding (commit `1657325`, "harden control-plane trust boundaries").
- 2026-10-10 — House listings will store Zevium's own aggregator keys (treg, RapidAPI) as publisher credentials. [decision](../decisions/2026-10-10-house-supply-via-aggregators.md)
- 2026-10-10 — Consumer-side OAuth tokens (connected accounts) may reuse this envelope encryption; exploring. [decision](../decisions/2026-10-10-no-byok-connected-accounts.md)

## Open questions

- Encryption envelope simplification remains part of the Convex rebuild (#353).
