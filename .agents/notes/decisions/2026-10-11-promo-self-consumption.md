# Promo self-consumption must not create withdrawable earnings

Status: accepted (built) — owner accepted as built on 2026-10-18 ([decision](2026-10-18-review-defaults-accepted.md)); implemented in PR #438.
Date: 2026-10-11
Scope: #353 Convex rebuild, money core; live deployment unchanged.

Signup promotion cannot be converted into publisher cash by calling an owned listing. Promo-funded slices earn zero publisher net when consumer and publisher organizations match, or when verified consumer creator/owner identity matches a publisher admin. Paid/admin sources retain the usual 95/5 split. Spend priority remains promo, admin, then paid FIFO.

PR #438 implements the verifiable same-org check. The current schema has no verified admin-membership projection/index; API key ownership does not prove admin authority, and personal-org grant binding does not establish ownership of every organization. Cross-org same-user matching remains an explicit coverage limit until authoritative membership evidence exists.

Accounting retains full gross source attribution, zero fee/net for suppressed slices, and separate platform promo-cost atoms. Suppression creates no withdrawable earning. Original-source type survives dust merges. Platform fee revenue excludes suppressed promotion.

Implementation does not change the accepted ordinary house-publisher path for paid/admin funding.
