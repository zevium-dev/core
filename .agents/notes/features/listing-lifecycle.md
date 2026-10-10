# Listing lifecycle

> Status: partial (P1 #15 deprecation/retirement built; P2 #19 version pinning + spec-diff changelog not built) · Updated: 2026-10-10
> Code: `convex/projects.ts` (`scheduleRetirement`, `cancelRetirement`, `remove`, `retire`, `retireSunsetProjects`, `notifyRetirementConsumersPage`), `convex/specs.ts` (`publish`, `deprecateVersion`, `undeprecateVersion`), `convex/quality.ts` (`setSubscription`), `convex/lib/publicRoutes.ts`, `convex/deprecation.test.ts`, `convex/project-retirement.test.ts`, `convex/project-lifecycle.test.ts`, `apps/gateway/src/pipeline.ts`, `apps/gateway/src/mock.ts`, `apps/web/src/components/project/visibility-card.tsx`, `apps/web/src/components/project/danger-zone.tsx`, `apps/web/src/components/spec-editor/rail-versions.tsx`, `apps/web/src/components/spec-editor/version-lifecycle-dialogs.tsx`
> Related: [publishing-specs](publishing-specs.md), [quality-signals](quality-signals.md), [gateway](gateway.md), [webhooks-notifications](webhooks-notifications.md), [catalogue-search](catalogue-search.md), [registry-v2](../architecture/registry-v2.md), [roadmap](../product/roadmap.md)

How a listing moves through publish, deprecate/unpublish and terminal archive without silently breaking consumers. A publisher cannot kill an API with active consumers: removal requires a notice window, response signaling and consumer notices; archived URLs stay reserved as tombstones.

## Product

- **Lifecycle safety**: a publisher cannot silently kill an API with active consumers. Unpublish triggers a mandatory 7-day notice window (deprecation notices to consumers, standard deprecation signaling on responses), new subscriptions freeze, existing calls honored through wind-down.
- Roadmap ([roadmap](../product/roadmap.md)):
  - P1 #15 — Deprecation/unpublish lifecycle (notice window, response signaling, consumer notifications).
  - P2 #19 — Version pinning per key (consumers stay on the spec version they integrated against) + spec-diff changelog tool.

## Flow

FLOW 4.9 Listing lifecycle (quality surface lives in [quality-signals](quality-signals.md)):

- Organization owners/admins alone may change visibility, publish, deprecate, or permanently archive a listing. Members may edit mutable drafts and metadata.
- **Publish**: auto-publish with automated gates (spec valid, upstream reachable, uptime probe); post-hoc review may delist. Gate detail: [quality-signals](quality-signals.md).
- **Deprecate/unpublish (P1)**: cannot silently kill an API with active consumers — set sunset date → consumers notified (banner + email), gateway signals deprecation, new subscriptions freeze, wind-down, hard cutoff.
- **Archive**: terminal. Preserve immutable versions and public URL as a tombstone; neither publisher handle nor project slug may resurrect that URL.

Related surfaces:

- Spec editor (org admins): deprecate/restore lifecycle ([publishing-specs](publishing-specs.md)).
- Gateway: deprecation signaling on responses for sunsetting APIs (P1) ([gateway](gateway.md)).
- API detail page version picker + spec-diff changelog between versions (P2) ([catalogue-search](catalogue-search.md)).
- Notifications (email + in-app): deprecation/sunset notices, listing-status changes ([webhooks-notifications](webhooks-notifications.md)).

## Tech

From [architecture overview](../architecture/overview.md):

- **Registry lifecycle**: organization and public-route tombstones are authoritative over restored mutable rows. Every org lookup fails closed when `organizationTombstones` contains its Clerk id; every public/execution route lookup requires one exact active reservation binding org id, project id, publisher handle, project slug, and absent `retiredAt`. Org archive, route retirement, key revocation, and legacy-key rotation-required remain terminal stream states. Publisher removal requires a scheduled sunset; immediate retirement is an internal mutation callable only by deployment operators for maintenance. First publish permanently reserves `(publisher handle, project slug)`; project removal archives source/tombstone rows and never physically deletes immutable versions. Direct Convex catalogue/spec/search lookups fail closed immediately; Wallet DO receives a zero/disabled archived checkpoint. Receiver must join every route/key/catalogue read against org kill state, require catalogue's exact active route revision, deny unknown/rotation-required keys, and serve retired public URLs as `410` tombstones.
- **Deprecation signaling**: RFC 8594 headers on gateway responses for deprecated spec versions — `Deprecation: @<epoch-seconds>`, `Sunset: <HTTP-date>`, `Link: <catalogue-url>; rel="deprecation"`

Receiver status (registry v2, not implemented): [registry-v2](../architecture/registry-v2.md).

Code facts (read from source 2026-10-10, not from TECH.md):

- Two levels exist. **Version deprecation** (`specs.deprecateVersion`/`undeprecateVersion`, admin only): sets `deprecatedAt`, `sunsetAt` (≥7 days), message 1–1000 chars, `version_deprecated` notification; spec body unchanged; version sunset stays informational until project retirement; cannot restore after cutoff. **Project retirement** (`projects.scheduleRetirement`, public published projects only): `MIN_DEPRECATION_NOTICE_MS` = 7 days, message required, publisher `project_retirement` notification, paginated consumer fanout from `usageEvents` (`notifyRetirementConsumersPage` + late-settlement reconcile). Retirement freezes catalogue discovery while detail page and gateway stay available until sunset; `cancelRetirement` allowed only before sunset.
- Cron `projects.retireSunsetProjects` retires due projects; retirement disables probes, blocks gateway, cleans runtime secrets, retains audit/evidence. `projects.remove` of a published project requires a scheduled sunset that has passed; result is `deletionState: "tombstoned"`.
- Gateway sets `Deprecation`/`Link`/`Sunset` in `apps/gateway/src/pipeline.ts` and on `/mock` in `apps/gateway/src/mock.ts`. Link host hardcoded `https://zevium.dev/catalogue/...`.
- Detail page shows a Deprecated banner with sunset date + message from `latestVersion`.
- "New subscriptions freeze": `quality.setSubscription` (table `listingSubscriptions`, per consumer org) refuses activation once `deprecationStartedAt`/`sunsetAt`/`retirementState`/`retiredAt`/`deletionState` is set or publisher org archived. No web caller of `setSubscription` exists.

## Decisions

- None recorded beyond TECH.md bullets above.

## Open questions

- FLOW says consumers notified by "banner + email"; code sends in-app notifications only (no email provider in tree). Fix FLOW or add email.
- `410` tombstones for retired public URLs depend on the unimplemented registry receiver ([registry-v2](../architecture/registry-v2.md)); current direct Convex lookups fail closed instead.
- Deprecation `Link` header hardcodes `https://zevium.dev` while live web is `https://www.zevium.dev` (per [build-plan](../history/build-plan.md)); confirm redirect or use configured origin.
- P2 #19 version pinning per key and consumer-facing spec-diff changelog: no code.
- Listing subscriptions (freeze target) have backend only; no UI to subscribe, so "freeze" is not user-visible yet.
