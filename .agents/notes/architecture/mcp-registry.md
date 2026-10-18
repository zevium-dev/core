# Official MCP Registry listing (#325)

Updated: 2026-10-18. Built, not activated: nothing has been published to the registry yet. **Publishing is deferred by the owner** ([decision](../decisions/2026-10-18-mcp-registry-publish-deferred.md)): keep `MCP_REGISTRY_PUBLISH_ENABLED` unset and add no DNS record until that changes. Done 2026-10-18: environment `mcp-registry` (deployment branch `develop`, no required reviewer) and its `MCP_REGISTRY_PRIVATE_KEY` secret. Still open: the apex DNS TXT record (step 1), repo variables `PRODUCTION_GATEWAY_URL` and `MCP_REGISTRY_PUBLISH_ENABLED` (step 4; no repo variables exist yet), first publish (step 5).

Zevium's remote `/mcp` server is described by root `server.json` and listed in the official MCP Registry (`registry.modelcontextprotocol.io`, still in preview) as `dev.zevium/mcp`. Aggregators (Glama, Kong, client marketplaces) mirror that registry, so one listing reaches all of them. Product context: [agent-surface](../features/agent-surface.md).

## What is listed

- Schema `2025-12-11` (current per `mcp-publisher` 1.8.1 `CurrentSchemaVersion`). The registry rejects deprecated schema URLs on publish, so read the registry's `docs/reference/server-json/CHANGELOG.md` before bumping it.
- One `streamable-http` remote: `https://gateway.zevium.dev/mcp`. The registry lets each remote URL belong to one server name, and it does not check URL ownership.
- An optional secret `Authorization: Bearer {zevium_api_key}` header. It stays optional because OAuth clients send no static key: first connect auto-creates their MCP key. Without OAuth the key is needed for `call_api_read`/`call_api_write`. The description does not promise keyless `search_apis`/`get_api_docs`: once MCP OAuth is configured, an unauthenticated `/mcp` request gets a 401 challenge, and published registry versions are immutable, so the text must stay true in both modes. Tools take no `key` argument. A required header would make OAuth clients demand a key up front.
- The server.json format has no tools field. Tool names and one-line summaries go under `_meta["io.modelcontextprotocol.registry/publisher-provided"]["dev.zevium"]`. That is the only `_meta` key the registry keeps, and it is capped at 4 KiB.
- `version` is the listing version, independent of gateway `SERVER_INFO.version` and of releases. Registry versions are immutable: a listing change must bump `version` (semver), or it is never published.

## Namespace auth: DNS, not HTTP

Name `dev.zevium/*` requires proof of control of `zevium.dev`. Both domain methods use an Ed25519 key, and the public half is published as `v=MCPv1; k=ed25519; p=<base64>`.

- **HTTP** (`https://zevium.dev/.well-known/mcp-registry-auth`) does not work as deployed: apex `zevium.dev` 301-redirects to `www.zevium.dev`, and the registry's fetcher refuses redirects. Making it work needs a Cloudflare redirect exception plus a web deploy. HTTP auth also grants only `dev.zevium/*`, with no subdomains.
- **DNS** needs one TXT record at the apex in Cloudflare and no code or deploy. It also covers `dev.zevium.*` subdomain namespaces. Chosen.

GitHub OIDC was not used: it only grants `io.github.zevium-dev/*`, which hides the domain.

## Automation

`.github/workflows/publish-mcp-registry.yml` runs after every successful `Deploy Production` run of `develop` from this repository (head branch and head repository checked, not only the trigger filter), or by manual dispatch on `develop`. It is gated by repo variable `MCP_REGISTRY_PUBLISH_ENABLED=true` and runs in the protected `mcp-registry` environment. Steps:

1. Look up `name@version` in the registry. If it is already listed, the run ends green. If the listed copy differs from `server.json`, the run warns: bump the version.
2. Check that the remote equals `vars.PRODUCTION_GATEWAY_URL` + `/mcp`, and that a keyless `initialize` either answers 200 as `zevium-gateway` (MCP OAuth off) or 401 with `WWW-Authenticate: Bearer resource_metadata="<gateway>/.well-known/oauth-protected-resource/mcp"`, whose metadata returns 200 naming this remote as `resource` (MCP OAuth on). Any other answer fails the run.
3. Install `mcp-publisher` at the pinned version, check its SHA-256, then run `validate`, `login dns --domain zevium.dev`, `publish`, and verify the listing.

Production deploys only run when `CONVEX_REBUILD_ACTIVATED=true`. Until then, publish by manual dispatch.

Offline guard: `pnpm test:mcp-registry` (part of `pnpm test`/`ci:pr`) checks the pinned schema URL, field limits, `dev.zevium/` name, that the remote matches the gateway `wrangler.jsonc` custom domain, that the header is optional, the 4 KiB meta cap, and that the meta tool list equals the gateway `TOOLS`. Full schema validation runs through the registry API (`mcp-publisher validate`) in the workflow. Locally, use the binary from the release page and run `mcp-publisher validate` at the repo root. It is read-only and needs no login.

Upgrading `mcp-publisher`: update `MCP_PUBLISHER_VERSION` and `MCP_PUBLISHER_SHA256` from that release's `registry_<v>_checksums.txt`. Old binaries fail with "invalid audience" when the registry moves on.

## Owner one-time steps (not done by the implementation)

Run in bash, with OpenSSL 3, in a private directory. Never commit the key.

```bash
openssl genpkey -algorithm Ed25519 -out mcp-registry-key.pem
PUBLIC_KEY="$(openssl pkey -in mcp-registry-key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "TXT zevium.dev: v=MCPv1; k=ed25519; p=${PUBLIC_KEY}"
PRIVATE_KEY="$(openssl pkey -in mcp-registry-key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
```

1. **DNS:** in Cloudflare zone `zevium.dev`, add a TXT record with name `@` (the apex, not `_mcp-registry` or any other selector) and content `v=MCPv1; k=ed25519; p=<PUBLIC_KEY>`. Keep the existing SPF TXT. When rotating, delete the old MCP TXT record, because a stale record breaks verification. Check with `dig +short TXT zevium.dev`.
2. **GitHub environment:** create environment `mcp-registry` in `zevium-dev/core`. Restrict deployment branches to `develop`. A required reviewer is optional; it makes each publish wait for approval.
3. **Secret:** add environment secret `MCP_REGISTRY_PRIVATE_KEY` = the 64-hex-char `$PRIVATE_KEY`. Then store the `.pem` in the password manager and delete it locally.
4. **Enable:** set repository variable `MCP_REGISTRY_PUBLISH_ENABLED=true`. Make sure `PRODUCTION_GATEWAY_URL` is `https://gateway.zevium.dev`.
5. **First publish:** go to Actions → Publish MCP Registry → Run workflow on `develop`. Then confirm with `curl -s 'https://registry.modelcontextprotocol.io/v0.1/servers/dev.zevium%2Fmcp/versions/latest'`.

Optional manual login check before step 5: `mcp-publisher login dns --domain zevium.dev --private-key "$PRIVATE_KEY"`. It only exchanges a token and publishes nothing.

## Open questions

- Resolved 2026-10-17: owner confirmed server name `dev.zevium/mcp`, permanent once published. [Decision](../decisions/2026-10-17-mcp-registry-name.md).
- Icon uses `https://www.zevium.dev/logo.svg`; `logo512.png` returns 404 on production today. Some clients render only PNG/JPEG.
- Header description mentions OAuth as the alternative to a key. The registry has no OAuth field: clients discover it from `/mcp` protected-resource metadata.
