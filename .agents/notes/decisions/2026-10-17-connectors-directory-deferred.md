# Claude Connectors Directory submission deferred

> Date: 2026-10-17 · Status: deferred · Decided by: owner

Owner parked the claude.ai integration on 2026-10-17: "forget claude ai integration. todo later".

- Code from #324 stays: tool annotations, `call_api_read`/`call_api_write` split, no `key`
  argument, keyless OAuth sessions and auto-created MCP keys. These help every MCP client, not only
  claude.ai.
- Not pursued now: Anthropic policy confirmation (4A metering, 3F proxy permission), Clerk OAuth
  activation for claude.ai callbacks, live claude.ai acceptance, WAF allow for Anthropic's range,
  reviewer account and submission.
- Remaining checklist: [claude-connectors-directory](../research/claude-connectors-directory.md).
  #324 stays open for this later work.
