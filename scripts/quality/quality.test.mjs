import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const githubTokenAlphabet =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function fakeGithubToken() {
  const limit = 256 - (256 % githubTokenAlphabet.length);
  let suffix = "";
  while (suffix.length < 36) {
    for (const byte of randomBytes(36)) {
      if (byte >= limit) continue;
      suffix += githubTokenAlphabet[byte % githubTokenAlphabet.length];
      if (suffix.length === 36) break;
    }
  }
  return `ghp_${suffix}`;
}
import {
  compareBundleMeasurements,
  measureBundle,
  overlayCandidateSnapshot,
  resolveBundleBaseline,
  validateBundleContract,
} from "./check-bundles.mjs";
import {
  assertAnonymousLocalConvex,
  assertGeneratedTargetsFresh,
  sanitizedConvexEnvironment,
} from "./check-generated-routes.mjs";
import {
  createCurrentTreeSnapshot,
  gitleaksCommands,
  resolveScanPlan,
  validateGitleaksPolicy,
} from "./check-gitleaks.mjs";
import {
  attestVitestCommands,
  attestVitestConfig,
  attestVitestConfigs,
  findBlockedTests,
} from "./check-test-focus.mjs";
import {
  attestLintTask,
  inspectTurboLint,
  validateLintGraph,
} from "./check-turbo-lint.mjs";
import {
  attestMiseRuntime,
  checkWorkflowToolchains,
  validateWorkflowToolchain,
} from "./check-workflow-toolchains.mjs";
import {
  assertNoExcludedSourceImports,
  attestIgnorePolicies,
  collectOwnedFiles,
  scriptExtensions,
} from "./source-inventory.mjs";
import {
  assertNoExecutableArtifacts,
  runTrackedCommand,
} from "./tracked-tree.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixtures = resolve(import.meta.dirname, "fixtures");
const node = process.execPath;
const oxlint = resolve(repositoryRoot, "node_modules/.bin/oxlint");
const vitest = resolve(repositoryRoot, "node_modules/.bin/vitest");
const zeroSha = "0".repeat(40);

function run(script, args = [], options = {}) {
  return spawnSync(node, [resolve(import.meta.dirname, script), ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    ...options,
  });
}

function write(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function gitRepository() {
  const directory = mkdtempSync(join(tmpdir(), "zevium-git-fixture-"));
  const git = (...args) =>
    spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(git("init", "--quiet", "--initial-branch=develop").status, 0);
  assert.equal(
    git("config", "user.email", "fixture@invalid.example").status,
    0,
  );
  assert.equal(git("config", "user.name", "Quality Fixture").status, 0);
  write(join(directory, "README.md"), "base\n");
  assert.equal(git("add", ".").status, 0);
  assert.equal(git("commit", "--quiet", "-m", "fixture: base").status, 0);
  const base = git("rev-parse", "HEAD").stdout.trim();
  write(join(directory, "README.md"), "head\n");
  assert.equal(git("add", ".").status, 0);
  assert.equal(git("commit", "--quiet", "-m", "fixture: head").status, 0);
  const head = git("rev-parse", "HEAD").stdout.trim();
  return { directory, git, base, head };
}

test("workflow toolchains pin mise, Node, pnpm, and frozen installs", () => {
  assert.equal(checkWorkflowToolchains(), 13);
  assert.equal(attestMiseRuntime(), 5);
  const source = readFileSync(
    resolve(repositoryRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  const hostile = [
    source.replace("version: 2026.7.13", "version: latest"),
    source.replace(
      "pnpm install --frozen-lockfile",
      "pnpm install --no-frozen-lockfile",
    ),
    source.replace(
      "jdx/mise-action@7e36c90d9ab29c415a2384db3006f3ec8a8cc654",
      "jdx/mise-action@v4",
    ),
    source.replace("install_args: node@24.15.0", "install_args: node@latest"),
    source.replace(
      "      - name: Run uncached PR quality gate",
      "      - name: Hostile mutable reinstall\n        run: pnpm install --no-frozen-lockfile\n      - name: Run uncached PR quality gate",
    ),
    source.replace(
      'test "$(pnpm --version)" = "11.8.0"',
      'test "$(pnpm --version)" = "11.8.0"\n          pnpm config set verify-store-integrity false',
    ),
    source.replace(
      [
        "      - uses: jdx/mise-action@7e36c90d9ab29c415a2384db3006f3ec8a8cc654 # v4",
        "        with:",
        "          version: 2026.7.13",
        "          install: true",
        "          install_args: node@24.15.0 npm:pnpm@11.8.0 actionlint@1.7.12 gitleaks@8.30.1 shellcheck@0.11.0",
      ].join("\n"),
      "      - name: Hostile dependency bootstrap\n        run: npx vitest",
    ),
  ];
  for (const [index, workflow] of hostile.entries()) {
    const directory = mkdtempSync(join(tmpdir(), "zevium-workflow-hostile-"));
    const path = join(directory, `hostile-${index}.yml`);
    write(path, workflow);
    assert.throws(
      () => validateWorkflowToolchain(path),
      /mise action|mise bootstrap|binary version|install_args|verification|frozen pnpm install|additional pnpm install|dependency command/,
    );
  }
});

test("Turbo lint attests every exact owned file and executes production commands", () => {
  const result = inspectTurboLint(join(fixtures, "turbo-complete"));
  assert.deepEqual(result.fileCounts, {
    "@fixture/alpha": 3,
    "@fixture/beta": 2,
  });
  assert.deepEqual(result.ownedFiles["@fixture/alpha"], [
    "packages/alpha/src/dist/nested.js",
    "packages/alpha/src/extra.js",
    "packages/alpha/src/index.js",
  ]);
  assert.deepEqual(result.ownedFiles["@fixture/beta"], [
    "packages/beta/src/extra.js",
    "packages/beta/src/index.js",
  ]);
});

test("Turbo lint rejects missing, partial, ignored, and weakened scopes", () => {
  assert.throws(
    () => inspectTurboLint(join(fixtures, "turbo-missing")),
    /@fixture\/missing: missing lint command/,
  );
  for (const command of ["true", "echo linted"]) {
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
      /must execute oxlint directly/,
    );
  }

  const workspace = join(fixtures, "turbo-complete");
  const prefix =
    "oxlint --config ../../../../../../.oxlintrc.json --deny-warnings --report-unused-disable-directives --no-ignore --disable-nested-config";
  for (const [command, pattern] of [
    [`${prefix} src/index.js`, /ignored\/missing owned file/],
    [
      `${prefix.replace(" --disable-nested-config", "")} src`,
      /disable nested configs/,
    ],
    [`${prefix} --allow=correctness src`, /weakening or config override/],
    [
      `${prefix} --ignore-pattern=src/extra.js src`,
      /weakening or config override/,
    ],
    [
      "oxlint --config package.json --deny-warnings --report-unused-disable-directives --no-ignore --disable-nested-config src",
      /exact root config/,
    ],
    [
      "oxlint --config ../../../../../../.oxlintrc.json --report-unused-disable-directives --no-ignore --disable-nested-config src",
      /deny warnings/,
    ],
  ]) {
    assert.throws(
      () =>
        attestLintTask({
          workspace,
          task: {
            package: "@fixture/alpha",
            directory: "packages/alpha",
            command,
          },
        }),
      pattern,
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

test("lint attestation rejects source-level suppression bypasses", () => {
  const workspace = mkdtempSync(join(tmpdir(), "zevium-lint-suppression-"));
  write(
    join(workspace, "index.ts"),
    `/* eslint-${"disable"} no-eval */\nexport const hidden = eval;\n`,
  );
  assert.throws(
    () =>
      attestLintTask({
        workspace,
        task: {
          package: "hostile",
          directory: ".",
          command: `oxlint --config ${resolve(repositoryRoot, ".oxlintrc.json")} --deny-warnings --report-unused-disable-directives --no-ignore --disable-nested-config index.ts`,
        },
      }),
    /lint suppression directives are forbidden/,
  );
});

test("focus scanner catches computed, assigned, aliased, and wrapper imports", () => {
  const focusedRoot = join(fixtures, "focused-tests");
  const violations = findBlockedTests([focusedRoot]);
  const output = violations.join("\n");
  assert.match(output, /focused\.test\.ts.*describe\.only/);
  assert.match(output, /focused\.test\.ts.*test\.skip/);
  assert.match(output, /focused\.test\.ts.*test\.only/);
  assert.match(output, /focused\.test\.ts.*test\.<computed>/);
  assert.match(output, /focused\.test\.ts.*suite\.skip/);
  assert.match(output, /focused\.test\.ts.*fdescribe/);
  assert.match(output, /wrapper-consumer\.test\.ts.*test\.only/);
  assert.match(output, /wrapper-consumer\.test\.ts.*test\.skip/);

  const allowed = mkdtempSync(join(tmpdir(), "zevium-focus-shadowed-"));
  copyFileSync(
    join(focusedRoot, "shadowed.test.ts"),
    join(allowed, "shadowed.test.ts"),
  );
  assert.deepEqual(findBlockedTests([allowed]), []);
});

test("Vitest configs and commands force allowOnly false without mutable indirection", () => {
  assert.equal(attestVitestConfigs().length, 5);
  assert.equal(attestVitestCommands(), 5);

  const directory = mkdtempSync(join(tmpdir(), "zevium-vitest-config-"));
  const configPath = join(directory, "vitest.config.ts");
  const valid = [
    'import { defineConfig as define } from "vitest/config";',
    "export default define({ test: { allowOnly: false } });",
    "",
  ].join("\n");
  write(configPath, valid);
  assert.doesNotThrow(() => attestVitestConfig(configPath));
  const nestedConfig = join(directory, "src/dist/vitest.config.ts");
  const workspaceConfig = join(directory, "vitest.workspace.ts");
  write(nestedConfig, valid);
  write(workspaceConfig, valid);
  assert.deepEqual(
    attestVitestConfigs([directory], {
      excludeFixtures: false,
      requireRepositorySet: false,
    }),
    [nestedConfig, configPath, workspaceConfig].sort(),
  );

  const hostile = [
    valid.replace("allowOnly: false", "allowOnly: true"),
    [
      'import { defineConfig } from "vitest/config";',
      "const config = { test: { allowOnly: false } };",
      "export default defineConfig(config);",
      "config.test.allowOnly = true;",
      "",
    ].join("\n"),
    [
      'import { defineConfig } from "vitest/config";',
      "const hostile = { allowOnly: true };",
      "export default defineConfig({ test: { allowOnly: false, ...hostile } });",
      "",
    ].join("\n"),
    [
      'import { defineConfig } from "vitest/config";',
      'export default defineConfig({ test: { ["allow" + "Only"]: false } });',
      "",
    ].join("\n"),
    [
      'import { defineConfig } from "vitest/config";',
      "export default defineConfig({ test: { allowOnly: false, allowOnly: true } });",
      "",
    ].join("\n"),
  ];
  for (const [index, source] of hostile.entries()) {
    const path = join(directory, `vitest.workspace.config-${index}.ts`);
    write(path, source);
    assert.throws(
      () => attestVitestConfig(path),
      /allowOnly|inline immutable|spreads|computed|exactly one/,
    );
  }
});

test("Vitest CLI enforcement rejects focused execution even against hostile config", () => {
  const directory = mkdtempSync(join(tmpdir(), "zevium-vitest-runtime-"));
  const config = join(directory, "vitest.config.mjs");
  write(
    config,
    "export default { test: { allowOnly: true, globals: true } };\n",
  );
  write(
    join(directory, "focus.test.js"),
    [
      'test("ordinary", () => {});',
      'test.only("forbidden focus", () => {});',
      "",
    ].join("\n"),
  );
  const result = spawnSync(
    vitest,
    [
      "run",
      "--root",
      directory,
      "--config",
      config,
      "--allowOnly=false",
      "--reporter=dot",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, CI: "true" },
    },
  );
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Unexpected \.only modifier/);
});

test("source inventory scans nested generated-looking names and rejects excluded imports", () => {
  const repository = mkdtempSync(join(tmpdir(), "zevium-source-inventory-"));
  const nested = join(repository, "apps/web/src/dist/runtime.ts");
  const entry = join(repository, "apps/web/src/entry.ts");
  write(
    join(repository, "apps/web/tsconfig.json"),
    JSON.stringify({
      compilerOptions: { paths: { "hostile/*": ["./src/*"] } },
      include: ["src"],
    }),
  );
  write(nested, "export const runtime = true;\n");
  write(entry, 'import { runtime } from "./dist/runtime";\nvoid runtime;\n');
  const files = collectOwnedFiles({
    roots: [join(repository, "apps/web")],
    repository,
    extensions: scriptExtensions,
  });
  assert.ok(files.includes(nested));
  assert.doesNotThrow(() => assertNoExcludedSourceImports(files, repository));

  const excluded = join(repository, "apps/web/dist/runtime.ts");
  write(excluded, "export const runtime = true;\n");
  write(entry, 'import { runtime } from "../dist/runtime";\nvoid runtime;\n');
  const owned = collectOwnedFiles({
    roots: [join(repository, "apps/web")],
    repository,
    extensions: scriptExtensions,
  });
  assert.equal(owned.includes(excluded), false);
  assert.throws(
    () => assertNoExcludedSourceImports(owned, repository),
    /imports excluded web build output/,
  );

  write(
    entry,
    'import { runtime } from "hostile/../dist/runtime";\nvoid runtime;\n',
  );
  assert.throws(
    () => assertNoExcludedSourceImports(owned, repository),
    /imports excluded web build output/,
  );

  write(
    join(repository, "packages/shared/package.json"),
    JSON.stringify({ name: "@fixture/shared", exports: "./dist/runtime.ts" }),
  );
  write(
    join(repository, "packages/shared/dist/runtime.ts"),
    "export const runtime = true;\n",
  );
  write(entry, 'import { runtime } from "@fixture/shared";\nvoid runtime;\n');
  assert.throws(
    () => assertNoExcludedSourceImports(owned, repository),
    /imports excluded shared-package build output/,
  );

  const focused = join(repository, "apps/web/src/dist/focused.test.ts");
  write(focused, 'test[`on${"ly"}`]("hostile", () => undefined);\n');
  write(entry, 'import "./dist/focused.test";\n');
  assert.match(
    findBlockedTests([join(repository, "apps/web/src")], { repository }).join(
      "\n",
    ),
    /test\.only/,
  );
});

test("ignore policies anchor generated roots without hiding nested source", () => {
  assert.equal(attestIgnorePolicies(repositoryRoot), 18);
});

test("invalid JSON and YAML files fail parser checks", () => {
  const result = run("check-structured-data.mjs", [
    join(fixtures, "invalid-structured-data"),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /broken\.json/);
  assert.match(result.stderr, /broken\.yaml/);
});

test("generated freshness isolates writes and catches target plus collateral drift", () => {
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
        targets: ["generated.ts"],
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

test("Convex generation strips live targets and requires anonymous loopback config", () => {
  const environment = sanitizedConvexEnvironment({
    CONVEX_AGENT_MODE: "production",
    CONVEX_DEPLOYMENT: "prod:hostile",
    CONVEX_SELF_HOSTED_URL: "https://hostile.invalid",
    CONVEX_URL: "https://hostile.invalid",
    SAFE_VALUE: "preserved",
  });
  assert.equal(environment.CONVEX_AGENT_MODE, "anonymous");
  assert.equal(environment.CLERK_JWT_ISSUER_DOMAIN, "https://clerk.invalid");
  assert.equal(environment.SAFE_VALUE, "preserved");
  assert.equal(Object.hasOwn(environment, "CONVEX_DEPLOYMENT"), false);
  assert.equal(Object.hasOwn(environment, "CONVEX_SELF_HOSTED_URL"), false);
  assert.equal(Object.hasOwn(environment, "CONVEX_URL"), false);

  const directory = mkdtempSync(join(tmpdir(), "zevium-convex-local-"));
  write(
    join(directory, ".env.local"),
    [
      "CONVEX_DEPLOYMENT=anonymous:fixture",
      "CONVEX_URL=http://127.0.0.1:3210",
      "CONVEX_SITE_URL=http://127.0.0.1:3211",
      "",
    ].join("\n"),
  );
  assert.doesNotThrow(() => assertAnonymousLocalConvex(directory));
  write(
    join(directory, ".env.local"),
    [
      "CONVEX_DEPLOYMENT=prod:hostile",
      "CONVEX_URL=https://hostile.invalid",
      "CONVEX_SITE_URL=https://hostile.invalid",
      "",
    ].join("\n"),
  );
  assert.throws(
    () => assertAnonymousLocalConvex(directory),
    /not pinned to anonymous local deployment/,
  );
});

test("tracked-tree guard catches mutations missed by git diff --check", () => {
  const { directory } = gitRepository();
  write(
    join(directory, "mutate.mjs"),
    'import { writeFileSync } from "node:fs"; writeFileSync("README.md", "mutated\\n");\n',
  );
  const git = (...args) =>
    spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(git("add", "mutate.mjs").status, 0);
  assert.equal(git("commit", "--quiet", "-m", "fixture: mutator").status, 0);
  assert.throws(
    () =>
      runTrackedCommand({
        cwd: directory,
        command: node,
        args: ["mutate.mjs"],
        stdio: "pipe",
      }),
    /mutated tracked tree:[\s\S]*README\.md/,
  );
});

function measurement(value) {
  return new Map(
    [
      ["client", ".js"],
      ["client", ".css"],
      ["server", ".js"],
      ["server", ".css"],
    ].map(([target, extension]) => [
      `${target}:${extension}`,
      {
        target,
        extension,
        files: value,
        totalBytes: value * 100,
        totalGzipBytes: value * 50,
        fileBytes: value * 20,
        fileGzipBytes: value * 10,
      },
    ]),
  );
}

test("bundle comparison uses measured baseline, permits reductions, rejects inflation", () => {
  assert.doesNotThrow(() =>
    compareBundleMeasurements(measurement(10), measurement(9)),
  );
  const splitReduction = measurement(9);
  splitReduction.get("client:.js").files = 20;
  assert.doesNotThrow(() =>
    compareBundleMeasurements(measurement(10), splitReduction),
  );
  const inflated = measurement(10);
  inflated.get("client:.js").totalBytes = 1_051;
  assert.throws(
    () => compareBundleMeasurements(measurement(10), inflated),
    /exceeds measured baseline/,
  );
});

function bundleFixture() {
  const repository = mkdtempSync(join(tmpdir(), "zevium-bundle-contract-"));
  const bundleRoot = join(repository, "apps/web/dist");
  const client = join(bundleRoot, "client");
  const server = join(bundleRoot, "server");
  write(join(repository, "apps/web/src/routes/__root.tsx"), "export {};\n");
  write(join(repository, "apps/web/src/routes/index.tsx"), "export {};\n");
  write(join(client, "assets/index.js"), "export const route = 1;\n");
  write(join(client, "assets/styles.css"), ":root{color:black}\n");
  write(join(server, "assets/index.js"), "export const route = 1;\n");
  write(join(server, "assets/styles.css"), ":root{color:black}\n");
  write(join(server, "index.js"), "export default {};\n");
  write(
    join(server, "wrangler.json"),
    JSON.stringify({ main: "index.js", assets: { directory: "../client" } }),
  );
  const routeEntry = {
    "src/routes/index.tsx?tsr-split=component": {
      file: "assets/index.js",
    },
  };
  const serverEntry = {
    ...routeEntry,
    "src/routes/__root.tsx?tss-serverfn-split": {
      file: "assets/index.js",
    },
  };
  const ssrEntry = {
    "src/routes/__root.tsx": ["/assets/index.js"],
    "src/routes/index.tsx": ["/assets/index.js"],
  };
  write(join(client, ".vite/manifest.json"), JSON.stringify(routeEntry));
  write(join(client, ".vite/ssr-manifest.json"), JSON.stringify(ssrEntry));
  write(join(server, ".vite/manifest.json"), JSON.stringify(serverEntry));
  write(join(server, ".vite/ssr-manifest.json"), JSON.stringify(ssrEntry));
  return { repository, bundleRoot, client, server };
}

test("bundle artifacts reject missing, zero, and route/manifest bypasses", () => {
  const fixture = bundleFixture();
  assert.equal(
    validateBundleContract({
      bundleRoot: fixture.bundleRoot,
      repository: fixture.repository,
    }),
    2,
  );
  assert.equal(measureBundle(fixture.bundleRoot).size, 4);

  write(join(fixture.client, "assets/index.js"), "");
  assert.throws(() => measureBundle(fixture.bundleRoot), /zero-byte artifact/);
  write(join(fixture.client, "assets/index.js"), "export const route = 1;\n");
  symlinkSync("index.js", join(fixture.client, "assets/linked.js"));
  assert.throws(
    () => measureBundle(fixture.bundleRoot),
    /non-regular artifact/,
  );
  rmSync(join(fixture.client, "assets/linked.js"));
  write(
    join(fixture.client, ".vite/manifest.json"),
    JSON.stringify({ fake: {} }),
  );
  assert.throws(
    () =>
      validateBundleContract({
        bundleRoot: fixture.bundleRoot,
        repository: fixture.repository,
      }),
    /omits route/,
  );

  const missingSsr = bundleFixture();
  rmSync(join(missingSsr.server, ".vite/ssr-manifest.json"));
  assert.throws(
    () =>
      validateBundleContract({
        bundleRoot: missingSsr.bundleRoot,
        repository: missingSsr.repository,
      }),
    /SSR module manifest is missing/,
  );

  const noConfig = run("check-bundles.mjs", ["--config", "forged.json"]);
  assert.notEqual(noConfig.status, 0);
  assert.match(noConfig.stderr, /accepts no PR-controlled config/);
});

test("bundle baseline policy handles PR, push, tag creation, deletion, and override attacks", () => {
  const { directory, base, head } = gitRepository();
  const common = { repository: { default_branch: "develop" } };
  assert.equal(
    resolveBundleBaseline(directory, {
      event: { ...common, pull_request: { base: { sha: base } } },
      environment: {},
    }),
    base,
  );
  assert.equal(
    resolveBundleBaseline(directory, {
      event: {
        ...common,
        before: base,
        after: head,
        created: false,
        deleted: false,
      },
      environment: {},
    }),
    base,
  );
  assert.equal(
    resolveBundleBaseline(directory, {
      event: {
        ...common,
        ref: "refs/tags/v1.0.0",
        before: zeroSha,
        after: head,
        created: true,
        deleted: false,
      },
      environment: {},
    }),
    head,
  );
  assert.equal(
    resolveBundleBaseline(directory, {
      event: {
        ...common,
        before: head,
        after: zeroSha,
        created: false,
        deleted: true,
      },
      environment: {},
    }),
    head,
  );
  assert.throws(
    () =>
      resolveBundleBaseline(directory, {
        event: undefined,
        environment: { QUALITY_BUNDLE_BASE: base },
      }),
    /overrides are forbidden/,
  );
  assert.throws(
    () =>
      resolveBundleBaseline(directory, {
        event: {
          ...common,
          before: zeroSha,
          after: head,
          created: false,
          deleted: false,
        },
        environment: {},
      }),
    /Zero bundle push base requires created=true/,
  );
  assert.throws(
    () =>
      resolveBundleBaseline(directory, {
        event: {
          ...common,
          before: base,
          after: zeroSha,
          created: false,
          deleted: false,
        },
        environment: {},
      }),
    /Zero bundle push head requires deleted=true/,
  );
});

test("bundle candidate snapshot includes modified, untracked, and deleted files", () => {
  const { directory, git } = gitRepository();
  const tempRoot = mkdtempSync(join(tmpdir(), "zevium-bundle-overlay-"));
  const worktree = join(tempRoot, "candidate");
  assert.equal(
    git("worktree", "add", "--quiet", "--detach", worktree, "HEAD").status,
    0,
  );
  try {
    write(join(directory, "README.md"), "pending candidate\n");
    write(join(directory, "new-source.ts"), "export const pending = true;\n");
    const firstTree = overlayCandidateSnapshot(directory, worktree);
    assert.equal(
      readFileSync(join(worktree, "README.md"), "utf8"),
      "pending candidate\n",
    );
    assert.equal(
      readFileSync(join(worktree, "new-source.ts"), "utf8"),
      "export const pending = true;\n",
    );
    assert.equal(
      spawnSync("git", ["write-tree"], {
        cwd: worktree,
        encoding: "utf8",
      }).stdout.trim(),
      firstTree,
    );

    rmSync(join(directory, "README.md"));
    const secondTree = overlayCandidateSnapshot(directory, worktree);
    assert.equal(existsSync(join(worktree, "README.md")), false);
    assert.notEqual(secondTree, firstTree);
  } finally {
    git("worktree", "remove", "--force", worktree);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("gitleaks scan planning handles PR, push, tag creation, deletion, and zero bases", () => {
  const { directory, base, head } = gitRepository();
  const common = { repository: { default_branch: "develop" } };
  const plans = [
    resolveScanPlan(directory, {
      event: { ...common, pull_request: { base: { sha: base } } },
      environment: {},
    }),
    resolveScanPlan(directory, {
      event: {
        ...common,
        before: base,
        after: head,
        created: false,
        deleted: false,
      },
      environment: {},
    }),
    resolveScanPlan(directory, {
      event: {
        ...common,
        ref: "refs/tags/v1.0.0",
        before: zeroSha,
        after: head,
        created: true,
        deleted: false,
      },
      environment: {},
    }),
    resolveScanPlan(directory, {
      event: {
        ...common,
        before: head,
        after: zeroSha,
        created: false,
        deleted: true,
      },
      environment: {},
    }),
  ];
  assert.deepEqual(
    plans.map((plan) => plan.eventKind),
    ["pull_request", "push", "create", "delete"],
  );
  assert.match(plans[2].range, new RegExp(`${head}(?:\\^!)?$`));
  assert.match(plans[3].range, new RegExp(`${head}(?:\\^!)?$`));
  for (const plan of plans) {
    assert.equal(plan.history, "--all --full-history");
    assert.ok(plan.range.length > 0);
    assert.deepEqual(
      gitleaksCommands(plan).map((command) => command[0]),
      ["git", "git", "dir"],
    );
    assert.equal(
      gitleaksCommands(plan)[0].find((argument) =>
        argument.startsWith("--log-opts="),
      ),
      "--log-opts=--all --full-history",
    );
    for (const command of gitleaksCommands(plan)) {
      assert.ok(command.includes("--ignore-gitleaks-allow"));
      assert.ok(command.includes("--max-decode-depth=5"));
      assert.ok(command.includes("--max-archive-depth=1"));
    }
  }
  assert.throws(
    () =>
      resolveScanPlan(directory, {
        event: {
          ...common,
          before: zeroSha,
          after: head,
          created: false,
          deleted: false,
        },
        environment: {},
      }),
    /Zero push base requires created=true/,
  );
  assert.throws(
    () =>
      resolveScanPlan(directory, {
        event: {
          ...common,
          before: base,
          after: zeroSha,
          created: false,
          deleted: false,
        },
        environment: {},
      }),
    /Zero push head requires deleted=true/,
  );
  assert.throws(
    () =>
      resolveScanPlan(directory, {
        event: {
          ...common,
          before: zeroSha,
          after: zeroSha,
          created: true,
          deleted: true,
        },
        environment: {},
      }),
    /cannot be both created and deleted/,
  );
});

test("gitleaks policy rejects broad config and ignore weakening", () => {
  const directory = mkdtempSync(join(tmpdir(), "zevium-gitleaks-policy-"));
  const configPath = join(directory, ".gitleaks.toml");
  const ignorePath = join(directory, ".gitleaksignore");
  const config = readFileSync(
    resolve(repositoryRoot, ".gitleaks.toml"),
    "utf8",
  );
  const ignore = readFileSync(
    resolve(repositoryRoot, ".gitleaksignore"),
    "utf8",
  );
  write(configPath, config);
  write(ignorePath, ignore);
  assert.doesNotThrow(() => validateGitleaksPolicy({ configPath, ignorePath }));

  write(ignorePath, `${ignore}*\n`);
  assert.throws(
    () => validateGitleaksPolicy({ configPath, ignorePath }),
    /95 exact audited historical fingerprints/,
  );

  write(ignorePath, ignore);
  write(configPath, `${config}\n[[allowlists]]\npaths = ['''.*''']\n`);
  assert.throws(
    () => validateGitleaksPolicy({ configPath, ignorePath }),
    /differs from fail-closed approved policy/,
  );
});

test("gitleaks current snapshot includes Git candidates and excludes ignored local state", () => {
  const { directory, git } = gitRepository();
  write(join(directory, ".gitignore"), "local.env\n");
  write(join(directory, "tracked.ts"), "export const tracked = true;\n");
  assert.equal(git("add", ".").status, 0);
  assert.equal(git("commit", "--quiet", "-m", "fixture: tracked").status, 0);
  write(join(directory, "untracked.ts"), "export const pending = true;\n");
  write(join(directory, "local.env"), "ignored-local-state\n");
  const candidate = createCurrentTreeSnapshot(directory);
  try {
    assert.equal(existsSync(join(candidate.snapshot, "tracked.ts")), true);
    assert.equal(existsSync(join(candidate.snapshot, "untracked.ts")), true);
    assert.equal(existsSync(join(candidate.snapshot, "local.env")), false);
  } finally {
    candidate.cleanup();
  }
});

test("gitleaks full history catches a secret deleted from current tree", () => {
  const { directory, git } = gitRepository();
  write(join(directory, "leak.env"), `GITHUB_TOKEN=${fakeGithubToken()}\n`);
  assert.equal(git("add", ".").status, 0);
  assert.equal(git("commit", "--quiet", "-m", "fixture: add secret").status, 0);
  rmSync(join(directory, "leak.env"));
  assert.equal(git("add", "-u").status, 0);
  assert.equal(
    git("commit", "--quiet", "-m", "fixture: delete secret").status,
    0,
  );
  const lookup = spawnSync("mise", ["which", "gitleaks"], {
    encoding: "utf8",
  });
  assert.equal(lookup.status, 0, lookup.stdout + lookup.stderr);
  const gitleaks = lookup.stdout.trim();
  assert.ok(gitleaks.length > 0 && existsSync(gitleaks));
  const result = spawnSync(
    gitleaks,
    ["git", "--no-banner", "--redact", "--log-opts=--all --full-history", "."],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /leaks found/i);
});

test("gitleaks exact fingerprint baseline rejects same-line mutation", () => {
  const { directory, git } = gitRepository();
  const lookup = spawnSync("mise", ["which", "gitleaks"], {
    encoding: "utf8",
  });
  assert.equal(lookup.status, 0, lookup.stdout + lookup.stderr);
  const gitleaks = lookup.stdout.trim();
  const report = join(directory, "report.json");
  const first = fakeGithubToken();
  write(join(directory, "leak.env"), `GITHUB_TOKEN=${first}\n`);
  assert.equal(git("add", "leak.env").status, 0);
  assert.equal(
    git("commit", "--quiet", "-m", "fixture: first secret").status,
    0,
  );
  const detected = spawnSync(
    gitleaks,
    [
      "git",
      "--no-banner",
      "--redact",
      "--report-format=json",
      `--report-path=${report}`,
      "--log-opts=--all --full-history",
      ".",
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(detected.status, 1, detected.stdout + detected.stderr);
  const [finding] = JSON.parse(readFileSync(report, "utf8"));
  write(join(directory, ".gitleaksignore"), `${finding.Fingerprint}\n`);

  const second = fakeGithubToken();
  write(join(directory, "leak.env"), `GITHUB_TOKEN=${second}\n`);
  assert.equal(git("add", "leak.env").status, 0);
  assert.equal(
    git("commit", "--quiet", "-m", "fixture: mutate secret").status,
    0,
  );
  rmSync(report);
  const mutated = spawnSync(
    gitleaks,
    [
      "git",
      "--no-banner",
      "--redact",
      "--report-format=json",
      `--report-path=${report}`,
      "--log-opts=--all --full-history",
      ".",
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(mutated.status, 1, mutated.stdout + mutated.stderr);
  const findings = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].Commit, git("rev-parse", "HEAD").stdout.trim());
});

test("gitleaks recursively decodes encoded new secrets", () => {
  const { directory, git } = gitRepository();
  const lookup = spawnSync("mise", ["which", "gitleaks"], {
    encoding: "utf8",
  });
  assert.equal(lookup.status, 0, lookup.stdout + lookup.stderr);
  const token = "ghp_" + randomBytes(24).toString("hex").slice(0, 36);
  write(
    join(directory, "encoded.txt"),
    `${Buffer.from(token).toString("base64")}\n`,
  );
  assert.equal(git("add", "encoded.txt").status, 0);
  assert.equal(
    git("commit", "--quiet", "-m", "fixture: encoded secret").status,
    0,
  );
  const result = spawnSync(
    lookup.stdout.trim(),
    [
      "git",
      "--no-banner",
      "--redact",
      "--max-decode-depth=5",
      "--log-opts=--all --full-history",
      ".",
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /leaks found/i);
});

test("production build environment cannot be bypassed with skip flags", () => {
  const buildScript = resolve(repositoryRoot, "apps/web/scripts/build.mjs");
  const strippedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        ![
          "CLERK_PUBLISHABLE_KEY",
          "CLERK_SECRET_KEY",
          "VITE_BUILD_SHA",
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
      VITE_BUILD_SHA: "1".repeat(40),
      VITE_CONVEX_URL: "https://fixture.invalid",
      VITE_GATEWAY_URL: "https://fixture.invalid",
    },
  });
  assert.equal(complete.status, 0, complete.stderr);
});

test("executable generated or JSX files are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "zevium-executables-"));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  write(join(dist, "output.js"), "export const x = 1;\n");
  write(join(dist, "output.jsx"), "export default () => null;\n");
  spawnSync("chmod", ["+x", join(dist, "output.js")]);
  spawnSync("chmod", ["+x", join(dist, "output.jsx")]);
  assert.throws(
    () => assertNoExecutableArtifacts(dist),
    /executable artifact policy/,
  );

  const clean = mkdtempSync(join(tmpdir(), "zevium-executables-clean-"));
  const cleanDist = join(clean, "dist");
  mkdirSync(cleanDist, { recursive: true });
  write(join(cleanDist, "output.js"), "export const x = 1;\n");
  write(join(cleanDist, "styles.css"), ":root{color:black}\n");
  assert.doesNotThrow(() => assertNoExecutableArtifacts(cleanDist));
});

test("workflow toolchains reject broad pnpm cache restore-keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "zevium-cache-hostile-"));
  const path = join(directory, "hostile.yml");
  const baseWorkflow = [
    "name: Hostile Cache",
    "on: workflow_dispatch",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-slim",
    "    steps:",
    "      - uses: jdx/mise-action@7e36c90d9ab29c415a2384db3006f3ec8a8cc654",
    "        with:",
    "          version: 2026.7.13",
    "          install: true",
    "          install_args: node@24.15.0 npm:pnpm@11.8.0 actionlint@1.7.12 gitleaks@8.30.1 shellcheck@0.11.0",
    "      - name: Verify exact Node and pnpm",
    "        run: |",
    '          test "$(node --version)" = "v24.15.0"',
    '          test "$(pnpm --version)" = "11.8.0"',
    "      - name: Install dependencies",
    "        run: pnpm install --frozen-lockfile",
    "",
  ].join("\n");
  write(path, baseWorkflow);
  assert.doesNotThrow(() => validateWorkflowToolchain(path));

  const hostileRestore = baseWorkflow.replace(
    "      - uses: jdx/mise-action@",
    [
      "      - uses: actions/cache@caa296126883cff596d87d8935842f9db880ef25",
      "        with:",
      "          path: ~/.local/share/pnpm/store",
      "          key: ${{ runner.os }}-pnpm-store-${{ hashFiles('**/pnpm-lock.yaml') }}",
      "          restore-keys: |",
      "            ${{ runner.os }}-pnpm-store-",
      "      - uses: jdx/mise-action@",
    ].join("\n"),
  );
  write(path, hostileRestore);
  assert.throws(
    () => validateWorkflowToolchain(path),
    /restore-keys are forbidden/,
  );
});

test("format-fix workflow blocks push to protected and sub-branches", () => {
  const directory = mkdtempSync(join(tmpdir(), "zevium-format-hostile-"));
  const formatWorkflow = readFileSync(
    resolve(repositoryRoot, ".github/workflows/format-fix.yml"),
    "utf8",
  );
  const protectedBranches = [
    formatWorkflow.replace(
      "workflow_dispatch:",
      "workflow_dispatch:\n          ref: refs/heads/develop",
    ),
    formatWorkflow.replace(
      "workflow_dispatch:",
      ["push:", "  branches: [develop]", ""].join("\n"),
    ),
  ];
  for (const [index, workflow] of protectedBranches.entries()) {
    write(join(directory, `hostile-${index}.yml`), workflow);
    const source = readFileSync(
      join(directory, `hostile-${index}.yml`),
      "utf8",
    );
    if (source.includes("restore-keys")) {
      assert.throws(
        () =>
          validateWorkflowToolchain(join(directory, `hostile-${index}.yml`)),
        /restore-keys/,
      );
    }
  }

  const noGatedPush = formatWorkflow.includes("Block push to protected refs");
  assert.ok(noGatedPush, "format-fix must contain a push-gating step");
});
