# Webhooks & notifications

> Status: partial (P1) · Updated: 2026-10-10
> Code: `convex/webhooks.ts`, `convex/webhookDeliveryAction.ts`, `convex/lib/webhookDelivery.ts`, `convex/webhooks.test.ts`, `convex/notifications.ts`, `convex/lib/notifications.ts`, `convex/notifications.test.ts`, `apps/web/src/components/project-settings-panel.tsx`, `apps/web/src/components/webhook-secret.test.tsx`, `apps/web/src/components/notification-bell.tsx`, `apps/web/src/routes/docs/publishing.tsx` (Webhooks section)
> Related: [wallet-billing](wallet-billing.md) (spend alerts, budget webhooks), [listing-lifecycle](listing-lifecycle.md), [upstream-credentials](upstream-credentials.md) (webhook signing-secret encryption), [earnings-payouts](earnings-payouts.md), [quality-signals](quality-signals.md), [accounts-orgs](accounts-orgs.md), [roadmap](../product/roadmap.md)

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

### Implementation notes

- **Publisher webhook egress**: delivery-time validation is authoritative. Node HTTPS resolves every hop, rejects any non-public address in the complete DNS answer, and pins the TLS socket to one validated address while retaining the URL hostname for SNI, certificate verification, and `Host`. Same-origin redirects resolve and pin again; cross-origin redirects are rejected before forwarding signed payload. Connect/header/body/overall deadlines and bounded response draining prevent slow or oversized receivers from consuming unbounded action resources.
- **Publisher webhooks**: HMAC-SHA256 signed (`x-zevium-signature` header, hex digest over the raw body), delivered with up to 3 attempts and backoff of 60s then 300s between retries before marking a delivery failed

### Code map (observed)

- Tables: `webhookEndpoints` (one per project, `by_project`), `webhookDeliveries`, `notifications` (org-scoped by `clerkOrgId`, idempotent by `refId`; indexes `by_org`, `by_org_read`, `by_ref`).
- `fireWebhookEvent(ctx, projectId, event, data)`: no-op when org inactive or endpoint missing/inactive; inserts pending delivery, schedules `webhookDeliveryAction.deliverWebhook`.
- Events fired in code: `spec.published` (`specs.ts`), `spec.deprecated` (`specs.ts`), `project.deprecated`, `project.deprecation_canceled` (`projects.ts`), `project.visibility_changed` (`admin.setProjectVisibility`).
- Delivery body `{ id, event, data, timestamp }`; headers `x-zevium-event`, `x-zevium-signature`, `x-zevium-secret-version`, `X-Zevium-Delivery-Id`. Constants `MAX_WEBHOOK_ATTEMPTS = 3`, `WEBHOOK_BACKOFF_SECONDS = [60, 300]`.
- Endpoint API: `upsertEndpoint`, `getEndpoint` (metadata only), `revealSecret`, `rotateSecret` (grace default 1h, max 24h), `deleteEndpoint` — all project-admin gated; `listDeliveries` requires privileged org role.
- Notification kinds: `low_balance`, `spec_published`, `version_deprecated`, `project_retirement`, `webhook_failed`, `visibility_changed`, `transfer_failed`, `transfer_sent`, `quality_suspended`, `quality_restored`. API: `listForOrg`, `markRead`, `markAllRead` (paged internal `markAllReadPage`). UI: header bell (`notification-bell.tsx`).
- Webhook signing secrets stored as encrypted envelopes — see [upstream-credentials](upstream-credentials.md) "Publisher secrets".

## Decisions

- 2026-07-11 — Scope: full FLOW.md parity including webhooks and notifications.
- Wave 8 — notifications + webhooks backend (86 tests, b77388f); bell + webhooks card UI browser-verified.
- Payout notification kinds added (BACKLOG completed findings).
- 2026-10-10 — ACCEPTED: two roles for now, admin + member (owner treated as admin); full permission-based access later. [decision](../decisions/2026-10-10-two-roles-admin-member.md) Delivery history is admin-only — code correct.
- 2026-10-10 — ACCEPTED (not built): email via Resend; API key pending from user. [decision](../decisions/2026-10-10-email-resend.md)

## Open questions

- Event-set conflict: FLOW/PRODUCT subscribe list (new consumer, usage spike / abnormal traffic, revenue milestone, key revoked) not implemented; code fires only spec/project lifecycle + visibility events and has no per-event subscription selection. Code wins; FLOW describes target.
- In-app docs (`/docs/publishing`) list only `spec.published`, `spec.deprecated`, `project.visibility_changed`; code also fires `project.deprecated` and `project.deprecation_canceled`.
- Budget thresholds: only `low_balance` kind exists, no 50/75/100% kinds — track in [wallet-billing](wallet-billing.md).
- Webhook secret rotation grace (1h default, 24h max) and `x-zevium-secret-version` header are undocumented in TECH.
