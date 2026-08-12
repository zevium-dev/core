import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assertGeneratedFileFresh } from "./check-generated-routes.mjs";
import { inspectTurboLint } from "./check-turbo-lint.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixtures = resolve(import.meta.dirname, "fixtures");
const node = process.execPath;
const oxlint = resolve(repositoryRoot, "node_modules/.bin/oxlint");

function run(script, args = [], options = {}) {
  return spawnSync(node, [resolve(import.meta.dirname, script), ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    ...options,
  });
}

test("Turbo lint graph contains one runnable task per workspace package", () => {
  assert.deepEqual(inspectTurboLint(join(fixtures, "turbo-complete")), {
    packages: 2,
    tasks: 2,
  });
});

test("Turbo lint graph rejects package that can silently skip lint", () => {
  assert.throws(
    () => inspectTurboLint(join(fixtures, "turbo-missing")),
    /Turbo lint graph is skippable:.*missing=@fixture\/missing/,
  );
});

test("Oxlint rejects real hooks, accessibility, and security violations", () => {
  const result = spawnSync(
    oxlint,
    [
      "--config",
      resolve(repositoryRoot, ".oxlintrc.json"),
      "--no-ignore",
      join(fixtures, "lint-failures"),
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  const output = result.stdout + result.stderr;
  assert.match(output, /rules-of-hooks/);
  assert.match(output, /alt-text/);
  assert.match(output, /no-eval|detect-eval-with-expression/);
});

test("focused and skipped test calls fail against source fixture", () => {
  const result = run("check-test-focus.mjs", [join(fixtures, "focused-tests")]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /describe\.only/);
  assert.match(result.stderr, /test\.skip/);
});

test("invalid JSON and YAML files fail parser checks", () => {
  const result = run("check-structured-data.mjs", [
    join(fixtures, "invalid-structured-data"),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /broken\.json/);
  assert.match(result.stderr, /broken\.yaml/);
});

test("generated-file freshness check executes generator and detects drift", () => {
  const directory = mkdtempSync(join(tmpdir(), "zevium-route-fixture-"));
  copyFileSync(
    join(fixtures, "generator", "generated.ts"),
    join(directory, "generated.ts"),
  );
  copyFileSync(
    join(fixtures, "generator", "change.mjs"),
    join(directory, "change.mjs"),
  );
  const before = readFileSync(join(directory, "generated.ts"), "utf8");

  assert.throws(
    () =>
      assertGeneratedFileFresh({
        cwd: directory,
        file: "generated.ts",
        command: node,
        args: ["change.mjs"],
      }),
    /was stale/,
  );
  assert.notEqual(
    readFileSync(join(directory, "generated.ts"), "utf8"),
    before,
  );
});

test("oversized physical bundle fails measured budget", () => {
  const result = run("check-bundles.mjs", [
    "--root",
    join(fixtures, "oversized-bundle", "dist"),
    "--config",
    join(fixtures, "oversized-bundle", "budgets.json"),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Bundle budget failures/);
});

test("production build environment cannot be bypassed with skip flags", () => {
  const buildScript = resolve(repositoryRoot, "apps/web/scripts/build.mjs");
  const strippedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        ![
          "CLERK_PUBLISHABLE_KEY",
          "CLERK_SECRET_KEY",
          "VITE_CLERK_PUBLISHABLE_KEY",
          "VITE_CONVEX_URL",
          "VITE_GATEWAY_URL",
        ].includes(name),
    ),
  );
  const missing = spawnSync(node, [buildScript, "--check-env"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...strippedEnvironment, SKIP_ENV_VALIDATION: "true" },
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /required for a production build/);

  const complete = spawnSync(node, [buildScript, "--check-env"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...strippedEnvironment,
      CLERK_PUBLISHABLE_KEY: "fixture-public",
      CLERK_SECRET_KEY: "fixture-secret",
      VITE_CONVEX_URL: "https://fixture.invalid",
      VITE_GATEWAY_URL: "https://fixture.invalid",
    },
  });
  assert.equal(complete.status, 0, complete.stderr);
});
