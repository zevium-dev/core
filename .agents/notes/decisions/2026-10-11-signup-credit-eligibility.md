# Signup credit belongs only to the signup personal org

> Date: 2026-10-11 · Status: accepted direction; implementation pending · Decided by: owner
> Session: [owner decisions](../sessions/2026-10-11-owner-decisions.md)

## Decision

Credits remain org-scoped. Grant **$1 = 10,000 credits only to the personal org auto-created at the user's signup, once per user**. Organizations later created or joined receive nothing. Anonymous wallets receive nothing. The grant remains non-refundable promotional money; paid calls retain normal publisher earnings.

Supersedes the eligibility in [2026-10-10 signup credit](2026-10-10-signup-credit.md), including its once-per-org wording and once-per-creator fallback. Once per creator is necessary but insufficient: the grant must target that user's signup personal org.

## Delivery and limits

P0 #426, coordinated with #353. Current #317 code trusts Clerk `created_by` and deduplicates by org/creator; it does not prove the org was auto-created at signup. Record a trusted signup-to-personal-org association and fail closed until that evidence arrives. Do not grant to the first org webhook or infer eligibility from active membership. Replay, late proof, concurrent delivery, later-created orgs, joins and deletion must not issue another grant. The exact trusted eligibility signal is implementation work, not evidence supplied by this decision.

## Affects

[Accounts and orgs](../features/accounts-orgs.md), [wallet billing](../features/wallet-billing.md), [pricing](../features/pricing.md).
