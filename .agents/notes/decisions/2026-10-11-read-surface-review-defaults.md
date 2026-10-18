# Read-surface review defaults for PR #442

Status: accepted (built) — owner accepted as built on 2026-10-18 ([decision](2026-10-18-review-defaults-accepted.md)). Date: 2026-10-11.

- **D1:** Show “Operated by Zevium” on next catalogue cards/detail when `houseOperated`. Label wording was already [accepted](2026-10-10-house-supply-via-aggregators.md); this records delivery scope.
- **D2:** Require org admin for `earnings.forOrg` aggregate/per-project call counts and gross earnings, matching analytics access.
- **D3:** One review per Clerk user per project. Current members of the publisher org cannot review through another organization. Eligibility still requires a successful, non-refunded real call from the active consumer org; explicit free calls qualify.
- **D4:** Public detail removes unpriced operations from returned OpenAPI, retaining explicit cost zero. This applies the existing [unpriced-operation decision](2026-10-10-unpriced-operations-hidden.md) at the backend boundary.
- **D5:** Low-balance notice/email fires only on a downward crossing of 1,000 credits; topping back to at least 1,000 re-arms it.
- **D6:** Webhook-failure notices and email reach organization admins only.

Implementation remains in the isolated rebuild package/next web mode. No deployment or cutover is authorized by this record. Schema budget rises from 35 to 36 application tables because empty query-cache leases cannot share a 768-dimensional vector index.
