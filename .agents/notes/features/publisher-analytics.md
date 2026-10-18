# Publisher analytics

> Status: root cutover implemented; owner activation pending · Updated: 2026-10-11
> Code: `convex/{analytics,earnings,usage}.ts`, `convex/money/rollups.ts`, `apps/web/src/lib/analytics-view.ts`, `tests/readSurfaces.test.ts`
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

Accepted settlement commits exact financial/call rollups once per ref. Summary queries use finite shard fan-in; project analytics use indexed project/day rows. Execution-day analytics and acceptance-day risk inventory are separate. p50/p95/p99 are labeled histogram bounds, overflow 30 seconds or more. Detail scans are bounded and marked partial; newest-day billing caps and per-project earnings remain scoped. Member usage redacts peers; earnings/analytics aggregates require org admin.

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

## Decisions

- 2026-10-11 — PR #442 applies [read-surface review defaults](../decisions/2026-10-11-read-surface-review-defaults.md); owner accepted as built 2026-10-18 ([decision](../decisions/2026-10-18-review-defaults-accepted.md)).

- Wave 4 — analytics dashboards shipped (web+convex, commit 632f6ed).
- 2026-10-10 — ACCEPTED: two roles for now, admin + member (owner treated as admin); full permission-based access later. [decision](../decisions/2026-10-10-two-roles-admin-member.md) Analytics is admin-only — code correct, FLOW wrong.

## Open questions

- Doc/code conflict: TECH says p95/p99 come from cron rollup tables; code has no usage rollup table or cron — percentiles computed in-query over a capped (10k) `usageEvents` scan. Code wins; fix TECH or build rollups before volume exceeds cap.
- Consumers block (count, top consumers anonymized, retention) not in code — PRODUCT "per-consumer usage" unmet.
- Error breakdown lacks `upstream-timeout` class; only 4xx / 5xx.
- Revenue trend over time not exposed (only range totals + per-endpoint credits; `callsByDay` is calls only).
- Route: FLOW `.../projects/{project}/analytics`; code is a tab on `/app/projects/$projectSlug?tab=analytics`.
