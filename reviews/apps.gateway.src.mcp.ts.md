# Tiger Review — `apps/gateway/src/mcp.ts`

## Verdict

Incorrect — the `call_api` tool reuses the metered pipeline correctly (no credit-gate
bypass; key is required and verified, zero balance blocks, no side door), but the MCP
layer introduces several real defects: query parameters cannot be forwarded to upstreams
(blocking a large class of GET APIs), raw internal error messages are leaked to the MCP
client, upstream responses are buffered into worker memory with no cap, and catalogue
search silently truncates to the first page. Plus minor issues below.

## File Stats

- File: `apps/gateway/src/mcp.ts` (559 lines)
- Reviewed with: `index.ts`, `discovery.ts`, `pipeline.ts`, `key-verifier.ts`,
  `headers.ts`, `catalogue-source.ts`, `packages/shared/src/openapi.ts`, `test/discovery-mcp.test.ts`.
- Auth/credit-gate audit: PASS. `call_api` builds a synthetic `Request` with
  `authorization: Bearer <key>`, then calls `handleGatewayRequest`, which runs
  `extractApiKey` → `keyVerifier.verify` → spec/visibility check → reserve/free-tier →
  proxy → settle/refund. No unmetered path; the `key`-arg fallback still goes through the
  same verify/reserve/settle pipeline. `/mcp` itself is unauthenticated, but
  `search_apis`/`get_api_docs` are public (parity with `/discovery`), and `call_api`
  requires a key. Consistent with the keyless `/mock` carve-out being the only anonymous path.

## Findings

### [P2] `call_api` cannot forward URL query parameters to upstreams

Location: `mcp.ts:103-153` (tool schema) and `mcp.ts:355-362` (URL construction).

The `call_api` input schema has `org`, `project`, `method`, `path`, `body`, `headers`,
`key` — but no `query` field. The synthetic gateway URL is built as
```
${origin}/gateway/${org}/${project}${remainderPath === "/" ? "" : remainderPath}
```
and `remainderPath` is taken verbatim from `args.path`. The pipeline then does
`upstreamUrl.search = new URL(request.url).search`, so the only way to pass a query string
is to embed `?` in `path`. But `matchOperation` calls `normalizePath` (no query stripping)
then `matchPathTemplate`, which splits on `/`; a segment like `echo?model=gpt-4` never
equals the template segment `echo`, so `matchOperation` returns `null` → `route_not_found`
(404) before any upstream call. Net effect: GET-style APIs that require query parameters
(e.g. `?model=`, `?limit=`, `?cursor=`) are **unusable through the MCP agent tool**,
even though they work fine through the direct `/gateway` HTTP path.

Impact: a whole class of published marketplace APIs is unreachable from the agent
endpoint — the primary surface MCP exists to serve. Functional correctness gap, not a
security issue.

Fix: add a `query` argument (object or string), or accept `path` containing a query
string and split it before route matching, then forward `search` to the pipeline. Minimal
version:
```suggestion
        path: {
          type: "string",
          description: "Endpoint path, e.g. /v1/chat/completions (query params via `query`)",
        },
        query: {
          type: "object",
          description: "Optional URL query parameters to forward upstream",
          additionalProperties: { type: "string" },
        },
```
and in `handleCallApi`, before building `route`, strip a trailing `?...` from `pathRaw`
into a search string, or build `url` with `new URLSearchParams(args.query)` appended.

---

### [P2] Raw internal error messages leaked to the MCP client

Location: `mcp.ts:479-482` (`handleRpc` `tools/call` catch).

```ts
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  return success(id, toolError(message));
}
```

Any uncaught throw inside `dispatchTool` is surfaced verbatim to the agent/client as a tool
error. `handleCallApi` is not fully guarded: `new Request(url, init)` can throw a
`TypeError` on a malformed URL, `response.text()` can reject, `JSON.stringify(args.body)`
can throw on circular input, and the pipeline calls `deps.specSource.getPublishedSpec`
and `env.WALLET.…` which are not wrapped in try/catch inside `handleGatewayRequest` — a
Convex/DO transport failure propagates with its raw message (hostnames, internal error
text, stack-derived strings). `search_apis`/`get_api_docs` also forward any throw from
`catalogueSource.listPublic` / `specSource.getPublishedSpec` if a source implementation
does not swallow.

Impact: violates the project rule "Never leak internal errors to users." The MCP client
is external (agent-driven, cross-origin via `withCors`); internal topology and error text
can leak. Triggerable by any caller posting a `tools/call` request.

Fix: log the raw error internally, return a generic message to the client.
```suggestion
      } catch (err) {
        console.error("mcp tools/call failed", err);
        return success(id, toolError("Internal error executing tool"));
      }
```

---

### [P2] `call_api` buffers the entire upstream response into worker memory with no cap

Location: `mcp.ts:384` (`const responseText = await response.text();`).

Unlike the direct `/gateway` path, which streams `upstreamRes.body` back to the client,
`handleCallApi` does `await response.text()`, then `JSON.stringify({ ..., body: responseText })`.
There is no size limit on the upstream body. A publisher upstream (or any upstream the
agent is pointed at) can return an arbitrarily large response, which is fully buffered,
then base64/JSON-escaped into a single JSON-RPC text content block — OOM risk for the
worker isolate, and a DoS amplifier since one MCP request forces a full buffer.

Impact: memory exhaustion / isolate crash. The credit gate does not bound response size;
the consumer is charged the fixed `x-zevium-cost` regardless of body size, so a cheap
endpoint with a huge body is an effective DoS vector against the gateway. Also silently
corrupts binary responses (images/files), which `text()` decodes as lossy UTF-8.

Fix: cap the buffered body (e.g. read with a `ReadableStream` reader up to N KB, truncate
with a marker) and surface binary via a size/content-type guard. At minimum:
```suggestion
  const responseText = await readCappedText(response, 256 * 1024);
```

---

### [P2] `search_apis` silently truncates to the first catalogue page

Location: `mcp.ts:203-206` (`handleSearchApis`).

```ts
const page = await deps.catalogueSource.listPublic({
  search: query.trim() === "" ? undefined : query,
});
```

`CataloguePage` is `{ items, nextCursor }`, but `nextCursor` is discarded — the tool
returns `matches` only, with no cursor field and no way for the agent to request the next
page. `listPublic` is paginated server-side; for any catalogue larger than one page,
`search_apis` returns an incomplete set with no signal that results were truncated. An
agent searching for an API that lives on page 2 will never find it.

Impact: silent data loss in the primary discovery surface for agents. Also, with an empty
query (`search: undefined`) the tool returns the entire first page *plus* a full
`endpoints` array per match (see next finding), so the worst-case context dump is bounded
only by the page size, while completeness is unbounded-incomplete.

Fix: thread `cursor` through the tool args and include `nextCursor` in the returned JSON;
document pagination so the agent can iterate.

---

### [P3] `search_apis` returns full `endpoints` for every match, contradicting its own guidance

Location: `mcp.ts:208-250` and the usage note at `mcp.ts:283`.

`search_apis` is documented as returning "compact matches," and `get_api_docs` exists
specifically so the agent can "load only the tools you need" after searching. Yet
`handleSearchApis` calls `endpointsFromSpec(parseSpec(...))` for every match and embeds
the full priced-endpoint list in each result. For a broad/empty search this dumps every
endpoint of every match into the agent context in one shot — the exact pattern the
`usageNotes` warn against. `get_api_docs` is therefore redundant with `search_apis`
rather than complementary.

Impact: context bloat / token cost for agent clients; design inconsistency. Not a
correctness bug.

Fix: omit `endpoints` from `search_apis` results (keep a single `endpointCount` or
`creditsFrom`/`creditsTo` summary), and let the agent call `get_api_docs` for the chosen
API.

---

### [P3] `call_api` silently drops `body` for GET/HEAD while still setting content-type

Location: `mcp.ts:366-376`.

```ts
if (args.body !== undefined && args.body !== null) {
  ... set body ...
  if (!headers.has("content-type")) headers.set("content-type", ...);
}
...
if (body !== undefined && method !== "GET" && method !== "HEAD") {
  init.body = body;
}
```

When `method` is `GET`/`HEAD` and the agent supplies a `body`, the body is computed and
`content-type` is set on the headers, but `init.body` is left undefined — the body is
silently discarded and a misleading `content-type` is forwarded. The agent gets no error
and no indication its payload was dropped.

Impact: confusing/incorrect agent behavior for GET-with-body calls. Low severity.

Fix: either reject `body` on GET/HEAD with a tool error, or skip body handling entirely
for those methods (do not set `content-type`).

---

## Summary

- Findings: 6 (P2: 4, P3: 2)
- P0: 0 · P1: 0 · P2: 4 · P3: 2
- Top 3:
  1. `call_api` cannot forward query parameters — blocks GET APIs needing `?` params.
  2. Raw internal error messages leaked to the MCP client via the `tools/call` catch.
  3. Upstream responses buffered with no size cap — OOM/DoS and binary corruption.

### Non-issues checked and cleared

- **Credit-gate bypass**: none. `call_api` routes through `handleGatewayRequest`; key
  verified, wallet reserve/free-tier/settle/refund all applied; zero balance → 402.
- **Key-auth on agent tool calls**: present. `key` arg or MCP `Authorization`/`x-api-key`
  header required; prefix-validated; never clobbered by `headers` arg; stripped from
  upstream by `filterRequestHeaders` (hop-by-hop incl. `authorization`/`x-api-key`).
- **`key`-arg prompt injection**: the `key` override only changes *which* wallet pays
  (still must verify); it cannot access private projects the caller's org doesn't own
  (visibility gate → 404). No privilege escalation.
- **Path traversal via `path`**: routing uses the manually-built `route.remainderPath`,
  not `new URL(request.url)`; `matchOperation`/`joinUpstreamUrl` use the same
  `normalizePath` path as the direct gateway, so MCP introduces no new traversal vector
  beyond the pre-existing `/gateway` path.
- **Internal-endpoint access via crafted `path`**: the synthetic URL is never fetched;
  `handleGatewayRequest` routes by `route` (org/project lookup), so `/internal/grant`
  etc. are unreachable from `call_api`.
