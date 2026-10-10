WAVE 4 — MCP + DISCOVERY LANE. Project: /home/tnfssc/Code/zevium. Read AGENTS.md, PRODUCT.md §Agent-facing surface, TECH.md, FLOW.md §3, apps/gateway code. Edit ONLY apps/gateway/ (+ packages/shared if needed).

1. Discovery index: GET /discovery — JSON list of published APIs with per-endpoint pricing metadata: pull from Convex catalogue:listPublic + specs (cache 60s). Shape: { apis: [{ name, org, slug, description, gatewayBaseUrl, endpoints: [{ method, path, credits, summary, freeTier? }] }] }.
2. MCP endpoint at /mcp (Streamable HTTP, @modelcontextprotocol/sdk — verify workerd compat; if SDK fights workerd, implement minimal JSON-RPC handler for initialize/tools-list/tools-call, that is acceptable):
   - tool search_apis({query}) → search catalogue (Convex listPublic search param), return compact matches with pricing
   - tool get_api_docs({org, project}) → endpoint list + pricing + usage notes from spec summaries
   - tool call_api({org, project, method, path, body?, headers?}) → REQUIRES api key from MCP client (Authorization header on the MCP request or key param) → route INTERNALLY through the same metered pipeline (reuse pipeline function directly — same verify/reserve/settle path; NO unmetered side door; this is a product invariant)
3. workerd tests: discovery shape, mcp tools list, call_api goes through pipeline (assert wallet reserve happened via fixture).
4. Tests + typecheck green.

End with `DONE:` or `BLOCKED:`.
