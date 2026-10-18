# MCP Registry publish deferred

> Date: 2026-10-18 · Status: deferred · Decided by: owner

Owner on 2026-10-18: "dont publish mcp registry. we dont care about it for now."

- Do not publish `dev.zevium/mcp`. Leave repo variable `MCP_REGISTRY_PUBLISH_ENABLED` unset, so
  `publish-mcp-registry.yml` skips after production deploys, and do not dispatch it by hand.
- No apex DNS TXT record for registry auth until this is picked up again.
- Kept: `server.json`, the workflow, the offline guard, environment `mcp-registry` and its
  `MCP_REGISTRY_PRIVATE_KEY` secret (set up 2026-10-18, before this decision).
- #325 stays open for the later publish. Steps: [MCP Registry runbook](../architecture/mcp-registry.md).
