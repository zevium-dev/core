// Offline guard for the official MCP Registry listing (#325). The registry's
// own `mcp-publisher validate` needs network, so the publish workflow runs it;
// this keeps server.json in step with the gateway on every CI run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const server = JSON.parse(read("server.json"));

// Bumping this requires reading the registry schema CHANGELOG first.
const SCHEMA_URL =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
const PUBLISHER_META = "io.modelcontextprotocol.registry/publisher-provided";

test("uses the pinned registry schema and required fields", () => {
  assert.equal(server.$schema, SCHEMA_URL);
  assert.match(server.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  assert.ok(server.description.length >= 1 && server.description.length <= 100);
  assert.ok(server.title.length >= 1 && server.title.length <= 100);
  // Registry versions are immutable and ranges are rejected.
  assert.match(server.version, /^\d+\.\d+\.\d+$/);
});

test("name sits in the DNS-verified zevium.dev namespace", () => {
  assert.ok(server.name.startsWith("dev.zevium/"));
});

test("remote is the production gateway MCP endpoint", () => {
  const route = /"pattern":\s*"([^"]+)",\s*"custom_domain":\s*true/.exec(
    read("apps/gateway/wrangler.jsonc"),
  )?.[1];
  assert.ok(route, "gateway custom domain route not found");
  assert.deepEqual(
    server.remotes.map((r) => [r.type, r.url]),
    [["streamable-http", `https://${route}/mcp`]],
  );
  for (const header of server.remotes[0].headers ?? []) {
    // A required header would block keyless search/docs and OAuth clients.
    assert.equal(header.isRequired, false);
    assert.equal(header.isSecret, true);
  }
});

test("publisher metadata stays within registry limits and matches gateway tools", () => {
  assert.deepEqual(Object.keys(server._meta), [PUBLISHER_META]);
  const meta = server._meta[PUBLISHER_META];
  assert.ok(Buffer.byteLength(JSON.stringify(meta)) <= 4096);
  const source = read("apps/gateway/src/mcp.ts");
  const start = source.indexOf("const TOOLS");
  const tools = source.slice(start, source.indexOf("\n];", start));
  const gatewayTools = [...tools.matchAll(/^ {4}name: "([a-z_]+)",$/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    meta["dev.zevium"].tools.map((t) => t.name),
    gatewayTools,
  );
});
