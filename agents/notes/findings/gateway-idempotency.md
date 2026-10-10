# Upstream retry-key isolation

User asked for PR for checked Treg-review gaps. Own code only. No Treg code, tests, fixtures, or prose copied.

## Decision

Rewrite effective upstream Idempotency-Key to SHA-256 of versioned tuple: authenticated consumer Clerk org, immutable project id, HTTP method, full concrete upstream URL (query included), caller label. Shared publisher credentials must not merge two buyers' retry labels. Use actual target, not only path template, so different resources and query targets stay apart. Stable across consumer key rotation. No label -> no new header. Scope after publisher header injection so configured header cannot undo isolation.

This is upstream namespace isolation, not gateway response replay or once-only billing. Repeated gateway calls keep existing reserve/settle rules. No body buffering, stored responses, new deps, or control-plane network calls.

## Files

apps/gateway/src/idempotency.ts, src/pipeline.ts, test/idempotency.test.ts, test/pipeline.test.ts.

## Work split

Parent: /home/tnfssc/.t3/worktrees/zevium/t3-2533c64d, branch t3/review-treg-portable-work. Header agent: /home/tnfssc/.bruv/worktrees/t3-2533c64d-97bb1029baf2-task_03d84e53, branch bruv/gateway-header-hygiene-03d84e53. MCP docs agent: /home/tnfssc/.bruv/worktrees/t3-2533c64d-97bb1029baf2-task_a0ff1108, branch bruv/mcp-executable-api-docs-a0ff1108. Both from 32d0800. Parent will integrate uncommitted selected files, run combined gates, commit/push/open PR.

Worktree setup first failed due mise trust on new paths. Parent checked same mise.toml as main, trusted exact files, ran frozen pnpm install. Both passed. No env values logged.

## Checkpoint

Helper, unit tests, integration regressions written. Focused idempotency + pipeline tests passed: 2 files, 42 tests. Header/docs agents still working. Next: integrate and review final diff, then combined gates.

Header patch integrated. Full gateway suite passed before final metadata assertion: 13 files, 242 tests. Parent fetched origin/develop and fast-forwarded from 32d0800 to 15b609a (worktree setup fix; no feature conflict). MCP extraction diff reviewed in child worktree; waiting for child tests/terminal result before copying.

Parent combined check: `pnpm ci:pr` passed on integrated diff (format, lint, static quality, typecheck, all tests, builds, whitespace). First run caught unsupported diagnostic second arguments in header-test `expect`; removed those, reran full gate successfully. No production/provider execution tested. Independent review later found one URI-reference bug; see final checkpoint below.

## Final checkpoint

All three gaps integrated in parent worktree. Independent review found one URI-reference bug; parent reproduced, fixed, and covered it. Final `pnpm ci:pr` passed after fix: format, lint, static quality, typecheck, tests, builds, whitespace. No production/provider execution proof. Ready to commit/push one PR against develop. Child worktrees are provenance only; parent branch owns release diff. Findings carry contracts and checks. One small value created/updated from source evidence and user feedback; no other repeat lesson added.
