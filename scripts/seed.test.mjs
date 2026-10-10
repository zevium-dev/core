import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("documented seed command imports without credentials or network calls", () => {
  const result = spawnSync("pnpm", ["seed", "--check"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, CLERK_SECRET_KEY: "" },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /seed OK|membership:/);
});
