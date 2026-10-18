# Webhooks & notifications

> Status: root cutover implemented; owner activation pending · Updated: 2026-10-18
> Code: `convex/{webhooks,webhookDeliveryAction,notifications,notificationEmail,notificationEmailAction}.ts`, `convex/lib/notifications.ts`, `convex/lifecycleNotices.ts`, `tests/readSurfaces.test.ts`
> Related: [wallet-billing](wallet-billing.md) (spend alerts, budget webhooks), [listing-lifecycle](listing-lifecycle.md), [upstream-credentials](upstream-credentials.md) (webhook signing-secret encryption), [earnings-payouts](earnings-payouts.md), [quality-signals](quality-signals.md), [accounts-orgs](accounts-orgs.md), [roadmap](../product/roadmap.md)

> Email (#320): built, dormant until configured. Code: `convex/notificationEmail.ts`, `convex/notificationEmailAction.ts`, `convex/lib/notificationEmail.ts`, `convex/notificationEmail.test.ts`.

Two outbound channels. Publisher webhooks: one signed HTTPS endpoint per project receiving listing events, with retries and a delivery log. Notifications: org-scoped email + in-app messages for account, billing, lifecycle, and payout events. Consumer spend alerts and budget webhooks belong to [wallet-billing](wallet-billing.md).

## Product

- Roadmap P1 #16: Publisher webhooks (new consumer, usage spike, revenue milestone, abnormal-traffic alert) — see [roadmap](../product/roadmap.md)
- Consumer billing transparency includes spend alerts at 50/75/100% thresholds and budget webhooks (P1 #12) — owned by [wallet-billing](wallet-billing.md)

## Flow

### Publisher webhooks (P1) — project Settings

- Org admins configure the signed endpoint and read its signing secret; members can review delivery history
- Subscribe to: new consumer, usage spike / abnormal traffic, revenue milestone, key revoked

### Notifications (cross-cutting)

- **Notifications (email + in-app)**: verification, invitations, budget thresholds, deprecation/sunset notices, payout notices, listing-status changes

## Tech

`apps/web/src/components/project/webhooks-card.tsx` tracks revealed secret/version in state and clears superseded/deleted secrets before render; the matching rotation metadata echo retains its one-time secret.

Publisher webhook secrets are encrypted generations with one-time reveal and grace; delivery uses durable leases, bounded retries and pinned public HTTPS. Endpoint/history and webhook-failure notices are admin-only. Org-scoped inbox/preferences and permanent per-notification/revision/user email receipts survive provider retention. Low-balance alerts fire only on downward crossings of 1,000 and re-arm after replenishment. Lifecycle email excludes edits and fan-out is paced. Missing RESEND_API_KEY leaves email dormant; queued provider messages require separate cancellation. Email links use `APP_ORIGIN` with no fallback: `emailConfig()` in `convex/lib/notificationEmail.ts` returns null unless key, sender and a valid origin (`convex/lib/appOrigin.ts`: HTTPS or loopback HTTP) are all set, so a missing/invalid origin marks the email `skipped` and logs a config error (`tests/notificationEmailReview.test.ts`).

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

## Decisions

- 2026-10-11 — PR #442 applies [read-surface review defaults](../decisions/2026-10-11-read-surface-review-defaults.md); owner accepted as built 2026-10-18 ([decision](../decisions/2026-10-18-review-defaults-accepted.md)).

- 2026-10-11 — Preserve durable notification/reconciliation facts in the 34-table isolated rebuild. [Decision](../decisions/2026-10-11-convex-rebuild-durable-facts.md).
- 2026-10-18 — ACCEPTED (built): without a valid web origin, notification email is skipped and a config error logged; no guessed link. [Decision](../decisions/2026-10-18-app-origin-fail-closed.md).

- 2026-07-11 — Scope: full FLOW.md parity including webhooks and notifications.
- Wave 8 — notifications + webhooks backend (86 tests, b77388f); bell + webhooks card UI browser-verified.
- Payout notification kinds added (BACKLOG completed findings).
- 2026-10-10 — ACCEPTED: two roles for now, admin + member (owner treated as admin); full permission-based access later. [decision](../decisions/2026-10-10-two-roles-admin-member.md) Delivery history is admin-only — code correct.
- 2026-10-10 — ACCEPTED: email via Resend; #320 implemented, activation awaits owner configuration. [decision](../decisions/2026-10-10-email-resend.md)

## Open questions

- Event-set conflict: FLOW/PRODUCT subscribe list (new consumer, usage spike / abnormal traffic, revenue milestone, key revoked) not implemented; code fires only spec/project lifecycle + visibility events and has no per-event subscription selection. Code wins; FLOW describes target.
- Budget thresholds: only `low_balance` kind exists, no 50/75/100% kinds — track in [wallet-billing](wallet-billing.md).
- Webhook secret rotation grace (1h default, 24h max) and `x-zevium-secret-version` header are undocumented in TECH.
