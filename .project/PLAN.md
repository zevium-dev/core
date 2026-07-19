# Zevium Build Plan — orchestration state

> Orchestrator: Claude. Builders: omp subagents. Source of truth: PRODUCT.md, FLOW.md, DESIGN.md, TECH.md, AGENTS.md.

## Environment facts (for prompts)

- Monorepo: pnpm + turbo. `apps/web` (TanStack Start + Clerk), `apps/gateway` (CF Worker, wallet DO done), `convex/` (cloud dev deployment live), `packages/shared`
- Convex env: root `.env.local` (`CONVEX_DEPLOYMENT`, `CONVEX_URL`); push schema with `npx convex dev --once`
- Clerk env: `apps/web/.env.local` (`VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`); app id `app_3GLp1GPEub0OjOIpxGSDIXydiZx`; org slugs enabled
- Seed: `pnpm seed` → `test+clerk_test@zevium.dev` / `zevium-test-password`, OTP `424242`, org `test-org`
- Dev server: `apps/web` on port 3000 (may be running)
- Legacy is deleted. Never resurrect tRPC/Drizzle/Better Auth/Polar-meters patterns
- Stripe Checkout + Connect replaced Polar and manual payouts on 2026-07-12; setup contract lives in `.env.example` and `.project/stripe-discovery.md`
- Production deploys automatically after green `develop` CI via `.github/workflows/deploy-production.yml`; live surfaces are `https://www.zevium.dev` and `https://gateway.zevium.dev`
- Production catalogue is empty as of 2026-07-19. Landing Weather/FX/Embeddings cards are fallback teasers, not live listings

## Waves

| Wave  | Lane       | Scope (disjoint dirs)                                                                                                                               | Status                                                       |
| ----- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1     | convex     | Full schema + org/user mirror + Clerk JWT auth + webhook http action                                                                                | done                                                         |
| 1     | web        | shadcn init, motion tokens, app shell (sidebar/org switcher/theme), route skeleton                                                                  | done                                                         |
| 1     | gateway    | /gateway routing, key-verify cache module, spec resolution, wallet integration                                                                      | done                                                         |
| 2     | convex     | projects + specs CRUD functions, publish pipeline, catalogue query                                                                                  | done                                                         |
| 2     | web        | projects screens + spec editor                                                                                                                      | done                                                         |
| 2     | gateway    | end-to-end proxy against Convex-backed spec + Clerk key verify                                                                                      | done (committed 8ba0b86)                                     |
| 2     | e2e        | agent-browser scripts in e2e/                                                                                                                       | done — 01/02/03 ALL PASS incl. paid gateway call             |
| 3     | web        | catalogue (public SSR) + API detail + playground                                                                                                    | done (07e3f1a)                                               |
| 3     | convex+web | billing/wallet screens + Polar webhook                                                                                                              | done (e7c1994) — Polar webhook registration = user action    |
| 3     | web        | keys screens (/app/settings)                                                                                                                        | done (e7c1994 + 8f524c3 org claims)                          |
| 4     | web+convex | analytics dashboards                                                                                                                                | done (632f6ed)                                               |
| 4     | gateway    | MCP endpoint + discovery                                                                                                                            | done (93d259e)                                               |
| 5     | all        | DESIGN.md motion pass, E2E full suite green, visual-review-1 fixes                                                                                  | done (7c51257) — ALL PASS 489s                               |
| 6     | convex     | usage/billing/earnings query surface + specs.getVersion + indexes + convex-test                                                                     | done — 11/11 tests, schema pushed                            |
| 6     | web+shared | spec editor cut 1: CodeMirror, live validation (shared port), YAML→JSON, import                                                                     | done — e2e 02 PASS through new editor                        |
| 6     | web        | landing v2: scroll-depth sections, real footer, docs placeholder                                                                                    | done — visual QA clean                                       |
| 7     | web        | settings (Clerk embeds+prefs), activity, billing breakdown, project settings/earnings, org surfaces, catalogue filters, onboarding fix, MCP env URL | done — visual QA on all 7 screens                            |
| 7     | gw+convex  | usage ingest pipe: /ingest-usage http action (internal-secret) ← wallet DO alarm flush; was silently dead without deploy key                        | done — events landed retroactively, UI live                  |
| 8     | convex     | notifications + webhooks + deprecation + admin backend (86 tests)                                                                                   | done (b77388f)                                               |
| 8     | web+gw     | bell, webhooks card, deprecate UI+banner, /admin screens, RFC 8594 headers                                                                          | done — full chain browser-verified                           |
| 8     | web+convex | Polar "Sync purchases" (dual-plane reconcile, 5-min cooldown) + spec editor cut 2 (rail write-back, version view/diff)                              | done (d995c3b)                                               |
| 9a    | all        | key caps/rotation (DO-enforced), semantic search (gemini-embedding-001@768 — text-embedding-004 is dead), in-app /docs                              | done — search + keys browser-verified                        |
| 9b    | all        | mock mode (/mock, 0-credit, key-authed) + x402 envelope, manual payouts (/app/earnings + /admin/payouts)                                            | done — mock + 402 + earnings live-verified                   |
| 10    | all        | Stripe Checkout + Connect, refund/dispute debt, explicit earning lifecycle, transfer/payout projection, wallet reconciliation hardening             | done — build/test/typecheck green                            |
| 11    | launch     | real production listings, real Stripe checkout/refund/Connect drill, external launch approvals                                                      | next — production deploy exists; product is not launch-ready |
| 12    | all        | public quality signals, automated publish gates, per-API status surfaces                                                                            | next product feature after launch loop is proven             |
| Later | —          | generated SDKs, reviews/ratings, full x402 settlement, remaining P2                                                                                 | deferred                                                     |

## Decisions (user, wave 9)

- Payouts: manual ledger MVP (request → admin queue → human wires). Min payout 100,000 credits ($10).
- Docs: in-app `/docs` routes.
- omp fallback chain exhausted 2026-07-12 early AM (xai spending cap, glm 5h cap, opencode monthly cap) — wave 9b built with native Claude subagents per omp-delegate exception.

## Decisions (2026-07-19)

- Production deployment is live and CI-gated from `develop`.
- Launch readiness, not more P2 surface area, is current priority.
- Generated SDKs and reviews/ratings stay deferred until catalogue has real supply and core paid journey is proven.

## User check

- ADMIN_USER_IDS convex env currently = seed test user. Set real admin Clerk user ids for prod.
- ~~Clerk "Organizations feature required" nag~~ — RESOLVED, not a config issue: clerk-js cached a degraded environment fetch (dev-instance usage limits under e2e hammering) inside a long-lived tab and disabled org components client-side. Both Clerk APIs confirmed orgs enabled the whole time. Hard reload refetches and clears it. Prod keys unaffected.

## Decisions (user, 2026-07-11)

- Spec editor: direction C phased — cut 1 editor+validation+read-only rail, cut 2 write-back+diffs. Mockups: claude.ai/code/artifact/3591af48
- Scope: FULL FLOW.md parity — no placeholder left, including org surfaces, earnings, admin, webhooks, notifications
- Settings: Clerk UserProfile/OrganizationProfile embeds + custom app prefs; keys stay custom
- YAML: accepted at input, converted client-side, stored canonical JSON (gateway stays JSON-only)
- Tests mandatory in every lane (user directive): convex-test for convex fns, vitest for shared/web logic, workerd tests for gateway. Root `pnpm test` stays green.

## User action needed

- ~~Clerk API Keys feature~~ — DONE, user enabled in dashboard; keys flow verified live.
- Publish initial real production listings; current public catalogue has zero APIs.
- Configure staging payment-drill environment and manually run `.github/workflows/payment-drill.yml`; scheduled runs cover deterministic contracts only.
- Stripe production setup remains operator work: enable Connect, create three canonical Prices, register platform + Connect webhook destinations, configure secrets, and obtain written approval for pooled prepaid credits across independent publishers.
- Complete legal/tax and operating-policy gates in `.project/stripe-discovery.md` before enabling real-money launch.

## Known facts (hard-won, keep)

- Gateway dev: `npx wrangler dev --port 8787` in apps/gateway; env in `apps/gateway/.dev.vars` (gitignored): CLERK_SECRET_KEY, CONVEX_URL, GATEWAY_INTERNAL_SECRET=dev-internal-secret-1
- Test org wallet funded 10,000 credits on BOTH planes (convex grantCredits + gateway /internal/grant, refId e2e:manual:grant:1)
- Clerk API keys: real prefix `ak_`; user-created keys have subject=user_… — org routing needs claims.org_id (fix lane b2vkaiep7); E2E key in .project/e2e-key.env (gitignored)

- Clerk sign-in automation: name-find "Continue" hits "Continue with Google"; CSS click on Clerk submit is inert → focus input + press Enter. OTP 424242 auto-submits on fill. Flow: /sign-in → factor-one → client-trust.
- agent-browser click does NOT scroll target into view — below-fold clicks silently no-op (✓ Done, nothing happens). Always `eval scrollIntoView({block:'center'})` first, or `form.requestSubmit()` for submits.
- Clerk password reset REVOKES existing sessions — re-sign-in all browser sessions after.
- Seed user password drifted once; reset via `clerk api /users/<id> -X PATCH -d '{"password":..., "skip_password_checks": true}'`
- agent-browser sessions isolate via `AGENT_BROWSER_SESSION` env; e2e suite uses its own, orchestrator default session stays signed in
- omp model status (2026-07-11 evening): OpenCode Go weekly quota exhausted; xai-oauth/grok-4.5 hit spending limit (403). Current lane model: `zai/glm-5.2` (user directive).
- agent-browser eval runs in ISOLATED world: page-world JS props (e.g. CodeMirror contentDOM.cmView) invisible. Dispatched events cross worlds — inject editor text via synthetic ClipboardEvent paste (see e2e/02). DOM structure/attrs visible fine.
- @uiw/react-codemirror defaults to its own LIGHT theme — pass theme="none" or CSS-var themes get overridden
- Editing apps/web files while an e2e run is in flight = Vite HMR reload wipes Clerk forms mid-fill → spurious sign-in FAILs. Freeze tree during e2e runs.
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
