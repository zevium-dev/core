# Reviews

> Status: built (#319 includes free-tier callers) · Updated: 2026-10-10
> Code: `convex/reviews.ts`, `convex/reviews.test.ts`, `convex/schema.ts` (`reviews`, `reviewReports`, `reviewAggregates`, `reviewModerationActions` + history tables), `packages/shared/src/quality.ts` (`PublicReviewContract`, `ReviewAggregateContract`), `apps/web/src/components/review-section.tsx`, `apps/web/src/routes/admin/reviews.tsx`, `apps/web/src/routes/admin/-reviews-ui.tsx`, `apps/web/src/components/quality-review-ui.test.tsx`
> Related: [catalogue-search](catalogue-search.md), [platform-admin](platform-admin.md), [quality-signals](quality-signals.md), [accounts-orgs](accounts-orgs.md), [roadmap](../product/roadmap.md)

Verified ratings and reviews on API detail pages. Only a consumer organization that has completed at least one successful call, including free-tier calls, may review; attribution is anonymous by default ("Verified consumer"). Publishers may respond but cannot remove criticism; staff moderation is audited.

## Product

- **Verified reviews** (P2): only an organization with a successful call (free-tier included) may review a listing. One active review per consumer organization; rating-only reviews are valid. Public attribution is "Verified consumer" by default, not the buyer organization's identity. Publisher organizations cannot review their own listings, publisher responses cannot remove criticism, and staff hide/restore actions require an auditable reason.

## Flow

- API detail page `/catalogue/{org}/{api}` (and `/app/catalogue/{org}/{api}`): Reviews/ratings (P2). Page owned by [catalogue-search](catalogue-search.md).
- Platform admin `/admin/reviews`: moderation queue, hide/restore with reason ([platform-admin](platform-admin.md)).

## Tech

TECH.md has no reviews-specific bullet. Review eligibility + publisher responses drive the signed-in provider split in the **Navigation providers** bullet, kept verbatim in [catalogue-search](catalogue-search.md#tech).

Code facts (read from source 2026-10-10, not from TECH.md):

- Mutations: `reviews.upsert` (rating integer 1–5, optional body ≤2,000 chars), `withdraw`, `respondAsPublisher` (non-empty, ≤2,000), `report` (reason 10–1,000 chars; 10 reports/hour; reporter cannot report own org's review or reviews on own listing), `moderate` (`requireAdmin`; action `hidden`|`restored`; reason ≥3 chars, ≤1,000; stale-generation check). Internal `resolveReportsPage`.
- Queries: `getAggregate` (count, average, 1–5 distribution), `listPublic`, `listPublicPaginated` (page ≤50), `getViewerState`, `listModerationQueue`, `moderationHistory`.
- Eligibility (`requireEligibleReviewer`): active org required; listing must be published, public, not retired, not quality `suspended`/`recovering`; publisher org rejected ("Publisher organizations cannot review their own listing"); requires a `usageEvents` row for this org + project with `billingOutcome: "settled"` or `"free"`, `qualityOutcome: "success"`, and `settleRefId` prefix `settle:`. Two indexed first-row probes (`by_org_project_review_eligibility`) serve both mutation and viewer state. Ingest validates success as HTTP 2xx. Free-tier and explicit-zero calls qualify; failed/refunded calls and unverified analytics rows do not.
- One row per `(consumerOrganizationId, projectId)` via `by_consumer_project`; history actions `created`/`edited`/`withdrawn`/`reactivated` with `actorUserId`. Public label constant `reviewerLabel: "Verified consumer"`.

## Decisions

- 2026-07-19 — Generated SDKs and reviews/ratings stay deferred until catalogue has real supply and core paid journey is proven. Superseded in practice: reviews shipped in code (see Status).
- 2026-10-10 — BUILT (#319): any org with at least one successful call (free-tier included) may review; tighten later (e.g. ≥$20 topped up in last year). [decision](../decisions/2026-10-10-review-eligibility.md)

## Open questions
