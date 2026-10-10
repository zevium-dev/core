# Build scope and editor direction

> Date: 2026-07-11 · Status: accepted · Decided by: user
> Source: `.project/PLAN.md` "Decisions (user, 2026-07-11)" → [history/build-plan.md](../history/build-plan.md)

## Decision

- Spec editor: direction C, phased — cut 1 editor + validation + read-only rail, cut 2 write-back + diffs.
- Scope: full FLOW parity — no placeholder left, including org surfaces, earnings, admin, webhooks, notifications.
- Settings: Clerk `UserProfile`/`OrganizationProfile` embeds + custom app prefs; keys stay custom.
- YAML accepted at input, converted client-side, stored canonical JSON (gateway stays JSON-only).
- Tests mandatory in every lane: convex-test, vitest, workerd tests. Root `pnpm test` stays green.

## Affects

[publishing-specs](../features/publishing-specs.md), [accounts-orgs](../features/accounts-orgs.md), [api-keys](../features/api-keys.md), [testing](../architecture/testing.md)
