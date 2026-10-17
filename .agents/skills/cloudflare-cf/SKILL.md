---
name: cloudflare-cf
description: Operate Cloudflare from the terminal with the new `cf` CLI (DNS records, zones, Workers, Durable Object namespaces, Builds triggers, any public Cloudflare API call). Use for "add a DNS record", "list zones", "check Workers Builds triggers", "what's deployed on the gateway Worker", or any Cloudflare account task. Gateway and web Worker deploys still go through Wrangler.
---

# Cloudflare `cf` CLI

`cf` (open beta, `npm i -g cf`, needs Node 22.18+) covers the public Cloudflare API with generated commands, and prints JSON on stdout with messages on stderr. Wrangler remains the tool for `apps/gateway` and `apps/web`: both use `wrangler.jsonc`, and `cf dev/build/deploy` would first want `cf migrate`. Do not migrate them without an owner decision; the release workflows, DO migration tags and activation runbook all assume Wrangler.

## Auth

`cf auth whoami` shows the active login. `cf auth login` opens a browser for approval, so the owner runs it (add `--no-browser` over SSH). `cf` keeps its own credentials and does not reuse a Wrangler login. `CLOUDFLARE_API_TOKEN` overrides the stored login, and `cf` also reads it from a `.env` in the current directory, so check which credential is live before writing.

## Finding commands

There are ~2,900 commands. Search instead of walking `--help` trees:

```bash
cf cli search "create dns record"        # quoted, one argument, up to 5 matches
cf schema dns records create             # API method, path, params and body fields
cf dns records create --help
```

Keep search queries anonymous (action and resource type only): no domains, IDs or names.

## Writing safely

Production lives here: zone `zevium.dev`, Workers `zevium-gateway` (`gateway.zevium.dev`) and `zevium-dev` (`www.zevium.dev`). A wrong DNS or Worker change takes the product offline, so:

- Preview with `--dry-run` first. It needs no credentials, and it does not resolve domain names, so pass the zone ID to see the real URL.
- Non-interactive deletes without `--force` print `Aborted.` and exit 0. Exit status 0 is not proof of deletion; list again.
- On some commands `--force` is also an API parameter (`cf workers delete --force` deletes Workers other Workers reference). Read `--help` before using it.
- Keep the existing SPF TXT at the apex. The MCP Registry TXT (`v=MCPv1; k=ed25519; p=...`) shares that name; see `.agents/notes/architecture/mcp-registry.md`.

Never print tokens or secret values. Record account and zone IDs in private operator records, not notes.

## Repo uses

- MCP Registry DNS auth record: [mcp-registry.md](../../notes/architecture/mcp-registry.md).
- Workers Builds trigger check before activation (`cf builds triggers list`), DO namespace listing: [convex-activation.md](../../notes/architecture/convex-activation.md).
- Worker secrets: still `pnpm --filter @zevium/gateway exec wrangler secret list --name <worker>`; `cf` can list them too, but the runbook steps are written for Wrangler.
