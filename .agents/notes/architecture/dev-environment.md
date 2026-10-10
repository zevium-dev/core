# Dev environment

> Updated: 2026-10-10 (seed runner, local Convex CSP, discovery origins; #384, #387, #392)
> Related: [deploy](deploy.md), [testing](testing.md)

Facts an agent needs before running anything locally. Hard-won; keep them. If a fact stops being true, fix it here in the same change.

## Commands

```bash
pnpm install
pnpm dev            # do not run unless instructed
pnpm format         # Prettier formatting
pnpm build && pnpm test && pnpm typecheck   # must be green after every change set
```

Use `mise exec -- pnpm ...` when pnpm is not on PATH. Never npm/yarn.

## Worktrees

- **T3 worktrees**: root `t3.json` runs setup asynchronously. Ignored `.env*` and `.dev.vars*` files are copied from `T3CODE_PROJECT_ROOT` without replacing existing worktree files. Linux requests reflinks through Node; macOS uses native `cp -c` for APFS, publishing the cloned file exclusively. Unsupported filesystems fall back to independent copies. `pnpm-workspace.yaml` enables pnpm 11.8's global virtual store and `clone-or-copy` for every install and subsequent command, sharing registry dependency graphs while workspace packages remain checkout-local. CI runs env-copy tests and workspace types on Linux; there is no separate macOS job. CI and production continue using frozen installs.
- Worktree setup runs with trusted mise tools (`mise.toml`) — see [findings/worktree-setup.md](../findings/worktree-setup.md).

## Env files and secrets

- Convex: root `.env.local` (`CONVEX_DEPLOYMENT`, `CONVEX_URL`); push schema with `mise exec -- pnpm exec convex dev --once`.
- Clerk (web): `apps/web/.env.local` (`VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`); org slugs enabled.
- **Local web secrets**: `REGISTRY_KEY_PROJECTION_HMAC_SECRET` belongs in `apps/web/.dev.vars`. Match it to the Convex development deployment. Include Clerk bindings in this file too: Wrangler uses `.dev.vars` instead of dotenv files when it exists. Keep public Vite configuration in `.env.local`. Root, web, and gateway `.dev.vars` paths are gitignored.
- Gateway: `mise exec -- pnpm exec wrangler dev --port 8787` in `apps/gateway`; env in `apps/gateway/.dev.vars` (gitignored): `CLERK_SECRET_KEY`, `CONVEX_URL`, `GATEWAY_INTERNAL_SECRET=dev-internal-secret-1`.
- Full variable contract: `.env.example`.
- Supply `E2E_API_KEY` through the environment for the optional paid consumer journey. Never commit keys or test credentials into `.agents/notes/`.

## Local services

- Web dev server: `apps/web` on http://localhost:3000 (may already be running).
- Gateway dev: http://localhost:8787.
- Local Convex: set `VITE_CONVEX_URL=http://127.0.0.1:3210` in `apps/web/.env.local` and point the gateway's `CONVEX_URL` / `CONVEX_SITE_URL` at the same local backend. Restart Vite after env changes. Dev CSP allows the exact loopback Convex WebSocket origin (`ws://127.0.0.1:3210`); production builds never add this insecure WebSocket allowance.
- Gateway discovery uses the incoming request origin. `apps/gateway/wrangler.jsonc` sets dev-only `host` to `localhost:8787` instead of letting Wrangler infer the production route. If changing the listener, also set the advertised origin, e.g. `mise exec -- pnpm exec wrangler dev --port 9876 --host localhost:9876`; for HTTPS use `--local-protocol https`. Deployed routes are unchanged; HTTPS requests produce HTTPS discovery links.
- Seed procedure: after `mise exec -- pnpm install --frozen-lockfile`, provide `CLERK_SECRET_KEY` for the Clerk test instance through the process environment or `apps/web/.env.local`, then run `mise exec -- pnpm seed`. The command uses the installed `tsx` runner and idempotently ensures the test user, `test-org`, and its admin membership. Existing users' passwords are not reset; use the password-reset procedure below if needed. This only seeds Clerk; it does not fund wallets or publish APIs.
- `mise exec -- pnpm seed --check` loads the seed imports without reading credentials or contacting Clerk. CI runs this smoke check to catch runner/module-resolution and deleted-export regressions.
- Seed sign-in: `test+clerk_test@zevium.dev` / `zevium-test-password`, OTP `424242`.
- Test org wallet is funded on BOTH planes (Convex `grantCredits` + gateway `/internal/grant`, refId `e2e:manual:grant:1`).

## Clerk quirks

- Clerk API keys: real prefix `ak_`; user-created keys have `subject=user_…` — org routing needs `claims.org_id`.
- Clerk password reset REVOKES existing sessions — re-sign-in all browser sessions after.
- Seed user password drifted once; reset via `clerk api /users/<id> -X PATCH -d '{"password":..., "skip_password_checks": true}'`.
- "Organizations feature required" nag was clerk-js caching a degraded environment fetch (dev-instance usage limits under e2e load) in a long-lived tab. Hard reload clears it. Not a config issue.

## Browser automation (agent-browser)

- Clerk sign-in: name-find "Continue" hits "Continue with Google"; CSS click on Clerk submit is inert → focus input + press Enter. OTP `424242` auto-submits on fill. Flow: `/sign-in` → factor-one → client-trust.
- `click` does NOT scroll target into view — below-fold clicks silently no-op. Always `eval scrollIntoView({block:'center'})` first, or `form.requestSubmit()` for submits.
- Sessions isolate via `AGENT_BROWSER_SESSION`; each E2E lane derives its own session from `E2E_SESSION_PREFIX`, including retries. The suite shares only temporary publisher/consumer fixtures.
- `eval` runs in an ISOLATED world: page-world JS props (e.g. CodeMirror `contentDOM.cmView`) are invisible. Dispatched events cross worlds — inject editor text via synthetic ClipboardEvent paste (see `e2e/02`).
- Editing `apps/web` files while an e2e run is in flight triggers Vite HMR reloads that wipe Clerk forms mid-fill → spurious sign-in failures. Freeze the tree during e2e runs.
