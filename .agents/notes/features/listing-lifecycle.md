# Listing lifecycle

> Status: root cutover implemented; owner activation pending · Updated: 2026-10-11
> Code: `convex/{projects,specs,clerkWebhooks}.ts`, `convex/lib/publicRoutes.ts`, `convex/lifecycleNotices.ts`, `tests/publishing.test.ts`
> Related: [publishing-specs](publishing-specs.md), [quality-signals](quality-signals.md), [gateway](gateway.md), [webhooks-notifications](webhooks-notifications.md), [catalogue-search](catalogue-search.md), [registry-v2](../architecture/registry-v2.md), [roadmap](../product/roadmap.md)

> Email (#320): built, dormant until configured. Code: `convex/notificationEmail.ts`, `convex/notificationEmailAction.ts`, `convex/lib/notificationEmail.ts`, `convex/notificationEmail.test.ts`.

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

Publish reserves routes permanently in the same transaction. Metadata updates patch explicit fields and preserve suspension. Seven-day retirement notice, version deprecation, generation-fenced cleanup and permanent tombstones remain. Consumer notice/email fan-out pages successful project consumers; version notices conservatively reach project-scoped consumers. Archive immediately denies new activity and retains immutable versions/finance for admitted settlement and reconciliation.

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

## Decisions

- 2026-10-11 — PR #442 applies [read-surface review defaults](../decisions/2026-10-11-read-surface-review-defaults.md), pending owner sign-off.

- None recorded beyond TECH.md bullets above.

## Open questions

- Resolved #355: clearing metadata or canceling retirement cannot clear quality enforcement or the publication generation fence.

- Consumer project-retirement email is built (#320) but dormant until owner configures Resend. Version-deprecation also notifies existing consumers of the affected version.
- `410` tombstones for retired public URLs depend on the unimplemented registry receiver ([registry-v2](../architecture/registry-v2.md)); current direct Convex lookups fail closed instead.
- Deprecation `Link` header hardcodes `https://zevium.dev` while live web is `https://www.zevium.dev` (per [build-plan](../history/build-plan.md)); confirm redirect or use configured origin.
- P2 #19 version pinning per key and consumer-facing spec-diff changelog: no code.
- Listing subscriptions (freeze target) have backend only; no UI to subscribe, so "freeze" is not user-visible yet.
