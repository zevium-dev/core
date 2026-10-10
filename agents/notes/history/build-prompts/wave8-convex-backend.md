Task: wave-8 backend — notifications, publisher webhooks, version deprecation, platform admin. Write scope: convex/ ONLY (schema.ts, new modules, crons, tests). Do NOT touch convex/billing.ts, convex/wallets.ts, convex/http.ts if another lane's changes are present — REBASE-SAFE: only ADD new files/functions; the only shared file you may edit is convex/schema.ts (add tables/fields, never remove) and convex/crons.ts (create if missing).

Read first: AGENTS.md (convex rules: indexes, no table scans, ledger pattern), TECH.md, FLOW.md 4.9/4.10/6/7, convex/schema.ts, convex/lib/auth.ts (requireOrgMemberBySlug etc.), convex/specs.ts, convex/analytics.ts.

PRODUCT DECISIONS (locked — implement exactly):

A. NOTIFICATIONS (in-app):

- Table notifications: {clerkOrgId: string, kind: union("low_balance","spec_published","version_deprecated","webhook_failed"), title, body, refId: string (idempotency), readAt?: number, createdAt: number} index by_org ["clerkOrgId","createdAt"], by_ref ["refId"].
- internal createNotification (idempotent by refId), public listForOrg (auth member, paginated newest first, unreadCount), markRead (id), markAllRead.
- Producers: (1) cron hourly low-balance check: wallets with balance < 1000 credits → notify refId low_balance:{orgId}:{utcDay} (once/day/org); (2) specs.publish success → spec_published notification (add a small internal call — you may add an internal fn and call it from specs.publish; keep the publish signature unchanged); (3) deprecation (below) → version_deprecated to the PUBLISHER org.

B. PUBLISHER WEBHOOKS:

- Table webhookEndpoints: {projectId, url, secret, active: boolean, createdAt} index by_project. One endpoint per project (mutation upsert semantics), CRUD auth = org member owning project. URL must be https (allow http://localhost for dev).
- Table webhookDeliveries: {endpointId, event: string, status: union("pending","ok","failed"), attempts: number, lastError?: string, createdAt, payload: string} index by_endpoint ["endpointId","createdAt"].
- Events fired: spec.published {projectId, version}, project.visibility_changed {projectId, visibility}. Fire = schedule action deliverWebhook via ctx.scheduler after the mutating op; delivery action POSTs JSON {event, data, timestamp} with headers x-zevium-signature: hex HMAC-SHA256(secret, body) (WebCrypto), x-zevium-event. Timeout 10s. Retry: up to 3 attempts, backoff 60s/300s via scheduler re-run; after final failure mark failed + webhook_failed notification (refId webhook_failed:{deliveryId}).
- Queries: getEndpoint(projectId), listDeliveries(projectId, paginated).

C. VERSION DEPRECATION:

- specVersions add optional fields: deprecatedAt?: number, sunsetAt?: number, deprecationMessage?: string.
- Mutation specs.deprecateVersion {versionId, sunsetAt?, message?} + specs.undeprecateVersion {versionId} (auth publisher org member). Immutability rule intact — spec content never changes; deprecation is metadata.
- specs.getPublishedForGateway + catalogue getPublicDetail: include deprecation metadata of the served/latest version.
- Fires version_deprecated notification + webhook event spec.deprecated {projectId, version, sunsetAt}.

D. PLATFORM ADMIN:

- Auth: convex env ADMIN_USER_IDS (comma-separated Clerk user ids). lib/auth.ts add requireAdmin(ctx) (identity subject in list; fail closed if env unset). Query admin.isAdmin (returns boolean, safe for any authed user).
- Queries (all requireAdmin, all bounded/paginated, use indexes): admin.platformStats (orgs count, projects count by status, total usageEvents count this month via by_org_at per org is a scan — instead maintain nothing fancy: aggregate over usageEvents by _creationTime bounded to month via .withIndex on a NEW index by_at ["at"]; cap + note), admin.listOrgs (org + wallet balance, paginated), admin.listProjects (paginated, filter status/visibility), admin.recentUsage (newest 100 events via by_at).
- Mutation admin.setProjectVisibility {projectId, visibility} (kill switch for bad actors) — logs a notification to the org.

TESTS (mandatory, convex-test): notifications idempotency + auth; webhook endpoint CRUD auth + delivery state machine (inject fetch — extract delivery HTTP into injectable helper); deprecation auth + metadata + gateway query includes it; admin gate (non-admin rejected, env unset rejected), stats shape. Register crons in convex/crons.ts.

VERIFY: pnpm test:convex green, npx convex dev --once clean, pnpm typecheck green (root may have other lanes' web changes — only require convex tsc clean if root fails outside convex/).
Output: CHANGED list, VERIFY results, DONE or BLOCKED.
