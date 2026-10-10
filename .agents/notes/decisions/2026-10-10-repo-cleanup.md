# Repo cleanup: delete dead tooling and legacy files

> Date: 2026-10-10 · Status: accepted (done) · Decided by: user ("if it makes sense to delete them just do it"; keep `t3.json`)
> Session: [2026-10-10](../sessions/2026-10-10-competitive-research-and-docs.md)

## Deleted

| What                                                                                                                                                                                                                           | Why                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/check-compliance-claims.mjs` + test (~1,900 lines), its `package.json` scripts, `lint:repo` entries, gateway `build:compliance`, `.compliance-dist` ignore, preview-workflow steps and `exact-compliance-surface` job | Repo-wide scan for compliance claims in Zevium's own files/deploy output. Heavy for a zero-user product; was failing on `t3.json`'s icon path |
| `COPYING.01`–`COPYING.69`                                                                                                                                                                                                      | 69 symlinks to `LICENSE`. `LICENSE` stays                                                                                                     |
| `docs/` (`assets/*.png/gif/mp4`, `polar-e2e-demo.mp4`)                                                                                                                                                                         | Retired media, unreferenced; Polar is dead                                                                                                    |
| `paseo.json`                                                                                                                                                                                                                   | Unused Paseo workspace config (user confirmed)                                                                                                |
| `.agents/notes/findings/*.txt` (60 files)                                                                                                                                                                                      | Old build/e2e run logs from July waves (user confirmed)                                                                                       |
| `.agents/skills/{better-auth-best-practices, polar-better-auth-user-scoped-billing, polar-webhook-local-testing, trpc-tanstack-react-query}`                                                                                   | Skills for the deleted legacy stack                                                                                                           |

## Deleted later the same day (user: "totally greenfield … no users, no compliance")

| What                                                                                                                 | Why                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/public-claims.ts` + tests, `convex/lib/publicClaims.ts` checks, gateway copy checks (~3.3k LOC) | Runtime filter blocking compliance-claim words in publisher copy. ~40ms CPU per KB of spec inside Convex catalogue queries (1s cap) — would break the catalogue. Replaced by `convex/lib/publicSurface.ts` (public handle + published version) and a gateway JSON-validity guard |
| `.agents/notes/architecture/security-compliance.md` (85 KB)                                                          | Compliance-posture doc for a product with no users; issue #103 closed                                                                                                                                                                                                            |

## Kept

- `t3.json` — user's T3 workspace config.
- `.agents/skills/migrate-radix-to-base` — web still depends on `radix-ui`.

## Verification

`pnpm format:check`, `pnpm lint:repo`, `pnpm quality:static` (incl. gitleaks full history + current tree), `pnpm test` all green after deletion.
