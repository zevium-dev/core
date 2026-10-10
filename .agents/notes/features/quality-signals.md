# Quality signals

> Status: partial (P0 #7 quality signals mostly built; credential readiness mismatch #389 fixed; P2 #18 security scan + status pages not built) · Updated: 2026-10-10
> Code: `convex/projects.ts`, `convex/project-authorization.test.ts`, `convex/project-retirement.test.ts`, `convex/quality.ts`, `convex/qualityProbeAction.ts`, `convex/publishReadiness.ts`, `convex/publishReadinessAction.ts`, `convex/lib/qualityContract.ts`, `convex/wallets.ts` (`gatewayQualitySamples` insert), `convex/crons.ts` (`probe-published-upstreams`), `packages/shared/src/quality.ts`, `packages/shared/src/openapi.ts` (`extractHealthCheckTarget`), `apps/web/src/components/quality-badges.tsx`, `apps/web/src/components/catalogue-detail.tsx`, `convex/publishReadiness.test.ts`
> Related: [publishing-specs](publishing-specs.md), [listing-lifecycle](listing-lifecycle.md), [catalogue-search](catalogue-search.md), [platform-admin](platform-admin.md), [gateway](gateway.md), [webhooks-notifications](webhooks-notifications.md), [roadmap](../product/roadmap.md)

Listing quality is measured and enforced. Catalogue listings carry evidence-based badges (real-call latency, real-call success rate, declared-health reachability, freshness), publication is gated by a reachable declared health endpoint, and repeated health failures suspend a listing until bounded recovery. Curation and quality gates matter more than raw catalogue size.

## Product

- **Listing quality is enforced**: uptime monitoring and (later) security scanning gate what stays listed.
- **Catalogue with quality signals** (badge part; search part in [catalogue-search](catalogue-search.md)): real-call latency, real-call success rate, declared-health reachability, and freshness badges per listing. A badge says "insufficient data" until its evidence floor is met; absence never renders as 0%. Reachability never claims paid API operations succeed.
- **Publishing model**: auto-publish with automated gates (spec valid plus an explicitly declared safe health endpoint that is reachable and ready) + post-hoc staff review. Repeated declared-health failures suspend listing and calls, tell publisher why, and restore access only after bounded recovery. No pre-approval queue.
- Non-goal: open unmoderated long-tail listing (curation and quality gates matter more than raw catalogue size).
- Roadmap ([roadmap](../product/roadmap.md)):
  - P0 #7 — Catalogue quality signals (latency, success rate, freshness) + semantic search.
  - P2 #18 — Security-scan + uptime badges as listing gates; per-API status pages (component-level uptime, subscribable).

### Research ideas — not decided

Source: [agent-api-marketplace-landscape](../research/agent-api-marketplace-landscape.md#trust-sell-your-agent-cannot-overspend-and-measured-quality).

- **Quality measured at the gateway** as neutral grading: publish success rate, p95 latency, uptime, and **cost per successful call** per operation. Report contrast: Arcade+Smithery lost neutrality; Glama grades on stars/downloads.
- **Search ranking (#330)** now breaks relevance ties with fresh, sufficient gateway API success/latency measurements; contract owned by [catalogue-search](catalogue-search.md). Broader grades remain research.
- Report places "measured quality" in the "Now" horizon (trust is the product at zero users).

## Flow

- Catalogue listing cards and API detail header show quality badges (latency p50, success rate, uptime, freshness) — screens in [catalogue-search](catalogue-search.md).
- Spec editor (org admins): connection gate before Publish ([publishing-specs](publishing-specs.md)).
- **Quality tab** on the publisher project page: current published version’s metrics, latest health probes, suspension reason, consecutive recovery progress, and steps to restore access. Available to all members of the owning organization, including while private or suspended. Security scans and freshness nudges remain P2.
- **Platform admin** `/admin` — **Quality dashboard**: listings failing uptime/security gates, auto-delist toggles ([platform-admin](platform-admin.md)).
- Notifications: listing-status changes ([webhooks-notifications](webhooks-notifications.md)).

## Tech

- **Quality state ownership (#355)**: metadata edits and retirement cancellation preserve `qualityStatus`, suspension time/reason, recovery passes, `desiredVisibility`, and `publicationGeneration`. Only the quality workflow restores a suspended listing. Regression coverage: `convex/project-authorization.test.ts` and `convex/project-retirement.test.ts`.

No TECH.md bullet covers quality signals. Code facts (read from source 2026-10-10):

- **Health-check declaration**: exactly one parameter-free `GET`/`HEAD` operation marked `x-zevium-health-check: true`, absolute path, no `{}`/`?`/`#` (`extractHealthCheckTarget`); URL joined onto `servers[0].url`.
- **Publish gate**: `publishReadinessAction.testConnection` (org admin only, `"use node"`) calls `probePublicHttps` without publisher credentials and outside metering/earnings. Only 2xx/3xx records a passing test (`recordPassingTest`) bound to saved-draft SHA-256; valid `READINESS_TTL_MS` = 15 min. `specs.publish` refuses without a current pass. Result statuses: `ready`, `reachable_unhealthy`, `blocked_target`, `timeout`, `unreachable`, `missing_health_check`.
- **Credential binding (#389)**: `recordPassingTest`, `getCurrent`, and `specs.publish` share `credentialRevision` (`max(revision ?? updatedAt)`, 0 for no credentials) and `credentialSetFingerprint` (sorted identity, name, revision, timestamp). This keeps the editor and publish gate consistent for current and legacy rows; credential additions, rotations, and removals invalidate the pass even when the aggregate revision stays unchanged. Tests reproduce save draft → attach `X-Dogfood-Token` → passing credential-free health action → publish `0.0.1`, plus legacy rows and change/retest recovery.
- **Probe safety** (`qualityProbeAction.ts`): HTTPS only, public IPv4/IPv6 only, DNS pin checked against remote address, `PROBE_TIMEOUT_MS` 8s, `MAX_PROBE_REDIRECTS` 2. Outcomes: `healthy`, `http_error`, `timeout`, `dns_error`, `tls_error`, `network_error`, `blocked_target`.
- **Scheduled probes**: cron every 5 min → `quality.runDueProbes` leases up to `PROBE_BATCH_SIZE` 20 targets (`qualityProbeTargets`, lease 60s, `PROBE_INTERVAL_MS` 5 min); results idempotent by `executionId` in `qualityProbeResults`; stale version/generation results dropped.
- **Snapshot** (`qualitySnapshots`, one per project, current published version only; each version starts fresh): reachability over last 24 probes, floor 3 samples (`reachabilityPercent` = any HTTP response); API success/latency p50 over last 100 `gatewayQualitySamples` (privacy-minimized real gateway outcomes written in `wallets.ts`), floor 20; freshness `stale` after 30 min since last measurement. Contract `QualitySnapshotContract` in shared; below floor returns `null` metrics + `insufficient*Data: true`.
- **Suspension/recovery**: incident opens when ≥3 of last 5 probes non-healthy (`qualityIncidents`); project forced `visibility: "private"`, `qualityStatus: "suspended"`, `desiredVisibility` remembered, `quality_suspended` notification with reason. 3 consecutive healthy probes resolve incident, restore desired visibility, `quality_restored` notification. Intermediate state `recovering` stays unlisted.
- Public queries: `quality.getPublicSnapshot`, `quality.listPublicIncidents`; snapshot also embedded in `catalogue.listPublic`/`getPublicDetail`/search results. Subscriptions `quality.setSubscription`/`listSubscriptions`/`subscriberCount` on `listingSubscriptions`.
- **Catalogue projection (#331)**: `syncCatalogueListing` copies bounded current-version aggregate evidence into `catalogueListings.quality`; normal browse pages map the projection directly with no per-card snapshot/version reads. Compatibility browse and semantic hydration also read projected quality. Probe results, gateway recomputation and initial target setup refresh it; republishing clears old-version evidence. Freshness is derived on read, never frozen at projection time. Existing rows gain evidence on the next quality sync; `internal.catalogue.backfillCatalogueListingsPage({ cursor: null })` can populate all existing rows immediately.
- **Delivery (#331): built.** Publisher UI: `apps/web/src/components/project-quality-panel.tsx`; UI regressions: `catalogue-card-quality.test.tsx` and `project-quality-panel.test.tsx` in the same components directory.
- **Publisher query (#331)**: `quality.getPublisherQuality` uses `requireProjectMember`, returns the same `qualitySnapshotContract` as public detail, reads at most 24 current-version probes via `by_project_version_checked`, and returns suspension/recovery state. No raw gateway samples, execution IDs, or upstream URLs are exposed. UI uses a realtime Convex query, skeleton and sanitized retry state.
- UI: `QualityBadges` renders "API quality: insufficient data (n/20)", "Reachability: insufficient data (n/3)", "Data fresh|stale"; shared by API detail, catalogue cards (compact mode), and the publisher Quality tab. Finite-number guards prevent missing percentages/latencies from rendering as `undefined` or `NaN`.

## Decisions

- None recorded beyond PRODUCT.md rules above.

## Open questions

- Resolved #355: `projects.update` and `cancelRetirement` no longer erase suspension through partial document replacement.

- [roadmap](../product/roadmap.md) (former BACKLOG) "Public quality signals and automated listing gates" (probe reachability/uptime, expose latency/success/freshness, block publication on failed gates) is largely built in code; backlog stale. Remaining: per-API status surfaces.
- Resolved #331: catalogue cards and the publisher Quality tab now reuse detail-page quality badges with the same evidence floors.
- FLOW detail header lists "latency p50, success rate, uptime, freshness"; code shows API success + p50, reachability % + p50, data freshness. "Freshness" in code = measurement recency, not spec recency.
- No admin quality dashboard or auto-delist toggle UI (admin can force project private via `admin.setProjectVisibility`).
- `listPublicIncidents` and listing subscriptions have no web caller; per-API status pages (P2 #18) not built. Security scanning: no code.
- Broader quality grades and cost per successful call remain undecided.
