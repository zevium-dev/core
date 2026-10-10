# API keys

> Status: partial (P0 built; P1 #13 partial) · Updated: 2026-10-10
> Code: `apps/web/src/routes/app/settings/keys.tsx`, `apps/web/src/lib/api-keys.ts`, `convex/keySettings.ts`, `convex/keyVerification.ts`, `convex/http.ts` (`/wallet-grants`), `apps/gateway/src/key-verifier.ts`, `apps/gateway/src/wallet.ts`
> Related: [gateway](gateway.md), [wallet-billing](wallet-billing.md), [accounts-orgs](accounts-orgs.md), [machine-payments](machine-payments.md), [registry-v2](../architecture/registry-v2.md), [decision: dual-rail keys + x402](../decisions/2026-10-10-dual-rail-keys-and-x402.md)

A consumer's API key is the credential every metered call carries. Keys belong to a member, draw from the org wallet, and carry per-key spend limits; rotation keeps the old key alive for a grace period so integrations never break.

## Product

- API keys belong to a member (one key per user), are rate-limited, and carry per-key spend limits against the org wallet
- **Key management**: per-key spend limits with daily/weekly/monthly resets and auto-disable, programmatic key provisioning, zero-downtime rotation (roll-key with grace period)
- P1 #13 — Key-management API with zero-downtime rotation. [roadmap](../product/roadmap.md)

## Flow

### Keys — `/app/settings/keys`

- Key table: name, masked key, per-key spend limit, remaining, last used, per-key usage sparkline, enable/disable
- Create key dialog: name → create → copy-once reveal (blur-in animation per [design system](../design/design-system.md))
- Per-key spend limits with auto-disable. Monthly limits are available; daily and weekly reset choices remain P1
- Zero-downtime rotation: roll key, old key remains usable for a 24-hour grace period
- Programmatic key-management API for SaaS consumers (P1)

## Tech

- **Key verification** (credit gate design): Clerk verify API on first sight → cached in the DO with a short TTL. Zevium-owned key revoke/rotate/disable screens push control changes into the wallet state; no Clerk API-key webhook exists. TTL expiry is the fail-safe. Hot path never waits on Clerk
- **Per-key caps + rotation**: enforced in the wallet DO, not per-request against Convex. A `keySettings` sync (`/wallet-grants` pull) refreshes disabled/monthly-cap/rotation-grace state at ≤60s staleness (`SYNC_GRANTS_WINDOW_MS`, rate-limited to 1/60s per org). Unknown provider keys are quarantined disabled and gateway execution fails closed without a tracked row. Rotation inherits one stable family id and family-wide monthly cap; settled and in-flight usage survive physical key replacement. Server derives a fixed 24h grace, then closes local authority and automatically revokes old Clerk key with bounded retry/recovery.
- **Verified API-key projection**: browser-facing key controls only mutate rows backed by an exact `key.put` stream. Create/rotation server functions verify Clerk owner, active org, old/new ids, independent budget id, and one-time raw secret, then sign a short-lived projection with `REGISTRY_KEY_PROJECTION_HMAC_SECRET`; Convex rechecks signature and JWT identity before atomically writing metadata plus registry events. Raw key material never crosses the Convex or registry boundary.

Local `REGISTRY_KEY_PROJECTION_HMAC_SECRET` setup: [dev-environment](../architecture/dev-environment.md). Registry `key.put`/`key.revoke` streams: [registry-v2](../architecture/registry-v2.md).

Known facts (build plan): Clerk API keys use real prefix `ak_`; user-created keys have subject `user_…`, so org routing needs `claims.org_id`.

Code facts: `createKey` (server fn, `api-keys.ts`) enforces the one-key rule and requires an active org; `ROTATION_GRACE_MS = 24h`; Clerk outage on verify → `503 verification_unavailable` (never cached as invalid); invalid/missing key → `402` envelope ([gateway](gateway.md)); disabled/untracked/cap-exceeded → `403`.

## Decisions

- 2026-07-11 — Key screens stay custom (Clerk profile embeds for everything else). Build plan decisions.
- 2026-07-11 — Per-key caps + rotation enforced in the wallet DO (wave 9a, commit `789e73b`).
- 2026-10-10 — ACCEPTED: keyless x402 wallet sessions become a second auth path beside API keys. [decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md); details in [machine-payments](machine-payments.md).

## Open questions

- Doc/code conflict: key verification cache is not in the DO. `key-verifier.ts` caches per-isolate memory + Cache API, 60s TTL.
- Doc/code conflict: "screens push control changes into the wallet state". No caller in `convex/` or `apps/web/` hits the gateway `/internal/*` control routes; DO converges via `/wallet-grants` pull (≤60s). `index.ts` comment lists `/internal/key-revocation` but no such route is dispatched. Code wins.
- Doc/code conflict: PRODUCT says keys are rate-limited. No per-key request rate limit found in `apps/gateway/src` (only the 1/60s grant-sync limit).
- Doc/code conflict: FLOW key table lists remaining + per-key usage sparkline. `keys.tsx` columns: Name, Key, Monthly cap, Status, Created, Last used.
- P1 gaps: daily/weekly reset choices; programmatic key-management API (keys are created only through session-authed server fns).
