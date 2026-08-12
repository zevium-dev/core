import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assertGeneratedTargetsFresh } from "./check-generated-routes.mjs";
import { resolveScanRange } from "./check-gitleaks.mjs";
import { checkBundles } from "./check-bundles.mjs";
import { findBlockedTests } from "./check-test-focus.mjs";
import { inspectTurboLint, validateLintGraph } from "./check-turbo-lint.mjs";

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
    fileCounts: { "@fixture/alpha": 2, "@fixture/beta": 2 },
  });
});

test("Turbo lint graph rejects package that can silently skip lint", () => {
  assert.throws(
    () => inspectTurboLint(join(fixtures, "turbo-missing")),
    /@fixture\/missing: missing lint command/,
  );
});

test("Turbo lint graph rejects true, echo, and no-file bypass commands", () => {
  for (const command of [
    "true",
    "echo linted",
    "oxlint --config ../../.oxlintrc.json missing",
  ]) {
    assert.throws(
      () =>
        validateLintGraph(
          {
            packages: ["hostile"],
            tasks: [
              { task: "lint", package: "hostile", directory: ".", command },
            ],
          },
          repositoryRoot,
        ),
      /must execute oxlint directly|lint target does not exist/,
    );
  }
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
  assert.match(result.stderr, /test\.only/);
  assert.match(result.stderr, /suite\.skip/);
  assert.match(result.stderr, /fdescribe/);
  const allowed = mkdtempSync(join(tmpdir(), "zevium-focus-allowed-"));
  copyFileSync(
    join(fixtures, "focused-tests", "allowed.ts"),
    join(allowed, "allowed.ts"),
  );
  assert.deepEqual(findBlockedTests([allowed]), []);
});

test("invalid JSON and YAML files fail parser checks", () => {
  const result = run("check-structured-data.mjs", [
    join(fixtures, "invalid-structured-data"),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /broken\.json/);
  assert.match(result.stderr, /broken\.yaml/);
});

test("generated freshness isolates writes and detects every target mutation", () => {
  const directory = mkdtempSync(join(tmpdir(), "zevium-route-fixture-"));
  for (const file of ["generated.ts", "collateral.ts", "change.mjs"])
    copyFileSync(join(fixtures, "generator", file), join(directory, file));
  const beforeGenerated = readFileSync(join(directory, "generated.ts"), "utf8");
  const beforeCollateral = readFileSync(
    join(directory, "collateral.ts"),
    "utf8",
  );

  assert.throws(
    () =>
      assertGeneratedTargetsFresh({
        cwd: directory,
        targets: ["generated.ts", "collateral.ts"],
        command: node,
        args: ["change.mjs"],
      }),
    /Generated targets were stale:[\s\S]*collateral\.ts[\s\S]*generated\.ts/,
  );
  assert.equal(
    readFileSync(join(directory, "generated.ts"), "utf8"),
    beforeGenerated,
  );
  assert.equal(
    readFileSync(join(directory, "collateral.ts"), "utf8"),
    beforeCollateral,
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

test("bundle gate rejects missing extensions and forged provenance", () => {
  const directory = mkdtempSync(join(tmpdir(), "zevium-bundle-fixture-"));
  cpSync(join(fixtures, "oversized-bundle"), directory, { recursive: true });
  rmSync(join(directory, "dist", "server", "chunk.js"));
  assert.throws(
    () =>
      checkBundles({
        bundleRoot: join(directory, "dist"),
        configPath: join(directory, "budgets.json"),
      }),
    /server \.js has no measured artifacts|exceeds/,
  );

  const config = JSON.parse(
    readFileSync(join(directory, "budgets.json"), "utf8"),
  );
  config.measurement.baselineCommit = "0".repeat(40);
  writeFileSync(join(directory, "bad-provenance.json"), JSON.stringify(config));
  assert.throws(
    () =>
      checkBundles({
        bundleRoot: join(directory, "dist"),
        configPath: join(directory, "bad-provenance.json"),
      }),
    /baseline commit is missing or not an ancestor/,
  );

  config.measurement.baselineCommit =
    "e5e67d86037bed76e1b916a6970d7a87b4249fd4";
  config.measurement.headroomPercent = 99;
  writeFileSync(join(directory, "bad-headroom.json"), JSON.stringify(config));
  assert.throws(
    () =>
      checkBundles({
        bundleRoot: join(directory, "dist"),
        configPath: join(directory, "bad-headroom.json"),
      }),
    /headroomPercent must be between 0 and 20/,
  );
});

test("gitleaks commit-range mode catches a secret deleted from current tree", () => {
  const directory = mkdtempSync(join(tmpdir(), "zevium-gitleaks-fixture-"));
  const git = (...args) =>
    spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(git("init", "--quiet").status, 0);
  assert.equal(
    git("config", "user.email", "fixture@invalid.example").status,
    0,
  );
  assert.equal(git("config", "user.name", "Quality Fixture").status, 0);
  writeFileSync(join(directory, "README.md"), "fixture\n");
  assert.equal(git("add", ".").status, 0);
  assert.equal(git("commit", "--quiet", "-m", "fixture: base").status, 0);
  assert.throws(
    () => resolveScanRange(directory, "refs/remotes/origin/missing"),
    /base is unavailable; full history fetch required/,
  );
  const base = git("rev-parse", "HEAD").stdout.trim();
  writeFileSync(
    join(directory, "leak.env"),
    `GITHUB_TOKEN=${"ghp_" + randomBytes(27).toString("base64url")}\n`,
  );
  assert.equal(git("add", ".").status, 0);
  assert.equal(git("commit", "--quiet", "-m", "fixture: add secret").status, 0);
  rmSync(join(directory, "leak.env"));
  assert.equal(git("add", "-u").status, 0);
  assert.equal(
    git("commit", "--quiet", "-m", "fixture: delete secret").status,
    0,
  );
  const gitleaks = spawnSync("mise", ["which", "gitleaks"], {
    encoding: "utf8",
  }).stdout.trim();
  const result = spawnSync(
    gitleaks,
    ["git", "--no-banner", "--redact", `--log-opts=${base}..HEAD`, "."],
    { cwd: directory, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
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
