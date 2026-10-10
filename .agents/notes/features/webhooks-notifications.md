# Webhooks & notifications

> Status: partial (#363 list/presentation and #397 heading fixes complete) (P1) · Updated: 2026-10-10
> Code: `convex/projects.ts` (`update`), `convex/admin.ts` (`setProjectVisibility`), `convex/project-visibility-webhooks.test.ts`, `convex/webhooks.ts`, `convex/webhookDeliveryAction.ts`, `convex/lib/webhookDelivery.ts`, `convex/webhooks.test.ts`, `convex/notifications.ts`, `convex/lib/notifications.ts`, `convex/notifications.test.ts`, `apps/web/src/components/project/webhooks-card.tsx`, `apps/web/src/components/project/webhook-deliveries.tsx`, `apps/web/src/components/webhook-secret.test.tsx`, `apps/web/src/components/notification-bell.tsx`, `apps/web/src/routes/docs/publishing.tsx` (Webhooks section), `apps/web/src/components/project-settings-panel.tsx`
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

- **Realtime bell (#363)**: `usePaginatedQuery(listForOrg)` keeps every loaded page reactive, including mark-read/all-read changes. `unreadForOrg` subscribes to the whole-org count independently of loaded rows; both queries share the same bounded legacy count fallback. Switching organizations remounts bell UI and resets pagination. No cached older pages or optimistic local read timestamps.
  **Dogfood — 2026-10-10**

- **P1 #393:** normal publisher visibility changes do not emit the documented webhook event. The admin mutation emits it, but `projects.update` does not. A local `spec.published` webhook delivered successfully in one attempt.
  Evidence, workarounds and scope: [dogfood findings](../findings/dogfood-2026-10-10.md).

### Implementation notes

- **Fresh deployment (#354)**: removed legacy secret migration pages and security-rollout generation writes. Secret reveal, rotation/grace, encrypted storage, and delivery leases remain.
- **Settings hierarchy (#397)**: Webhooks is a level 2 heading; Recent deliveries is level 3 beneath it. Loading/error headings retain level 2. See [publishing-specs](publishing-specs.md) for the project settings hierarchy and tests.
- Webhook settings use project-keyed local field overrides; realtime endpoint metadata and rotations preserve typed URL/active edits. `revealedSecretVersionRef` keeps a returned secret visible through its own metadata push, clears it on a newer secret version, and never re-reveals hidden plaintext.

- **Publisher webhook egress**: delivery-time validation is authoritative. Node HTTPS resolves every hop, rejects any non-public address in the complete DNS answer, and pins the TLS socket to one validated address while retaining the URL hostname for SNI, certificate verification, and `Host`. Same-origin redirects resolve and pin again; cross-origin redirects are rejected before forwarding signed payload. Connect/header/body/overall deadlines and bounded response draining prevent slow or oversized receivers from consuming unbounded action resources.
- **Publisher webhooks**: HMAC-SHA256 signed (`x-zevium-signature` header, hex digest over the raw body), delivered with up to 3 attempts and backoff of 60s then 300s between retries before marking a delivery failed

### Code map (observed)

- Tables: `webhookEndpoints` (one per project, `by_project`), `webhookDeliveries`, `notifications` (org-scoped by `clerkOrgId`, idempotent by `refId`; indexes `by_org`, `by_org_read`, `by_ref`).
- `fireWebhookEvent(ctx, projectId, event, data)`: no-op when org inactive or endpoint missing/inactive; inserts pending delivery, schedules `webhookDeliveryAction.deliverWebhook`.
- Events fired in code: `spec.published` (`specs.ts`), `spec.deprecated` (`specs.ts`), `project.deprecated`, `project.deprecation_canceled` (`projects.ts`), `project.visibility_changed` (`projects.update`, `admin.setProjectVisibility`).
- **Visibility events (#393)**: publisher and staff mutations atomically enqueue one `project.visibility_changed` delivery per actual visibility transition, with data `{ projectId, visibility }`. Unchanged/retried updates, metadata-only edits, and rejected changes enqueue none; missing/inactive endpoints retain the existing no-op behavior. Staff retries also skip duplicate notifications. `project-visibility-webhooks.test.ts` covers both publisher write branches, both directions, staff overrides, retries, auth/lifecycle rejection, and endpoint availability.
- `/docs/publishing` lists all five emitted event types, including project retirement scheduling/cancellation and the visibility payload.
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
- Budget thresholds: only `low_balance` kind exists, no 50/75/100% kinds — track in [wallet-billing](wallet-billing.md).
- Webhook secret rotation grace (1h default, 24h max) and `x-zevium-secret-version` header are undocumented in TECH.
