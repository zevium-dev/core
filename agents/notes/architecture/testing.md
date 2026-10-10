# Testing and verification

> Updated: 2026-10-10 (from `.project/PLAN.md` verification protocol + 2026-07-11 decision)
> Code: `package.json` scripts, `e2e/`, `scripts/quality/`
> Related: [dev-environment](dev-environment.md), [deploy](deploy.md)

## Rules

- Tests are mandatory in every lane (user directive, 2026-07-11): `convex-test` for Convex functions, vitest for shared/web logic, workerd tests for the gateway. Root `pnpm test` stays green.
- Seams get explicit tests: cross-service identity, metering, cache and webhook boundaries ([architecture principle 4](overview.md#principles)).

## Commands

| Command          | What                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm test`      | All unit/integration suites (`scripts/quality/run-tests-ci.mjs`)                                            |
| `pnpm typecheck` | Turbo typecheck across workspace                                                                            |
| `pnpm build`     | Tracked-tree guarded turbo build                                                                            |
| `pnpm ci:pr`     | Full PR gate: format check, lint, static quality, typecheck, test, CI build, diff check                     |
| `pnpm e2e`       | Browser + gateway journeys (`e2e/run-all.sh`): `01-auth`, `02-publisher`, `03-consumer`, `04-payment-drill` |

## Verification protocol (after every change set)

1. `pnpm build && pnpm test && pnpm typecheck` at root — must be green. Prefer `pnpm ci:pr` before a PR.
2. Browser-drive changed flows via agent-browser at milestones (pitfalls: [dev-environment](dev-environment.md#browser-automation-agent-browser)).
3. Findings → `../findings/<topic>.md`; follow-up fixes reference them.
4. Commit only when the user asks.

Payment drills and refund acceptance: [wallet-billing](../features/wallet-billing.md) Tech. Preview/production smoke checks: [deploy](deploy.md).
