---
name: convex-cli
description: Operate Convex deployments with the `convex` CLI (pnpm exec convex): select a deployment, read/set env var names, run functions, read data and logs, deploy, check insights. Use for "set a Convex env var", "run this mutation on dev", "check Convex logs", "which deployment is this", "deploy Convex", or any task against a hosted Convex deployment rather than local tests.
---

# Convex CLI

Run the repo's pinned copy: `pnpm exec convex <command>` (root `convex/` is the canonical backend). `~/.convex/config.json` holds the owner's login; the CLI uses it for project and deployment commands.

## Know the target first

Every command acts on one deployment, chosen in this order: `--prod` / `--deployment <name>` flags, `CONVEX_DEPLOY_KEY`, then `CONVEX_DEPLOYMENT` from `.env.local`. A fresh worktree has no `.env.local`, so commands fail with "No CONVEX_DEPLOYMENT set" instead of guessing. Do not fix that by running `convex dev` (it pushes code and watches; `pnpm dev` is owner-only) or by copying another checkout's `.env.local` without saying so. State the target deployment in the command or in your message before any write.

Repo tests never need a hosted deployment: `pnpm test:convex` uses `convex-test`, and schema/race scripts make guarded local scratch projects under `.tmp/`.

## Reading

```bash
pnpm exec convex env list --names-only            # values are secrets
pnpm exec convex data                                 # tables
pnpm exec convex data <table> --limit 20
pnpm exec convex logs --history 50
pnpm exec convex function-spec
pnpm exec convex insights
```

Never paste env values or raw customer rows into chat, notes, PRs or CI output.

## Writing

- `convex env set` / `env remove`, `convex run <mutation>`, `convex deploy`, `convex import` change a live deployment. Production and shared dev hold the credit ledger: confirm with the owner first unless they already asked for that exact change.
- First activation of the rebuild is the owner-only [convex-activation runbook](../../notes/architecture/convex-activation.md). Routine automation and ad-hoc `convex deploy` must not perform it: it is paired with irreversible Durable Object migrations on the gateway.
- Production deploys run through `.github/workflows/deploy-production.yml`, not a local `convex deploy`.
- Wiping a dev deployment after a schema push fails: skill `convex-dev-reset-data`.
