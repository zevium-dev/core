# Convex rebuild PR 2 implementation

> Date: 2026-10-11 · Scope: #353, PR #437 targeting develop after PR #436 merged

Owner requested identity, key lifecycle and publishing exactly within the rebuild plan, isolated from the shared Convex dev deployment. Worktree: `rebuild-pr2`; branch: `t3/convex-rebuild-pr2`, initially based on `ed3753d7`, rebased onto reviewed PR 1 foundation `b9422054`, then `feb1635f` after its develop rebase included #434 and the accepted first-created-org policy. No edits to the primary checkout, no stash, no shared schema deployment or data wipe.

Implementation, interpretations, validation and next-layer handoff are owned by the [plan status](../architecture/convex-rebuild.md#pr-2-implementation-and-handoff--2026-10-11). Signup follows the accepted first-created-org decision brought in by #434. Only signed organization creation establishes the creator, and first processed creation wins; PR 3 alone writes the promotional money and per-user paid claim. No new product decision or duplicate issue was created.

Local verification uses the PR 1 anonymous backend guard plus additional real domain races. Root production modules/callers and provider destinations remain unchanged. Commit/push/stacked PR authorized; merge prohibited.

Old local race fixtures predating the tightened wallet schema were preserved by moving their ignored scratch deployment to `.tmp/races-before-reviewed-foundation`; a fresh anonymous race deployment replaced it. No data was wiped.

Rebase follow-up: verified the `rebuild-pr2` worktree, fetched `origin/develop` at `4fa918ec`, and replayed only PR 2 from merge-base `feb1635f`. Contrary to the follow-up brief’s stale-history warning, both the original PR 2 parent and merged PR 1 contained that exact reviewed foundation. Rebase was conflict-free and changed no runtime behavior, schema shapes or function names; inventory refresh was unnecessary. PR #437 now targets `develop`. Root, next-package and race backend configuration were verified anonymous and loopback-only before validation.

Post-rebase validation: next-package `convex codegen --typecheck enable`, `pnpm format` and uncached `VITEST_MAX_WORKERS=2 pnpm ci:pr` passed. Generated bindings remained unchanged; the inventory check passed without refreshing names/classifications. The full gate included 55 next unit tests, existing root/application suites, anonymous local schema and OCC checks, build/runtime checks and root code generation.

GitHub CodeQL then flagged an unescaped hostname in the publishing DTO secrecy test. Escaped both dots in `private.example.com` so the assertion matches the literal fixture hostname. Runtime behavior remains unchanged. `pnpm format` and uncached `VITEST_MAX_WORKERS=2 pnpm ci:pr` passed again after the correction.
