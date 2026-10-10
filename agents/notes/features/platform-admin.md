# Platform admin

> Status: partial · Updated: 2026-10-10
> Code: `convex/admin.ts`, `convex/admin.test.ts`, `convex/lib/auth.ts` (`requireAdmin`, `isAdmin`), `apps/web/src/routes/admin.tsx`, `apps/web/src/routes/admin/index.tsx`, `apps/web/src/routes/admin/orgs.tsx`, `apps/web/src/routes/admin/projects.tsx`, `apps/web/src/routes/admin/payouts.tsx`, `apps/web/src/routes/admin/reviews.tsx`, `apps/web/src/routes/admin/-reviews-ui.tsx`, `apps/web/src/components/admin-header.tsx`
> Related: [listing-lifecycle](listing-lifecycle.md), [quality-signals](quality-signals.md), [reviews](reviews.md), [earnings-payouts](earnings-payouts.md), [wallet-billing](wallet-billing.md), [webhooks-notifications](webhooks-notifications.md), [upstream-credentials](upstream-credentials.md), [accounts-orgs](accounts-orgs.md)

Staff-only `/admin` surface for Zevium operators: moderation, quality gates, user/org support, billing ops, and platform metrics. Access is an env allowlist of Clerk user ids checked server-side in Convex.

## Product

- Platform admin persona: Zevium staff. Primary surface: moderation, quality gates, support tooling.

## Flow

### Platform admin flow (staff-only, `/admin`)

- **Moderation queue**: new/updated public listings; approve / delist with reason
- **Quality dashboard**: listings failing uptime/security gates, auto-delist toggles
- **Users & orgs**: search, account state (wallet, keys, calls), suspend/ban
- **Billing ops**: top-up/refund lookup, manual credit grants (promotional credits), webhook replay
- **Platform metrics**: GMV, take, active consumers/publishers, call volume, error rates

## Tech

### Implementation notes

- **Admin gate**: platform-admin access is an env allowlist, `ADMIN_USER_IDS` (Clerk subject ids), checked server-side in Convex — no separate roles table

### Code map (observed)

- `requireAdmin` reads comma-separated `ADMIN_USER_IDS`; throws when unset/empty (fails closed — nobody is admin). `isAdmin` / `admin.isAdminQuery` is the non-throwing check the `/admin` layout uses after Convex auth loads.
- `/admin` (overview): `platformStats` — org count, projects total + draft/published, calls this month (`usageEvents` `by_at` from UTC month start, capped `USAGE_STATS_CAP = 50_000`); `recentUsage` feed + summed recent credits.
- `/admin/orgs`: `listOrgs` paginated (handle, name, slug, wallet balance).
- `/admin/projects`: `listProjects` with status/visibility filters; `setProjectVisibility` forces private/public, notifies owning org and fires `project.visibility_changed` webhook.
- `/admin/payouts`: `listPublisherTransfers`, `retryPublisherTransfer`, `reconcilePublisherTransfer`, `repairLegacyPublisherTransfer`, finance reconciliation cases (`listFinanceReconciliationCases`, `getFinanceReconciliationCase`, `resolvePublisherTransferReconciliation`, `resolveConnectAccountReconciliation`) — details in [earnings-payouts](earnings-payouts.md).
- `/admin/reviews`: review moderation, hide/restore requires a recorded reason — details in [reviews](reviews.md).
- Operator migrations behind `requireAdmin`: `migrateRegistryRollout`, `getRegistryRollout`, `securityRolloutPreflight`, `migrateSecurityRollout` — runbooks in [upstream-credentials](upstream-credentials.md) and [registry v2](../architecture/registry-v2.md).

### Runbook

- `ADMIN_USER_IDS` Convex env currently = seed test user. Set real admin Clerk user ids for prod.

## Decisions

- Admin access = env allowlist (`ADMIN_USER_IDS`), no roles table.
- 2026-07-11 — Scope: full FLOW.md parity including admin.
- Wave 8 — admin backend + `/admin` screens shipped (b77388f), browser-verified.

## Open questions

- Delist reason: FLOW requires "delist with reason"; `setProjectVisibility` takes no reason and stores none (review moderation does record reasons).
- No moderation queue of new/updated listings with approve action; `/admin/projects` is a filterable list with forced visibility.
- Quality dashboard + auto-delist toggles absent from `/admin` (quality suspension runs via cron probes; see [quality-signals](quality-signals.md)).
- Users & orgs: no search, no per-org keys/calls state, no suspend/ban.
- Billing ops: no top-up/refund lookup, no manual credit grant UI (wallet admin adjustment exists only as internal mutation `wallets.applyAdminAdjustment`), no webhook replay.
- Platform metrics: no GMV, take, active consumers/publishers, or error rates — only counts + month calls + recent credits.
- `platformStats` collects full `organizations` and `projects` tables per call; acceptable off hot path but unbounded as data grows.
- Prod: confirm `ADMIN_USER_IDS` set to real staff ids.
