# API keys

> Status: partial (#396 cap recovery fixed; UI issuance verified in round-two dogfood; #364/#356 ownership and lifecycle fixes implemented; #336 per-key request limits built; P1 #13 partial) · Updated: 2026-10-10
> Code: `apps/gateway/test/payment-recovery.test.ts`, `apps/web/src/routes/app/settings/keys.tsx`, `apps/web/src/lib/api-keys.ts`, `convex/keySettings.ts`, `convex/keyVerification.ts`, `convex/keySettings.test.ts`, `convex/keyVerification.test.ts`, `apps/web/src/lib/api-key-error.ts`, `convex/http.ts` (`/wallet-grants`), `apps/gateway/src/key-verifier.ts`, `apps/gateway/src/wallet.ts`
> Related: [gateway](gateway.md), [wallet-billing](wallet-billing.md), [accounts-orgs](accounts-orgs.md), [machine-payments](machine-payments.md), [registry-v2](../architecture/registry-v2.md), [decision: dual-rail keys + x402](../decisions/2026-10-10-dual-rail-keys-and-x402.md)

A consumer's API key is the credential every metered call carries. Keys belong to a member, draw from the org wallet, and carry per-key spend limits; rotation keeps the old key alive for a grace period so integrations never break.

## Product

- API keys belong to a member (one key per user), are rate-limited, and carry per-key spend limits against the org wallet
- **Key management**: per-key spend limits with daily/weekly/monthly resets and auto-disable, programmatic key provisioning, zero-downtime rotation (roll-key with grace period)
- P1 #13 — Key-management API with zero-downtime rotation. [roadmap](../product/roadmap.md)

## Flow

### Keys — `/app/settings/keys`

- Key table: name, owner, masked key, monthly cap, status, registration date, enable/disable. Members see their own keys; admins (including owners) see every member’s keys. Last-used data is not yet projected; the column displays an em dash.
- Members can rotate, enable/disable, and revoke their own keys; admins manage all org keys and spend caps. Disabled keys still occupy the member’s slot until revoked.
- Create key dialog: name → create → copy-once reveal (blur-in animation per [design system](../design/design-system.md))
- Per-key spend limits with auto-disable. Monthly limits are available; daily and weekly reset choices remain P1
- Zero-downtime rotation: roll key, old key remains usable for a 24-hour grace period
- Programmatic key-management API for SaaS consumers (P1)

## Tech

- **Monthly-cap recovery (#396)**: gateway and MCP now share the safe cap explanation and explicit admin-increase/next-UTC-month instructions, plus `actions.manageKey` at the configured web origin (#417). Wallet top-up alone does not raise a key cap; cap envelopes omit that action. Existing `402 key_cap_exceeded` remains compatible. Contract tests: `apps/gateway/test/payment-recovery.test.ts`.

**Round-two dogfood — 2026-10-10:** normal UI issuance and copy-once reveal worked in separate publisher/consumer orgs; publisher revocation subsequently returned `invalid_api_key` at the gateway. Two rotations initially returned `403 key_untracked` and recovered within the UI’s documented one-minute control-refresh window. #419 was closed as not planned after confirming that notice. Grace-period predecessors and inherited monthly cap worked. No two-identity ownership/RBAC claim. [Evidence](../findings/dogfood-2026-10-10-round-2.md).

- x402 wallet sessions use the same request gate and admission proofs, scoped to the stable payer wallet; see [machine-payments](machine-payments.md).

- **Request rate limit (#336)**: Wallet DO `consumeKeyRateLimit` uses the SQLite `key_rate_buckets` table. Each physical key starts with 60 tokens and refills one token/second (60/minute sustained); rotation keys have independent buckets. Paid, free-tier and zero-price attempts share the bucket, once per admission before route lookup. Disabled/untracked/archived controls win over rate rejection. Indexed idle cleanup discards fully refilled buckets after 60 seconds. Bucket transactions survive eviction and require no per-request Clerk/Convex call; key-control refresh keeps its existing 60s background cadence. Rate settings are not exposed per key yet.
- **Error distinction (#336)**: request burst exhaustion is `429` with integer `Retry-After` seconds; monthly credit spend cap is `402` because it is a spending restriction, not request frequency. Cap recovery is an admin limit increase or the next UTC month, not a one-second retry. Explicitly disabled keys remain `403`.

- **Schema integration repair**: `keySettings.by_owner` is retained alongside `by_owner_status`; the merged registration and member-list queries require the owner-only index, including disabled keys.
  **Dogfood — 2026-10-10**

- **P0 #385:** dogfood baseline `eaa7eff` cannot register keys: `Index keySettings.by_owner not found.` Also blocks normal Convex typechecking. UI issuance is not validated as working; downstream gateway tests used explicit test fixtures.
  Evidence, workarounds and scope: [dogfood findings](../findings/dogfood-2026-10-10.md).

- **MCP OAuth identity (#323)**: `keySettings.resolveMcpIdentity` resolves the consented user/org to exactly one current active verified key. OAuth shares that key’s wallet, cap, rotation family, and revocation controls without exposing its secret. Setup/cache semantics: [agent-surface](agent-surface.md#mcp-oauth-323).

- **Key verification**: `key-verifier.ts` caches per-isolate memory + Cache API with a 60s TTL. There is no Clerk API-key webhook or screen caller of gateway internal control routes; controls converge through registry events and `/wallet-grants` pull. Hot path behavior is owned by [gateway](gateway.md).
- **Per-key caps + rotation**: enforced in the wallet DO, not per-request against Convex. A `keySettings` sync (`/wallet-grants` pull) refreshes disabled/monthly-cap/rotation-grace state every 60s (`SYNC_GRANTS_WINDOW_MS`) through single-flight background refresh. Known snapshots survive Convex outages; cold wallets without controls return `503 wallet_unavailable` and retry after 5s. See [wallet storage and retention](wallet-billing.md#wallet-storage-and-retention-360). Unknown provider keys are quarantined disabled and gateway execution fails closed without a tracked row. Rotation inherits one stable family id and family-wide monthly cap; settled and in-flight usage survive physical key replacement. Server derives a fixed 24h grace, then closes local authority and automatically revokes old Clerk key with bounded retry/recovery.
- **Verified API-key projection**: browser-facing key controls only mutate rows backed by an exact `key.put` stream. Create/rotation server functions verify Clerk owner, active org, old/new ids, independent budget id, and one-time raw secret, then sign a short-lived projection with `REGISTRY_KEY_PROJECTION_HMAC_SECRET`; Convex rechecks signature and JWT identity before atomically writing metadata plus registry events. Raw key material never crosses the Convex or registry boundary.

Local `REGISTRY_KEY_PROJECTION_HMAC_SECRET` setup: [dev-environment](../architecture/dev-environment.md). Registry `key.put`/`key.revoke` streams: [registry-v2](../architecture/registry-v2.md).

Known facts (build plan): Clerk API keys use real prefix `ak_`; user-created keys have subject `user_…`, so org routing needs `claims.org_id`.

- **Atomic member slot** (#364): `registerVerified` reads `keySettings.by_owner` and inserts the signed projection + display name + `key.put` in one serializable mutation. The `by_owner` schema index remains required by registration and member listing after migration cleanup (#354). Current disabled keys count; revoked/expired/grace predecessors do not. Concurrent provider creations can occur, but only one can be registered or returned; rejected provider keys are compensating-revoked. No raw secret reaches Convex.
- **Atomic member slot** (#364): `registerVerified` reads the org/owner prefix of `keySettings.by_owner_status` and inserts the signed projection + display name + `key.put` in one serializable mutation. Current disabled keys count; revoked/expired/grace predecessors do not. Concurrent provider creations can occur, but only one can be registered or returned; rejected provider keys are compensating-revoked. No raw secret reaches Convex.
- **Ownership binding** (#356): `registerOwnedKey` only renames an existing `key.put`-verified row whose owner and subject match the JWT subject in the JWT active org. It cannot create unknown rows, reassign ownership, or insert cross-org duplicate IDs. The provider-verification path also rejects global key-ID collisions across orgs.
- **Revoke ordering and compensation** (#364): Convex authorizes owner/admin first, writes terminal `key.revoke`, and atomically schedules Clerk cleanup before the web server calls Clerk revoke. A provider failure never rolls back a terminal registry stream; cleanup retries with bounded backoff (six attempts). Exhausted jobs surface a static operational error and may be rerun by an operator; gateway authority remains revoked. Grace expiry schedules the same cleanup after a durable local revoke.
- **Realtime display** (#364): keys screen and dashboard use `keySettings.listKeys`; member reads use the org/owner prefix of `by_owner_status` (all statuses), admin/owner reads use `by_org`. DTOs contain display/policy metadata only, without secrets or secret hashes. Registration time comes from `_creationTime`; Clerk last-used metadata is not fetched on page loads. The dashboard counts only the signed-in member’s slot. Cap/status controls use TanStack mutation `isPending` and `.mutate()`; key-specific error copy requires `ConvexError` and an explicit allowlist.
- **Rotation**: members rotate their own keys; admins/owners may rotate member keys without changing ownership. Begin/complete/fail operation IDs remain idempotent, failed IDs stay terminal, and replacements preserve family/budget/cap plus exactly 24h signed grace. Completion rejects keys disabled or revoked during rotation.

Code facts: `createKey` requires an active org; `ROTATION_GRACE_MS = 24h`; Clerk outage on verify → `503 verification_unavailable` (never cached as invalid); invalid/missing key → `402` envelope ([gateway](gateway.md)); disabled/untracked → `403`; monthly spending cap → `402 key_cap_exceeded`; request rate limit → `429 key_rate_limited` with `Retry-After`.

## Decisions

- 2026-07-11 — Key screens stay custom (Clerk profile embeds for everything else). Build plan decisions.
- 2026-07-11 — Per-key caps + rotation enforced in the wallet DO (wave 9a, commit `789e73b`).
- 2026-10-10 — Key controls use the accepted admin/member model (owner treated as admin): own-key lifecycle for members, all-member management for admins. [decision](../decisions/2026-10-10-two-roles-admin-member.md). Implemented in #364/#356; no new role or permission model.
- 2026-10-10 — ACCEPTED: keyless x402 wallet sessions become a second auth path beside API keys. [decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md); details in [machine-payments](machine-payments.md).

## Open questions

- Per-key configurable request rates remain future work; launch uses one default for all physical keys.
- Last-used and per-key usage projections remain absent; no Clerk request is made to fill them during listing.
- P1 gaps: daily/weekly reset choices; programmatic key-management API (keys are created only through session-authed server fns).
