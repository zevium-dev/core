# MCP `call_api` splits into `call_api_read` and `call_api_write`

> Date: 2026-10-17 · Status: accepted (built, #324) · Decided by: owner

The Claude Connectors Directory rejects "a single tool that accepts both safe and unsafe methods"
with a `method` parameter ([research](../research/claude-connectors-directory.md)). The old
`call_api` was that tool, so it is replaced, with no compatibility alias:

- `call_api_read`: GET/HEAD only. `readOnlyHint: true`, `destructiveHint: false`.
- `call_api_write`: every other method. `destructiveHint: true`.

Both still spend credits, reach third-party upstreams (`openWorldHint: true`) and are not
idempotent (each call bills). Each tool rejects methods that belong to the other.

The generated contract (#428) names its tool in `operation.call.tool`, so `GENERATOR_VERSION`
moves to major 2 and the CLI supports major 2 only. Major-1 CLIs stop with an upgrade message.
