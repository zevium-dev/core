# Clerk signup organization proof

> Investigated: 2026-10-11. Runtime: `@clerk/backend` 3.22.0. Live automatic-signup payload not verified.

Initial requirement was strict automatic-signup provenance. Creator ID proves ownership but does not prove automatic creation, and webhook delivery is unordered. The owner subsequently accepted the simpler first-created-org rule, with first-processed delivery winning when webhooks race. See [decision](../decisions/2026-10-11-signup-credit-first-created-org.md).

## Evidence

- [Clerk automatic first organization announcement](https://clerk.com/changelog/2026-01-22-default-organization-naming): opt-in automatic first organization creation; default naming rules apply to both automatic and manual first-org flows, so names are not proof.
- [Organization configuration](https://clerk.com/docs/guides/organizations/configure): automatic creation is an instance setting; required membership can also be satisfied by joining an org.
- [Clerk's organization webhook example](https://clerk.com/blog/per-user-licensing-with-stripe-and-clerk-organizations): `organization.created` includes `created_by` and `created_at`.
- Installed SDK `node_modules/@clerk/backend/dist/api/resources/JSON.d.ts`: `OrganizationJSON` has `created_by`, `created_at`, metadata; no automatic-creation field. `UserJSON` has `created_at` and nullable `organization_memberships`; nested membership organizations carry `OrganizationJSON`.

## Conclusion after owner review

The discarded implementation required a unique owned organization in signed `user.created.organization_memberships` plus matching signed `organization.created` creator and timestamp. Clerk does not document that automatic org creation appears in the user snapshot. That requirement could silently deny every signup; synthetic snapshot tests did not establish a production happy path.

The accepted implementation grants from signed `organization.created.created_by` alone, once per Clerk user ever. Automatic org creation supplies the personal org at signup. The indexed creator claim, org claim, ledger append, balance, nonrefundable lot and checkpoint commit atomically; claims survive deletable mirrors. User deletion leaves a permanent tombstone. Joining an organization, client metadata, browser mirror initialization and org updates never claim credit.

Accepted imperfection: if a second org is created before the first org's webhook is processed, whichever signed creation webhook is processed first gets the grant. `created_at` does not reorder or move an issued grant. Snapshot proof code and tests were removed; missing membership snapshots no longer block funding. Live provider signup delivery was not exercised in this task.

No live provider configuration or shared deployment data was changed during this investigation.
