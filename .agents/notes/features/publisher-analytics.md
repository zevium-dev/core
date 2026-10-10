# Publisher analytics

> Status: partial (P0) · Updated: 2026-10-10
> Code: `convex/analytics.ts` (`projectAnalytics`, `orgOverview`), `convex/usage.ts`, `convex/usage.test.ts`, `apps/web/src/routes/app/projects/$projectSlug.tsx` (`ProjectAnalyticsPanel`, `?tab=analytics&range=`), `apps/web/src/lib/analytics-view.ts`
> Related: [wallet-billing](wallet-billing.md) (usage ingest pipe), [gateway](gateway.md), [earnings-payouts](earnings-payouts.md), [quality-signals](quality-signals.md), [accounts-orgs](accounts-orgs.md), [roadmap](../product/roadmap.md)

Per-project dashboards for publishers: calls, revenue, tail latency, and error breakdown per endpoint, live-updating. Built from per-call usage events emitted by the gateway. Positioned to beat the dead incumbent's analytics. Usage events arrive through the usage ingest pipe owned by [wallet-billing](wallet-billing.md).

## Product

- **Analytics that beat the dead incumbent**: per-endpoint tail latency (p95/p99), error-type breakdown, per-consumer usage, revenue trends
- Roadmap P0 #6: Publisher analytics (calls, revenue, p95/p99, error breakdown) — see [roadmap](../product/roadmap.md)
- Publishers see calls, revenue, and performance per endpoint — without running any billing infrastructure.

## Flow

### Publisher analytics — `.../projects/{project}/analytics`

- Calls over time per endpoint, success rate, error-type breakdown (4xx / 5xx / upstream-timeout)
- Latency: p50 / p95 / p99 per endpoint
- Consumers: count, top consumers by calls (anonymized), retention
- Revenue: credits earned per endpoint per period
- Live-updating — dashboards tick per DESIGN.md "alive" (see [design system](../design/design-system.md))

Publisher golden path step: "watch Analytics tick (calls, p95, errors, revenue)".

## Tech

- **Shared presentation (#363)**: daily and endpoint tables use stock shadcn Table; day labels use shared UTC `lib/format.ts`. Visibility mutations rely on Convex subscriptions without manual cache invalidation.

### Domain

- `usageEvents` (per-call: project, endpoint, org, credits, latency, status) + rollup tables via cron (publisher analytics p95/p99 come from here)

### Code map (observed)

- `analytics.projectAnalytics({ orgSlug, projectSlug, rangeDays })`: `requireOrgMemberBySlug` then `requireOrgAdmin`. `rangeDays` default 7, clamped to ≤90; UI offers 7 / 30 / 90 (`ANALYTICS_RANGES`). Scans `usageEvents` `by_project_at` from UTC day window start, capped at `PROJECT_SCAN_CAP = 10_000` (`truncated` flag returned).
- Returns: `calls`, `credits`, `netCredits` (publisher net after platform fee), `successRate`, `p50`/`p95`/`p99`, `errors4xx`, `errors5xx`, per-endpoint `EndpointStats` (method, endpoint, calls, credits, errors4xx, errors5xx, success, p50/p95/p99), `callsByDay` (oldest→newest, length `rangeDays`).
- Percentiles: linear-interpolated over sorted latencies, computed in-query. Status classes: 2xx–3xx ok, 4xx, 5xx, other.
- Live updates come from Convex query reactivity (no polling).
- `analytics.orgOverview` (wallet + today/cycle usage + recent 20, `ORG_SCAN_CAP = 5_000`) feeds the consumer `/app` dashboard, not publisher analytics.

## Decisions

- Wave 4 — analytics dashboards shipped (web+convex, commit 632f6ed).
- 2026-10-10 — ACCEPTED: two roles for now, admin + member (owner treated as admin); full permission-based access later. [decision](../decisions/2026-10-10-two-roles-admin-member.md) Analytics is admin-only — code correct, FLOW wrong.

## Open questions

- Doc/code conflict: TECH says p95/p99 come from cron rollup tables; code has no usage rollup table or cron — percentiles computed in-query over a capped (10k) `usageEvents` scan. Code wins; fix TECH or build rollups before volume exceeds cap.
- Consumers block (count, top consumers anonymized, retention) not in code — PRODUCT "per-consumer usage" unmet.
- Error breakdown lacks `upstream-timeout` class; only 4xx / 5xx.
- Revenue trend over time not exposed (only range totals + per-endpoint credits; `callsByDay` is calls only).
- Route: FLOW `.../projects/{project}/analytics`; code is a tab on `/app/projects/$projectSlug?tab=analytics`.
