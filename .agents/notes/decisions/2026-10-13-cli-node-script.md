# CLI ships as a plain Node script

> Date: 2026-10-13 · Status: accepted; built in #451 implementation · Decided by: owner

## Decision

Distribute the CLI as one self-contained ESM JavaScript file with
`#!/usr/bin/env node`, requiring an installed Node runtime. Do not compile a
standalone native binary. Bundle shared code and zod; no runtime package install
or tsx dependency. Target Node >=22.12.0, chosen to support Node 22 LTS. This supersedes the initial
Node 24.15.0 floor; see [runtime revision](2026-10-13-cli-node-22-lts.md).

Serve it at the stable web path `/cli/zevium.mjs`. Build and copy the artifact during
the web build; do not commit generated output. Prepare `@zevium/cli` for npm
publication, but registry publication and deployment remain owner actions.

Keep execution exclusively through authenticated, credit-gated MCP `call_api`.
Document installation now in `/docs/agents` and `/llms.txt`.

## Compatibility policy

`GENERATOR_VERSION` is the integer wire-format major, currently 1. CLI acceptance
is explicitly pinned to supported major 1 rather than following the producer
constant automatically. Additive optional fields retain the major; incompatible
shapes or binding semantics require a new major and reviewed client support.
Reject unknown or malformed versions before paid execution. Publish a compatible
CLI before rolling out a new producer major.

## Delivery

Issue #451. Build, smoke and compatibility tests, installation docs, and owner-only
release process are recorded in [agent surface](../features/agent-surface.md#cli-distribution-451).
No package published, service deployed, or provider configuration changed by this work.
