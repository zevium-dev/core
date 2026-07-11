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
| 2 | gateway | end-to-end proxy against Convex-backed spec + Clerk key verify | done (committed 8ba0b86) |
| 2 | e2e | agent-browser scripts in e2e/ | done — 01/02/03 ALL PASS incl. paid gateway call |
| 3 | web | catalogue (public SSR) + API detail + playground | done (07e3f1a) |
| 3 | convex+web | billing/wallet screens + Polar webhook | done (e7c1994) — Polar webhook registration = user action |
| 3 | web | keys screens (/app/settings) | done (e7c1994 + 8f524c3 org claims) |
| 4 | web+convex | analytics dashboards | done (632f6ed) |
| 4 | gateway | MCP endpoint + discovery | done (93d259e) |
| 5 | all | DESIGN.md motion pass, E2E full suite green, visual-review-1 fixes | done (7c51257) — ALL PASS 489s |

## User action needed

- ~~Clerk API Keys feature~~ — DONE, user enabled in dashboard; keys flow verified live.
- Polar sandbox token lacks `products:write` + webhook scopes. To finish billing: (1) create token with full scopes or use dashboard, (2) register webhook `https://doting-warbler-454.convex.site/polar-webhook` for `order.paid`, (3) put its secret in Convex env `POLAR_WEBHOOK_SECRET` (current one is from legacy endpoint — stale), (4) optionally real credit-pack products (billing.ts falls back to ad-hoc prices).

## Known facts (hard-won, keep)

- Gateway dev: `npx wrangler dev --port 8787` in apps/gateway; env in `apps/gateway/.dev.vars` (gitignored): CLERK_SECRET_KEY, CONVEX_URL, GATEWAY_INTERNAL_SECRET=dev-internal-secret-1
- Test org wallet funded 10,000 credits on BOTH planes (convex grantCredits + gateway /internal/grant, refId e2e:manual:grant:1)
- Clerk API keys: real prefix `ak_`; user-created keys have subject=user_… — org routing needs claims.org_id (fix lane b2vkaiep7); E2E key in .project/e2e-key.env (gitignored)

- Clerk sign-in automation: name-find "Continue" hits "Continue with Google"; CSS click on Clerk submit is inert → focus input + press Enter. OTP 424242 auto-submits on fill. Flow: /sign-in → factor-one → client-trust.
- agent-browser click does NOT scroll target into view — below-fold clicks silently no-op (✓ Done, nothing happens). Always `eval scrollIntoView({block:'center'})` first, or `form.requestSubmit()` for submits.
- Clerk password reset REVOKES existing sessions — re-sign-in all browser sessions after.
- Seed user password drifted once; reset via `clerk api /users/<id> -X PATCH -d '{"password":..., "skip_password_checks": true}'`
- agent-browser sessions isolate via `AGENT_BROWSER_SESSION` env; e2e suite uses its own, orchestrator default session stays signed in
- OpenCode Go weekly quota was exhausted — provider-qualify `--model xai-oauth/grok-4.5` on omp calls until reset
- Visual debt from visual-review-1: ALL CLEARED in wave 5 (session-aware header, hero proof strip, skeleton crossfades)

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
