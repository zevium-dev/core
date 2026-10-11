# Signup credit follows the first organization created

> Date: 2026-10-11 · Status: accepted · Decided by: owner / parent review
> Supersedes: [2026-10-10 signup credit](2026-10-10-signup-credit.md) recipient selection; implementation #434

Grant $1 (10,000 credits) to the first organization a Clerk user creates, once per Clerk user ever. Clerk automatic org creation supplies the personal org at signup. Joining someone else's organization never claims the joining user's grant. Anonymous wallets receive nothing.

Only signed `organization.created.created_by` establishes the creator. Persist the per-user claim independently of deletable mirrors; commit it with the org claim and existing promotion ledger/funding/checkpoint writes. Replays, concurrent deliveries and deletion/recreation must never issue another grant. Existing claims remain consumed.

Do not require a `user.created` membership snapshot: Clerk does not guarantee the automatic org appears there, so the promotion might never fire. Do not accept browser/mirror nomination or client metadata.

Accepted imperfection: when two organizations are created before their webhooks are processed, the first processed creation wins. Do not wait for or reorder events using `created_at`, or reassign an issued promotion.

Research: [Clerk signup org proof](../research/clerk-signup-org-proof.md). Behavior: [wallet-billing](../features/wallet-billing.md), [accounts-orgs](../features/accounts-orgs.md).
