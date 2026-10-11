# Platform admin

> Status: root cutover implemented; owner activation pending · Updated: 2026-10-11
> Code: `convex/{admin,operators}.ts`, `apps/web/src/components/operator-console.tsx`, `apps/web/src/routes/admin/operations.tsx`, `tests/readSurfaces.test.ts`
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

The staff-only exception console is always available after cutover; no preview switch. Realtime paged cases/evidence, frozen wallets and needs_review payments expose verified provider adoption/quarantine, signed-final evidence recovery, exception resolution/void, same-generation retries, wakes and drained/no-effect admin-close abandonment. Irreversible actions confirm wallet/case, amount, effect and audit note. Server allowlist checks are mandatory; resolution never invents debits/earnings or bypasses drain. Details expand inline, so no list/detail transition is needed.

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

## Decisions

- 2026-10-11 — PR #442 applies [read-surface review defaults](../decisions/2026-10-11-read-surface-review-defaults.md), pending owner sign-off.

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
