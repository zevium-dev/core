# Dev environment

> Updated: 2026-10-10 (merged from former `TECH.md` repo-shape bullets and `.project/PLAN.md` environment/known facts)
> Related: [deploy](deploy.md), [testing](testing.md)

Facts an agent needs before running anything locally. Hard-won; keep them. If a fact stops being true, fix it here in the same change.

## Commands

```bash
pnpm install
pnpm dev            # do not run unless instructed
pnpm format         # format + lint fix
pnpm build && pnpm test && pnpm typecheck   # must be green after every change set
```

pnpm for everything. Never npm/yarn.

## Worktrees

- **T3 worktrees**: root `t3.json` runs setup asynchronously. Ignored `.env*` and `.dev.vars*` files are copied from `T3CODE_PROJECT_ROOT` without replacing existing worktree files. Linux requests reflinks through Node; macOS uses native `cp -c` for APFS, publishing the cloned file exclusively. Unsupported filesystems fall back to independent copies. `pnpm-workspace.yaml` enables pnpm 11.8's global virtual store and `clone-or-copy` for every install and subsequent command, sharing registry dependency graphs while workspace packages remain checkout-local. CI also validates native APFS cloning, shared dependency links, env copying, and types on macOS. CI and production continue using frozen installs.
- Worktree setup runs with trusted mise tools (`mise.toml`) — see [findings/worktree-setup.md](../findings/worktree-setup.md).

## Env files and secrets

- Convex: root `.env.local` (`CONVEX_DEPLOYMENT`, `CONVEX_URL`); push schema with `npx convex dev --once`.
- Clerk (web): `apps/web/.env.local` (`VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`); org slugs enabled.
- **Local web secrets**: `REGISTRY_KEY_PROJECTION_HMAC_SECRET` belongs in `apps/web/.dev.vars`. Match it to the Convex development deployment. Include Clerk bindings in this file too: Wrangler uses `.dev.vars` instead of dotenv files when it exists. Keep public Vite configuration in `.env.local`. Local `.dev.vars` files are ignored at every workspace depth.
- Gateway: `npx wrangler dev --port 8787` in `apps/gateway`; env in `apps/gateway/.dev.vars` (gitignored): `CLERK_SECRET_KEY`, `CONVEX_URL`, `GATEWAY_INTERNAL_SECRET=dev-internal-secret-1`.
- Full variable contract: `.env.example`.
- E2E API key lives in `.project/e2e-key.env` (gitignored). Never commit secrets into `agents/notes/`.

## Local services

- Web dev server: `apps/web` on http://localhost:3000 (may already be running).
- Gateway dev: http://localhost:8787.
- Seed: `pnpm seed` → `test+clerk_test@zevium.dev` / `zevium-test-password`, OTP `424242`, org `test-org`.
- Test org wallet is funded on BOTH planes (Convex `grantCredits` + gateway `/internal/grant`, refId `e2e:manual:grant:1`).

## Clerk quirks

- Clerk API keys: real prefix `ak_`; user-created keys have `subject=user_…` — org routing needs `claims.org_id`.
- Clerk password reset REVOKES existing sessions — re-sign-in all browser sessions after.
- Seed user password drifted once; reset via `clerk api /users/<id> -X PATCH -d '{"password":..., "skip_password_checks": true}'`.
- "Organizations feature required" nag was clerk-js caching a degraded environment fetch (dev-instance usage limits under e2e load) in a long-lived tab. Hard reload clears it. Not a config issue.

## Browser automation (agent-browser)

- Clerk sign-in: name-find "Continue" hits "Continue with Google"; CSS click on Clerk submit is inert → focus input + press Enter. OTP `424242` auto-submits on fill. Flow: `/sign-in` → factor-one → client-trust.
- `click` does NOT scroll target into view — below-fold clicks silently no-op. Always `eval scrollIntoView({block:'center'})` first, or `form.requestSubmit()` for submits.
- Sessions isolate via `AGENT_BROWSER_SESSION`; e2e suite uses its own.
- `eval` runs in an ISOLATED world: page-world JS props (e.g. CodeMirror `contentDOM.cmView`) are invisible. Dispatched events cross worlds — inject editor text via synthetic ClipboardEvent paste (see `e2e/02`).
- Editing `apps/web` files while an e2e run is in flight triggers Vite HMR reloads that wipe Clerk forms mid-fill → spurious sign-in failures. Freeze the tree during e2e runs.
