# API keys

> Status: root cutover implemented; owner activation pending; MCP first-connect key auto-creation built; rotation revision fix · Updated: 2026-10-20
> Code: `convex/{keySettings,keyRecovery,keyVerification,mcpKeys,mcpKeysNode}.ts`, `convex/lib/{keys,keyProjection}.ts`, `packages/shared/src/key-projection.ts`, `apps/web/src/lib/{api-keys,api-key-error}.ts`, `apps/web/src/routes/app/settings/keys.tsx`, `tests/keys.test.ts`, `apps/web/src/lib/api-keys.test.ts`
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
- Connecting an agent over OAuth MCP without a key creates the member's key once, named "MCP (auto-created)". It is that member's one key: listed, capped, disabled, rotated and revoked here like any other. Its secret is never shown (OAuth uses it server-side); rotate to get a usable secret. Revoking it does not trigger another auto-creation. While the member's key is disabled, OAuth calls say to re-enable or rotate it here rather than create one
- A member removed from the org needs a key created after rejoining before OAuth MCP works again; nothing is auto-created for them

## Tech

`apps/web/src/routes/app/settings/keys.tsx` mirrors revealed-key state to its event-handler ref after commit and synchronizes cap input on persisted cap changes during render. Existing principal fencing and dialog focus behavior remain.

Broker-signed immutable owner/subject/org/hash projections live in apiKeys, including durable rotation-operation rows and cleanup evidence. Indexed claims prevent global key/hash/member-slot collisions. Rotation retains 24-hour grace and family caps; terminal membership/user/org revocation fences edge snapshots. MCP auto-created keys (`convex/mcpKeys{,Node}.ts`) are minted by a Convex node action with the Clerk secret key, hashed through the same `sealOneTimeExecutionKey` and inserted by `insertKey` without a broker signature (the projection never leaves Convex); the raw secret exists only in that action's memory. Every registration path stamps `verifiedAt` no later than its membership evidence (Clerk membership read for MCP; session-token `iat`, capped at request start, for web create/rotate in `apps/web/src/lib/api-keys.ts`), so a removal webhook stamped during provider calls still fails `insertKey`. Mechanics: [agent-surface](agent-surface.md#tech). The broker HMAC environment/wire names remain compatible; registry events/outbox/transport are removed. No raw key is stored in Convex.

**Rotation completion.** `rotateKey` (`apps/web/src/lib/api-keys.ts`) reserves an operation (`beginRotation`), mints the Clerk replacement, then signs a rotation projection for `completeRotation` (`convex/keySettings.ts`). A key family shares one budget id and one budget revision (`setCap` bumps every member together), so the replacement must carry the old key's `budgetRevision` unchanged; `completeRotation` checks this with the other inherited fields. When any check fails it does not throw: `recordFailedRotation` marks the operation failed, queues `keyVerification.revokeWithRetry` for the minted key and returns the failed DTO. The server function therefore checks `status === "completed"` before returning a secret, otherwise throws `ROTATION_FAILED_MESSAGE` (`api-key-error.ts`) after best-effort provider revoke and `failRotation` with signed cleanup evidence. The settings page shows the copy-once dialog only on that success, toasts the allowlisted failure copy otherwise, and drops the failed operation id so the next attempt starts a fresh rotation.

Fixed 2026-10-20 (prod release a161f7d4): every web rotation failed. The web signed `budgetRevision + 1`, Convex required equality, recorded the operation failed and revoked the new key, but the web ignored the failed result and showed the revoked secret as usable (gateway `invalid_api_key`). Code bug, not HMAC pairing. Regression tests: `tests/keys.test.ts` (revision-bumped replacement fails, old key stays current, cleanup revokes; matching revision completes) and `apps/web/src/lib/api-keys.test.ts` (failed completion never returns a secret).

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

## Decisions

- 2026-10-17 — ACCEPTED: first OAuth MCP connect without a current key auto-creates the member's key. [Decision](../decisions/2026-10-17-mcp-auto-created-key.md).

- 2026-07-11 — Key screens stay custom (Clerk profile embeds for everything else). Build plan decisions.
- 2026-07-11 — Per-key caps + rotation enforced in the wallet DO (wave 9a, commit `789e73b`).
- 2026-10-10 — Key controls use the accepted admin/member model (owner treated as admin): own-key lifecycle for members, all-member management for admins. [decision](../decisions/2026-10-10-two-roles-admin-member.md). Implemented in #364/#356; no new role or permission model.
- 2026-10-10 — ACCEPTED: keyless x402 wallet sessions become a second auth path beside API keys. [decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md); details in [machine-payments](machine-payments.md).

## Open questions

- Per-key configurable request rates remain future work; launch uses one default for all physical keys.
- Last-used and per-key usage projections remain absent; no Clerk request is made to fill them during listing.
- P1 gaps: daily/weekly reset choices; programmatic key-management API (keys are created only through session-authed server fns).
