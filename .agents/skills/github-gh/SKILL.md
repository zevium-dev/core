---
name: github-gh
description: Repo-specific GitHub work with the `gh` CLI on zevium-dev/core: issues with labels, PRs into develop, CI runs and logs, workflow dispatch, repository variables, environments and environment secrets. Use for "open a PR", "file an issue", "why did CI fail", "rerun the workflow", "set a repo variable", "create the GitHub environment", or "add a secret".
---

# GitHub via `gh`

Repo `zevium-dev/core`, default branch `develop`. `gh auth status` shows the login; its token has `repo` scope, so variables, environments and secrets are writable.

## Issues

New work decided with the owner becomes an issue with one priority label (`P0`/`P1`/`P2`) and `area:*` labels, then `#N` goes into the roadmap and the feature note. `gh label list` shows what exists; don't invent labels.

## PRs

- Branch from `origin/develop`; title in Conventional Commits.
- Write the body to `.tmp/pr-<branch>.md` and pass `--body-file`. Shell-escaped bodies mangle markdown.
- Merge with merge commits (`gh pr merge --merge`), never squash or rebase: history is not rewritten here.
- Before merging, wait for CI: `gh pr checks <n> --watch`. On failure, `gh run view <id> --log-failed`.
- Media goes in via upload links in the PR, not commits.

## Variables, environments, secrets

These gate production: `CONVEX_REBUILD_ACTIVATED`, `CONVEX_REBUILD_PREVIEW_ACTIVATED` (deploys) and `MCP_REGISTRY_PUBLISH_ENABLED` (public, permanent registry listing). Flipping one starts real releases, so only the owner's explicit go for that variable counts.

```bash
gh variable list
gh variable set NAME --body value
gh api -X PUT repos/zevium-dev/core/environments/<env> \
  --input .tmp/env-<env>.json   # e.g. {"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
gh api -X POST repos/zevium-dev/core/environments/<env>/deployment-branch-policies -f name=develop -f type=branch
gh secret set NAME --env <env> < .tmp/secret-file   # stdin keeps the value out of argv and history
gh secret list --env <env>
```

Secret values never go on the command line, in chat or in notes. Delete temp files holding them right after use.

## Workflows

`ci.yml` (PR + develop), `deploy-production.yml`, `preview.yml`, `preview-cleanup.yml`, `publish-mcp-registry.yml`. Dispatch with `gh workflow run <file> --ref develop`; follow with `gh run watch`.
