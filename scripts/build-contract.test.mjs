import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const PUBLIC_ENV = [
  "VITE_BUILD_SHA",
  "VITE_CLERK_PUBLISHABLE_KEY",
  "VITE_CONVEX_URL",
  "VITE_GATEWAY_URL",
];

function dryRun({ secret, gateway = "https://gateway.contract.test" }) {
  const result = spawnSync(
    "pnpm",
    ["exec", "turbo", "run", "build", "--dry=json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "true",
        CLERK_SECRET_KEY: secret,
        VITE_BUILD_SHA: "1111111111111111111111111111111111111111",
        VITE_CLERK_PUBLISHABLE_KEY: "pk_test_build_contract",
        VITE_CONVEX_URL: "https://build-contract.convex.cloud",
        VITE_GATEWAY_URL: gateway,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  const jsonStart = result.stdout.indexOf('{\n  "id"');
  assert.notEqual(jsonStart, -1, "Turbo dry JSON missing");
  return JSON.parse(result.stdout.slice(jsonStart));
}

test("Turbo build forwards exact public config and secret pass-through", () => {
  const config = JSON.parse(readFileSync(resolve(repoRoot, "turbo.json")));
  assert.deepEqual(config.tasks.build.env, PUBLIC_ENV);
  assert.deepEqual(config.tasks.build.passThroughEnv, ["CLERK_SECRET_KEY"]);
  assert.ok(config.tasks.build.outputs.includes("!dist/server/.dev.vars"));

  const dry = dryRun({ secret: "secret_build_contract_one" });
  const web = dry.tasks.find((task) => task.taskId === "web#build");
  assert.ok(web, "web#build missing from Turbo graph");
  assert.deepEqual(web.resolvedTaskDefinition.env, PUBLIC_ENV);
  assert.deepEqual(web.resolvedTaskDefinition.passThroughEnv, [
    "CLERK_SECRET_KEY",
  ]);
  assert.ok(web.excludedOutputs.includes("dist/server/.dev.vars"));
});

test("secret changes do not affect cache hash; public config changes do", () => {
  const first = dryRun({ secret: "secret_build_contract_alpha" });
  const second = dryRun({ secret: "secret_build_contract_beta" });
  const publicChange = dryRun({
    secret: "secret_build_contract_beta",
    gateway: "https://gateway-changed.contract.test",
  });
  const hash = (run) =>
    run.tasks.find((task) => task.taskId === "web#build")?.hash;
  assert.equal(hash(first), hash(second));
  assert.notEqual(hash(second), hash(publicChange));
});
