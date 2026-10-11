# Clerk signup organization proof

> Investigated: 2026-10-11. Runtime: `@clerk/backend` 3.22.0. Live automatic-signup payload not verified.

Owner requires $1 only for the org automatically created at signup, once per Clerk user ever. Creator ID alone proves ownership, not signup provenance. Choosing the first delivered org is also unsafe: webhook delivery is unordered. A short creation-time window can include a manually created second org, and a deleted first org may no longer appear in a later Backend API membership list.

## Evidence

- [Clerk automatic first organization announcement](https://clerk.com/changelog/2026-01-22-default-organization-naming): opt-in automatic first organization creation; default naming rules apply to both automatic and manual first-org flows, so names are not proof.
- [Organization configuration](https://clerk.com/docs/guides/organizations/configure): automatic creation is an instance setting; required membership can also be satisfied by joining an org.
- [Clerk's organization webhook example](https://clerk.com/blog/per-user-licensing-with-stripe-and-clerk-organizations): `organization.created` includes `created_by` and `created_at`.
- Installed SDK `node_modules/@clerk/backend/dist/api/resources/JSON.d.ts`: `OrganizationJSON` has `created_by`, `created_at`, metadata; no automatic-creation field. `UserJSON` has `created_at` and nullable `organization_memberships`; nested membership organizations carry `OrganizationJSON`.

## Implemented proof and limits

Use only a unique owned organization present in the signed `user.created` snapshot, with valid creation timestamps (organization not older than user), matched to a signed `organization.created` event with the same creator and exact org timestamp. This establishes ownership at signup without choosing by delivery time or client input. Store both facts independently so either event can arrive first; freeze eligibility and grant claims permanently. No later user update or membership can expand eligibility.

**This is a fail-closed inference from the signup snapshot, not a documented Clerk automatic-creation marker.** No public contract located guarantees that the automatic org is present when Clerk emits `user.created`. If Clerk emits user creation before auto-org provisioning (or omits membership data), this path deliberately grants nothing. A synthetic signed-payload test proves implementation behavior, not real provider delivery. Production acceptance needs a real automatic signup and inspection of its signed event shape. If the snapshot is absent, obtain an authoritative provider marker or a trusted provisioning association; do not silently loosen eligibility to a timing heuristic.

No live provider configuration or shared deployment data was changed during this investigation.
