# MCP Registry server name is `dev.zevium/mcp`

> Date: 2026-10-17 · Status: accepted (built, not yet published, #325) · Decided by: owner

Zevium's remote `/mcp` server is listed in the official MCP Registry as `dev.zevium/mcp`. The
reverse-DNS `dev.zevium/` namespace shows the product domain, which GitHub-based
`io.github.zevium-dev/*` would hide, and it is proven by a DNS TXT record on `zevium.dev`.

The name is permanent once published: the registry lets only a version's status change (for
example deprecated), never its name. Renaming later means a new listing and deprecating this one.
Setup and automation: [mcp-registry](../architecture/mcp-registry.md).
