# MCP tools take no `key` argument

> Date: 2026-10-17 · Status: accepted (built, #324) · Decided by: owner

Secrets must not enter model context, transcripts or logs ([mcp-oauth](../research/mcp-oauth.md)
G3). MCP tools authenticate only through the connection: an API key in the `Authorization` /
`x-api-key` header, or an OAuth session. The `key` argument is gone from every tool schema. A call
that still passes `key` is refused with a tool error rather than silently ignored, so a client
never believes a pasted key was used.
