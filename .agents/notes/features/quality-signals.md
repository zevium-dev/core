# Quality signals

> Status: root cutover implemented; owner activation pending · Updated: 2026-10-11
> Code: `convex/{quality,qualityProbeAction,publishReadinessAction}.ts`, `convex/lib/webhookTransport.ts`, `tests/probeSafety.test.ts`
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

Version/generation/lease-fenced quality work uses bounded probe/call windows, public-IP pinned HTTPS transport and paced fan-out. Three failing probes suspend, three consecutive passes restore desired visibility. Reachability and API success remain distinct with sample floors. Gateway samples refresh on probe completion, up to five minutes; settlement does not contend on project quality writes. Readiness binds exact draft and credential fingerprint.

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

## Decisions

- 2026-10-11 — PR #442 applies [read-surface review defaults](../decisions/2026-10-11-read-surface-review-defaults.md); owner accepted as built 2026-10-18 ([decision](../decisions/2026-10-18-review-defaults-accepted.md)).

- None recorded beyond PRODUCT.md rules above.

## Open questions

- Resolved #355: `projects.update` and `cancelRetirement` no longer erase suspension through partial document replacement.

- [roadmap](../product/roadmap.md) (former BACKLOG) "Public quality signals and automated listing gates" (probe reachability/uptime, expose latency/success/freshness, block publication on failed gates) is largely built in code; backlog stale. Remaining: per-API status surfaces.
- Resolved #331: catalogue cards and the publisher Quality tab now reuse detail-page quality badges with the same evidence floors.
- FLOW detail header lists "latency p50, success rate, uptime, freshness"; code shows API success + p50, reachability % + p50, data freshness. "Freshness" in code = measurement recency, not spec recency.
- No admin quality dashboard or auto-delist toggle UI (admin can force project private via `admin.setProjectVisibility`).
- `listPublicIncidents` and listing subscriptions have no web caller; per-API status pages (P2 #18) not built. Security scanning: no code.
- Broader quality grades and cost per successful call remain undecided.
