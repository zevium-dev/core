# Zevium Build Plan — orchestration state

> Orchestrator: Claude. Builders: omp subagents. Source of truth: PRODUCT.md, FLOW.md, DESIGN.md, TECH.md, AGENTS.md.

## Environment facts (for prompts)

- Monorepo: pnpm + turbo. `apps/web` (TanStack Start + Clerk), `apps/gateway` (CF Worker, wallet DO done), `convex/` (cloud dev deployment live), `packages/shared`
- Convex env: root `.env.local` (`CONVEX_DEPLOYMENT`, `CONVEX_URL`); push schema with `npx convex dev --once`
- Clerk env: `apps/web/.env.local` (`VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`); app id `app_3GLp1GPEub0OjOIpxGSDIXydiZx`; org slugs enabled
- Seed: `pnpm seed` → `test+clerk_test@zevium.dev` / `zevium-test-password`, OTP `424242`, org `test-org`
- Dev server: `apps/web` on port 3000 (may be running)
- Legacy is deleted. Never resurrect tRPC/Drizzle/Better Auth/Polar-meters patterns
- Polar sandbox creds: legacy `.env` at repo root has `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET` (server=sandbox), `GEMINI_API_KEY`, `RESEND_API_KEY`

## Waves

| Wave | Lane | Scope (disjoint dirs) | Status |
| --- | --- | --- | --- |
| 1 | convex | Full schema + org/user mirror + Clerk JWT auth + webhook http action | done |
| 1 | web | shadcn init, motion tokens, app shell (sidebar/org switcher/theme), route skeleton | done |
| 1 | gateway | /gateway routing, key-verify cache module, spec resolution, wallet integration | done |
| 2 | convex | projects + specs CRUD functions, publish pipeline, catalogue query | done |
| 2 | web | projects screens + spec editor | done |
| 2 | gateway | end-to-end proxy against Convex-backed spec + Clerk key verify | done |
| 3 | web | catalogue (public SSR) + API detail + playground | done |
| 3 | convex | wallets ledger functions + Polar webhook + usage rollups | done |
| 3 | web | keys screens + billing/wallet screens | done |
| 4 | all | analytics dashboards, MCP endpoint, landing page | done |
| 5 | all | DESIGN.md motion pass, E2E tests, fixes | done |

## Verification protocol (after every wave)

1. `pnpm build && pnpm test && pnpm typecheck` at root — must be green
2. Browser-drive changed flows via agent-browser at milestones
3. Findings → `.project/findings/wave-N.md`; fixes = follow-up omp runs
4. Commit per wave

## Rules for omp prompts

- Self-contained, absolute paths, explicit write scope (one lane = one dir tree)
- Always: "Read PRODUCT.md / FLOW.md / DESIGN.md / TECH.md / AGENTS.md at /home/tnfssc/Code/zevium first"
- Output contract: end with `DONE: <summary>` or `BLOCKED: <reason>`
- Max-time 1200s, default model
