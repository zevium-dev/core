# Reviews

> Status: root cutover implemented; owner activation pending · Updated: 2026-10-11
> Code: `convex/{reviews,reviewMembership}.ts`, `apps/web/src/components/review-section.tsx`, `apps/web/src/routes/admin/-reviews-ui.tsx`, `tests/readSurfaces.test.ts`
> Related: [catalogue-search](catalogue-search.md), [platform-admin](platform-admin.md), [quality-signals](quality-signals.md), [accounts-orgs](accounts-orgs.md), [roadmap](../product/roadmap.md)

Verified ratings and reviews on API detail pages. Only a consumer organization that has completed at least one successful call, including free-tier calls, may review; attribution is anonymous by default ("Verified consumer"). Publishers may respond but cannot remove criticism; staff moderation is audited.

## Product

- **Verified reviews** (P2): only an organization with a successful call (free-tier included) may review a listing. Legacy: one active review per consumer organization. Next preview: one review per person per listing; rating-only reviews are valid. Public attribution is "Verified consumer" by default, not the buyer organization's identity. Publisher organizations cannot review their own listings, publisher responses cannot remove criticism, and staff hide/restore actions require an auditable reason.

## Flow

- API detail page `/catalogue/{org}/{api}` (and `/app/catalogue/{org}/{api}`): Reviews/ratings (P2). Page owned by [catalogue-search](catalogue-search.md).
- Platform admin `/admin/reviews`: moderation queue, hide/restore with reason ([platform-admin](platform-admin.md)).

## Tech

Successful real paid or free calls establish active-org review eligibility; mocks, exceptions, refunds and own-publisher calls do not. One review belongs to a Clerk user/project; live publisher membership blocks cross-org self-review. Upsert is an action; remaining writes retain mutations. Public DTOs redact internal evidence. Moderation/reports retain immutable snapshots, content revisions/generations, bounded history and report dismissal. Org-admin publisher replies preserve history.

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

## Decisions

- 2026-10-11 — PR #442 applies [read-surface review defaults](../decisions/2026-10-11-read-surface-review-defaults.md), pending owner sign-off.

- 2026-07-19 — Generated SDKs and reviews/ratings stay deferred until catalogue has real supply and core paid journey is proven. Superseded in practice: reviews shipped in code (see Status).
- 2026-10-10 — BUILT (#319): any org with at least one successful call (free-tier included) may review; tighten later (e.g. ≥$20 topped up in last year). [decision](../decisions/2026-10-10-review-eligibility.md)

## Open questions
