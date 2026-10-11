# Zevium CLI

Private workspace entry for generated listing commands. Nothing is published to npm.

```bash
pnpm --filter @zevium/cli zevium --help
pnpm --filter @zevium/cli zevium acme pets
pnpm --filter @zevium/cli zevium acme pets getpet_1 --help
# Set ZEVIUM_API_KEY in your environment before execution.
pnpm --filter @zevium/cli zevium acme pets getpet_1 --path-id pet-123
```

Command names and flags come from the listing's generated docs; names above are
illustrative. `ZEVIUM_GATEWAY_URL` defaults to `https://gateway.zevium.dev` and
accepts HTTPS origins or HTTP loopback for local development. API keys stay in the
environment, never command flags. Redirects fail rather than forwarding credentials.

Docs/help load `get_api_docs`. Execution sends one `call_api` request to the same
MCP endpoint with the key in its Authorization header. Gateway authentication,
credit reservation, settlement, rate limits, and refunds apply unchanged. The CLI
never reads publisher server URLs and never retries execution automatically.

String flags take literal strings; numeric, boolean, array, and body flags take
JSON. Required flags, duplicate/unknown flags, and JSON syntax are checked locally.
Schema constraints are documented for the caller; upstream validation remains
responsible for payload semantics. Defaults are never injected. Unsupported
operations appear in docs with diagnostic codes and have no generated command.

Docs identify the immutable published version used for generation. Gateway routes
execute the currently published version, so this entry does not promise version
pinning across publication changes. The converter format has its own version;
unrecognized formats fail visibly. Requests and streamed responses are capped at
1 MiB; each request times out after 15 seconds.

Listing-scoped MCP registration is tracked in #110. Consumer distribution is #451. Generated SDKs remain #350.
