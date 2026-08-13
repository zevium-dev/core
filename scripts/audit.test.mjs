import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse, stringify } from "yaml";

import {
  BULK_ADVISORY_URL,
  CANONICAL_REGISTRY,
  evaluateBulkAdvisories,
  loadWorkspaceAuditGraph,
  postBoundedJson,
  renderSummaryHtml,
  runAudit,
  runBoundedChild,
  validateAutomationPolicy,
  validateAuditArguments,
  validateAuditConfig,
  validateAuditEnvironment,
  validateWorkspaceRoot,
  validateRegistryMetadata,
} from "./audit.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function expectedPnpmConfig(configOverrides = {}) {
  return {
    registry: CANONICAL_REGISTRY,
    "@jsr:registry": "https://npm.jsr.io/",
    allowBuilds: {
      "agent-browser": true,
      "@tailwindcss/oxide": false,
      bufferutil: true,
      esbuild: true,
      fsevents: false,
      sharp: false,
      "utf-8-validate": true,
      workerd: true,
    },
    minimumReleaseAge: 720,
    minimumReleaseAgeExclude: ["@cloudflare/workers-types", "@clerk/*"],
    minimumReleaseAgeStrict: true,
    overrides: {
      "concurrently>shell-quote": "1.10.0",
      "jayson>uuid": "11.1.1",
      postcss: "8.5.25",
      sharp: "0.35.0",
      undici: "7.29.0",
    },
    packages: ["apps/*", "packages/*"],
    strictDepBuilds: true,
    trustLockfile: false,
    verifyStoreIntegrity: true,
    ...configOverrides,
  };
}

function graphFor(occurrences) {
  const occurrenceMap = new Map();
  const versionsByName = new Map();
  let dependencies = 0;
  let devDependencies = 0;
  let optionalDependencies = 0;
  for (const occurrence of occurrences) {
    const finalized = {
      name: occurrence.name,
      version: occurrence.version,
      paths: [...occurrence.paths].sort(),
      dev: occurrence.dev ?? false,
      optional: occurrence.optional ?? false,
    };
    occurrenceMap.set(`${finalized.name}\0${finalized.version}`, finalized);
    let versions = versionsByName.get(finalized.name);
    if (!versions) {
      versions = new Set();
      versionsByName.set(finalized.name, versions);
    }
    versions.add(finalized.version);
    if (!finalized.dev && !finalized.optional) dependencies += 1;
    if (finalized.dev) devDependencies += 1;
    if (finalized.optional) optionalDependencies += 1;
  }
  const request = Object.fromEntries(
    [...versionsByName.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, versions]) => [name, [...versions].sort()]),
  );
  return {
    request,
    occurrences: occurrenceMap,
    dependencyCounts: {
      dependencies,
      devDependencies,
      optionalDependencies,
      totalDependencies: occurrenceMap.size,
    },
    lockfile: {
      path: "pnpm-lock.yaml",
      sha256: "fixture-sha256",
      version: "9.0",
      workspaceImporters: ["."],
    },
  };
}

function fixtureGraph() {
  return graphFor([
    {
      name: "fixture-package",
      version: "1.0.0",
      paths: [".>fixture-package", "apps/web>parent>fixture-package"],
    },
  ]);
}

function advisory(overrides = {}) {
  return {
    id: 1001,
    url: "https://github.com/advisories/GHSA-1111-2222-3333",
    title: "Fixture advisory",
    severity: "moderate",
    vulnerable_versions: "<2.0.0",
    cwe: ["CWE-79"],
    cvss: {
      score: 5.3,
      vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L",
    },
    ...overrides,
  };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function closeServer(server) {
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function makeAuditRepositoryCopy() {
  const root = mkdtempSync(path.join(repositoryRoot, ".audit-adversarial-"));
  for (const relativePath of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "mise.toml",
  ]) {
    cpSync(
      path.join(repositoryRoot, relativePath),
      path.join(root, relativePath),
    );
  }
  for (const importerId of [
    "apps/deploy-broker",
    "apps/gateway",
    "apps/web",
    "packages/shared",
  ]) {
    mkdirSync(path.join(root, importerId), { recursive: true });
    cpSync(
      path.join(repositoryRoot, importerId, "package.json"),
      path.join(root, importerId, "package.json"),
    );
  }
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  cpSync(
    path.join(repositoryRoot, "scripts/audit.mjs"),
    path.join(root, "scripts/audit.mjs"),
  );
  cpSync(
    path.join(repositoryRoot, "scripts/audit-preflight.mjs"),
    path.join(root, "scripts/audit-preflight.mjs"),
  );
  mkdirSync(path.join(root, "node_modules"));
  for (const packageName of ["semver", "yaml"]) {
    cpSync(
      realpathSync(path.join(repositoryRoot, "node_modules", packageName)),
      path.join(root, "node_modules", packageName),
      { recursive: true },
    );
  }
  cpSync(path.join(repositoryRoot, ".github"), path.join(root, ".github"), {
    recursive: true,
  });
  return root;
}

function mutateYaml(root, relativePath, mutation) {
  const filePath = path.join(root, relativePath);
  const value = parse(readFileSync(filePath, "utf8"));
  mutation(value);
  writeFileSync(filePath, stringify(value, { lineWidth: 0 }), "utf8");
}

function mutateJson(root, relativePath, mutation) {
  const filePath = path.join(root, relativePath);
  const value = JSON.parse(readFileSync(filePath, "utf8"));
  mutation(value);
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function withAuditRepository(mutation, assertion) {
  const root = makeAuditRepositoryCopy();
  try {
    mutation(root);
    return assertion(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function runMutatedPublicCli(
  mutation,
  { environment: environmentOverrides = {}, offline = true } = {},
) {
  return withAuditRepository(mutation, (root) => {
    const environment = {
      ...process.env,
      INIT_CWD: root,
      ...(offline ? { PATH: path.join(root, "missing-path") } : {}),
      ...environmentOverrides,
    };
    delete environment.GITHUB_STEP_SUMMARY;
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
    return spawnSync(process.execPath, ["scripts/audit.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: environment,
      timeout: offline ? 15_000 : 120_000,
    });
  });
}

function firstObjectEntry(record, predicate = () => true) {
  const entry = Object.entries(record).find(([key, value]) =>
    predicate(value, key),
  );
  assert.ok(entry, "expected matching repository lockfile entry");
  return entry;
}

function registryMetadataFixture(packageKey = "debug@4.4.3") {
  const graph = loadWorkspaceAuditGraph();
  const identity = graph.provenance.packageIdentities.get(packageKey);
  const packageSnapshot = graph.provenance.packageSnapshots[packageKey];
  assert.ok(identity);
  assert.ok(packageSnapshot);
  const variantInfos = [...graph.provenance.snapshotInfoByPath.values()]
    .filter((info) => info.parsed.packageKey === packageKey)
    .map((info) => ({
      ...info,
      edges: info.edges.map((edge) => ({
        ...edge,
        child: graph.provenance.snapshotInfoByPath.get(edge.depPath)?.parsed,
      })),
    }));
  const metadata = {
    name: "debug",
    version: "4.4.3",
    dependencies: { ms: "^2.1.3" },
    peerDependenciesMeta: {
      "supports-color": { optional: true },
    },
    engines: { node: ">=6.0" },
    scripts: {
      lint: "xo",
      test: "npm run test:node",
    },
    dist: {
      integrity: packageSnapshot.resolution.integrity,
      tarball: "https://registry.npmjs.org/debug/-/debug-4.4.3.tgz",
    },
  };
  return { identity, metadata, packageSnapshot, variantInfos };
}

test("parses exact repository workspace graph with every dependency type", () => {
  const graph = loadWorkspaceAuditGraph();

  assert.deepEqual(graph.lockfile.workspaceImporters, [
    ".",
    "apps/deploy-broker",
    "apps/gateway",
    "apps/web",
    "packages/shared",
  ]);
  assert.deepEqual(graph.dependencyCounts, {
    dependencies: 283,
    devDependencies: 320,
    optionalDependencies: 228,
    totalDependencies: 747,
  });
  assert.equal(graph.occurrences.size, 747);
  assert.equal(Object.keys(graph.request).length, 662);
  assert.match(graph.lockfile.sha256, /^[a-f0-9]{64}$/);
  assert.equal(graph.lockfile.path, "pnpm-lock.yaml");
  assert.deepEqual(graph.supplyChain.allowedRegistries, [CANONICAL_REGISTRY]);
  assert.deepEqual(graph.supplyChain.integrity, {
    algorithm: "sha512",
    completeDigestBytes: 64,
    entries: 747,
  });
  assert.equal(
    graph.supplyChain.resolution,
    "canonical-registry-identity-with-implicit-tarball",
  );
  assert.deepEqual(graph.supplyChain.packageExtensions, []);
  assert.deepEqual(graph.supplyChain.patchedDependencies, []);
  assert.deepEqual(graph.supplyChain.catalogs, []);
  assert.deepEqual(graph.supplyChain.overrideCoverage, {
    "concurrently>shell-quote": 1,
    "jayson>uuid": 0,
    postcss: 1,
    sharp: 3,
    undici: 4,
  });
  assert.ok(
    graph.supplyChain.lifecycleScripts.allowed.includes("agent-browser"),
  );
  assert.ok(graph.supplyChain.lifecycleScripts.denied.includes("sharp"));
});

test("validates pinned mise and immutable workflow action identities", () => {
  assert.equal(validateAutomationPolicy(), 11);
});

test("binds registry metadata to lock identity, tarball, digest, and graph semantics", () => {
  const fixture = registryMetadataFixture();
  assert.doesNotThrow(() =>
    validateRegistryMetadata(
      fixture.metadata,
      fixture.identity,
      fixture.packageSnapshot,
      fixture.variantInfos,
    ),
  );

  const attacks = [
    [
      "identity name",
      (metadata) => {
        metadata.name = "attacker-debug";
      },
      /does not bind canonical name and version/,
    ],
    [
      "identity version",
      (metadata) => {
        metadata.version = "4.4.2";
      },
      /does not bind canonical name and version/,
    ],
    [
      "complete but wrong digest",
      (metadata) => {
        metadata.dist.integrity = `sha512-${Buffer.alloc(64, 0xa5).toString("base64")}`;
      },
      /integrity does not match pnpm-lock.yaml/,
    ],
    [
      "tarball host",
      (metadata) => {
        metadata.dist.tarball =
          "https://attacker.invalid/debug/-/debug-4.4.3.tgz";
      },
      /leaves canonical registry allowlist/,
    ],
    [
      "tarball identity path",
      (metadata) => {
        metadata.dist.tarball = "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz";
      },
      /does not match canonical package identity and version/,
    ],
    [
      "dependency version",
      (metadata) => {
        metadata.dependencies.ms = ">=9.0.0";
      },
      /outside metadata semver ranges/,
    ],
    [
      "dependency kind",
      (metadata) => {
        metadata.optionalDependencies = { ms: "^2.1.3" };
      },
      /dependency-kind classification does not match/,
    ],
    [
      "peer policy",
      (metadata) => {
        metadata.peerDependenciesMeta = {};
      },
      /peerDependencies does not exactly match pinned dependency policy/,
    ],
    [
      "peer metadata controls",
      (metadata) => {
        metadata.peerDependenciesMeta["supports-color"].injected = true;
      },
      /unsupported fields: injected/,
    ],
    [
      "dependency metadata controls",
      (metadata) => {
        metadata.dependenciesMeta = { ms: { built: true } };
      },
      /unsupported fields: built/,
    ],
    [
      "platform policy",
      (metadata) => {
        metadata.os = ["darwin"];
      },
      /\.os does not exactly match pinned dependency policy/,
    ],
    [
      "install script policy",
      (metadata) => {
        metadata.scripts.postinstall = "node attacker.js";
      },
      /unclassified install lifecycle scripts/,
    ],
    [
      "implicit node-gyp policy",
      (metadata) => {
        metadata.gypfile = true;
      },
      /unclassified install lifecycle scripts: implicit node-gyp/,
    ],
  ];
  for (const [name, mutate, expectedError] of attacks) {
    const metadata = structuredClone(fixture.metadata);
    mutate(metadata);
    assert.throws(
      () =>
        validateRegistryMetadata(
          metadata,
          fixture.identity,
          fixture.packageSnapshot,
          fixture.variantInfos,
        ),
      expectedError,
      name,
    );
  }
});

test("binds lifecycle permissions to exact package versions and commands", () => {
  const graph = loadWorkspaceAuditGraph();
  const packageKey = "agent-browser@0.27.1";
  const identity = graph.provenance.packageIdentities.get(packageKey);
  const packageSnapshot = graph.provenance.packageSnapshots[packageKey];
  assert.ok(identity);
  assert.ok(packageSnapshot);
  const variantInfos = [...graph.provenance.snapshotInfoByPath.values()]
    .filter((info) => info.parsed.packageKey === packageKey)
    .map((info) => ({
      ...info,
      edges: info.edges.map((edge) => ({
        ...edge,
        child: graph.provenance.snapshotInfoByPath.get(edge.depPath)?.parsed,
      })),
    }));
  const metadata = {
    name: identity.name,
    version: identity.version,
    engines: packageSnapshot.engines,
    bin: { "agent-browser": "bin/agent-browser.js" },
    scripts: { postinstall: "node scripts/postinstall.js" },
    dist: {
      integrity: packageSnapshot.resolution.integrity,
      tarball:
        "https://registry.npmjs.org/agent-browser/-/agent-browser-0.27.1.tgz",
    },
  };
  assert.doesNotThrow(() =>
    validateRegistryMetadata(metadata, identity, packageSnapshot, variantInfos),
  );
  metadata.scripts.postinstall = "node attacker.js";
  assert.throws(
    () =>
      validateRegistryMetadata(
        metadata,
        identity,
        packageSnapshot,
        variantInfos,
      ),
    /install lifecycle scripts does not exactly match pinned dependency policy/,
  );
});

test("public CLI rejects every previously accepted supply-chain bypass", () => {
  const attacks = [
    {
      name: "identity metadata tamper",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          const [, packageSnapshot] = firstObjectEntry(lockfile.packages);
          packageSnapshot.name = "attacker-controlled-identity";
        });
      },
      error: /unsupported fields: name/,
    },
    {
      name: "tarball source URL drift",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          const [, packageSnapshot] = firstObjectEntry(lockfile.packages);
          packageSnapshot.resolution.tarball =
            "https://attacker.invalid/package.tgz";
        });
      },
      error: /unsupported fields: tarball/,
    },
    {
      name: "weak SRI acceptance",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          const [, packageSnapshot] = firstObjectEntry(lockfile.packages);
          packageSnapshot.resolution.integrity =
            "sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=";
        });
      },
      error: /exactly one complete sha512 SRI digest/,
    },
    {
      name: "pnpm override drift",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          lockfile.overrides.postcss = "8.5.24";
        });
      },
      error:
        /lockfile\.overrides does not exactly match pinned dependency policy/,
    },
  ];

  for (const attack of attacks) {
    const result = runMutatedPublicCli(attack.mutate);
    assert.equal(result.error, undefined, attack.name);
    assert.equal(result.status, 2, attack.name);
    assert.match(result.stderr, attack.error, attack.name);
    assert.doesNotMatch(result.stdout, /"vulnerabilities"/, attack.name);
  }
});

test("public CLI rejects metamorphic lock, workspace, manifest, CI, and mise attacks", () => {
  const attacks = [
    {
      name: "identity version metadata",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          const [, packageSnapshot] = firstObjectEntry(lockfile.packages);
          packageSnapshot.version = "99.0.0";
        });
      },
      error: /unsupported fields: version/,
    },
    {
      name: "bootstrap package digest drift",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          lockfile.packages["semver@7.8.5"].resolution.integrity =
            `sha512-${Buffer.alloc(64, 0xa5).toString("base64")}`;
        });
      },
      error:
        /bootstrap identity or sha512 integrity drifted for semver@7\.8\.5/,
    },
    {
      name: "bootstrap importer source drift",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          lockfile.importers["."].devDependencies.semver.version =
            "npm:attacker@7.8.5";
        });
      },
      error: /bootstrap importer semver drifted/,
    },
    {
      name: "lifecycle package version drift",
      mutate(root) {
        mutateJson(root, "package.json", (manifest) => {
          manifest.devDependencies["agent-browser"] = "0.27.2";
        });
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          lockfile.importers["."].devDependencies["agent-browser"] = {
            specifier: "0.27.2",
            version: "0.27.2",
          };
          lockfile.packages["agent-browser@0.27.2"] =
            lockfile.packages["agent-browser@0.27.1"];
          delete lockfile.packages["agent-browser@0.27.1"];
          lockfile.snapshots["agent-browser@0.27.2"] = {};
          delete lockfile.snapshots["agent-browser@0.27.1"];
        });
      },
      error:
        /Lifecycle package policy agent-browser@0\.27\.1 has no exact lockfile identity/,
    },
    {
      name: "resolution registry field",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          const [, packageSnapshot] = firstObjectEntry(lockfile.packages);
          packageSnapshot.resolution.registry = "https://attacker.invalid/";
        });
      },
      error: /unsupported fields: registry/,
    },
    ...[
      "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
      `sha512-${Buffer.alloc(63, 0xa5).toString("base64")}`,
      `sha512-${Buffer.alloc(64, 0xa5).toString("base64")} sha512-${Buffer.alloc(64, 0x5a).toString("base64")}`,
      `sha512-${"A".repeat(86)}=x`,
    ].map((integrity, index) => ({
      name: `weak or malformed SRI variant ${String(index + 1)}`,
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          const [, packageSnapshot] = firstObjectEntry(lockfile.packages);
          packageSnapshot.resolution.integrity = integrity;
        });
      },
      error: /complete sha512 SRI digest|canonical 64-byte sha512 digest/,
    })),
    {
      name: "override policy in workspace",
      mutate(root) {
        mutateYaml(root, "pnpm-workspace.yaml", (workspace) => {
          workspace.overrides.postcss = "8.5.24";
        });
      },
      error:
        /workspace\.overrides does not exactly match pinned dependency policy/,
    },
    {
      name: "override application in graph",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          lockfile.packages["shell-quote@1.9.0"] = structuredClone(
            lockfile.packages["shell-quote@1.10.0"],
          );
          lockfile.snapshots["shell-quote@1.9.0"] = {};
          lockfile.snapshots["concurrently@10.0.4"].dependencies[
            "shell-quote"
          ] = "1.9.0";
        });
      },
      error:
        /Pinned override concurrently>shell-quote drifted to shell-quote@1\.9\.0/,
    },
    {
      name: "lock package extensions",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          lockfile.packageExtensionsChecksum = `sha256-${"a".repeat(64)}`;
        });
      },
      error: /unsupported fields: packageExtensionsChecksum/,
    },
    {
      name: "workspace package extensions",
      mutate(root) {
        mutateYaml(root, "pnpm-workspace.yaml", (workspace) => {
          workspace.packageExtensions = { "debug@*": { dependencies: {} } };
        });
      },
      error: /unsupported fields: packageExtensions/,
    },
    {
      name: "patched dependencies",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          lockfile.patchedDependencies = {
            "debug@4.4.3": "attacker-hash",
          };
        });
      },
      error: /unsupported fields: patchedDependencies/,
    },
    {
      name: "patch directory",
      mutate(root) {
        mkdirSync(path.join(root, "patches"));
        writeFileSync(
          path.join(root, "patches", "debug.patch"),
          "attacker patch\n",
          "utf8",
        );
      },
      error: /Repository patches path is forbidden/,
    },
    {
      name: "catalog drift",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          lockfile.catalogs = { default: { debug: "4.4.3" } };
        });
      },
      error: /unsupported fields: catalogs/,
    },
    {
      name: "workspace importer omission",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          delete lockfile.importers["packages/shared"];
        });
      },
      error: /Lockfile importers do not exactly match workspace/,
    },
    {
      name: "workspace glob drift",
      mutate(root) {
        mutateYaml(root, "pnpm-workspace.yaml", (workspace) => {
          workspace.packages = ["apps/web"];
        });
      },
      error:
        /workspace\.packages does not exactly match pinned dependency policy/,
    },
    {
      name: "registry drift",
      mutate(root) {
        mutateYaml(root, "pnpm-workspace.yaml", (workspace) => {
          workspace.registry = "https://attacker.invalid/";
        });
      },
      error: /workspace\.registry must be canonical/,
    },
    {
      name: "untracked npmrc",
      mutate(root) {
        writeFileSync(
          path.join(root, ".npmrc"),
          "registry=https://attacker.invalid/\n",
          "utf8",
        );
      },
      error: /\.npmrc is forbidden during dependency audit bootstrap/,
    },
    {
      name: "untracked pnpm hook",
      mutate(root) {
        writeFileSync(
          path.join(root, ".pnpmfile.cjs"),
          "module.exports = {}\n",
          "utf8",
        );
      },
      error: /\.pnpmfile\.cjs is forbidden during dependency audit bootstrap/,
    },
    {
      name: "local audit parser shadow",
      mutate(root) {
        mkdirSync(path.join(root, "scripts/node_modules/yaml"), {
          recursive: true,
        });
        writeFileSync(
          path.join(root, "scripts/node_modules/yaml/package.json"),
          '{"name":"yaml","version":"2.9.0"}\n',
          "utf8",
        );
      },
      error:
        /scripts\/node_modules is forbidden during dependency audit bootstrap/,
    },
    {
      name: "installed audit parser content tamper",
      mutate(root) {
        const modulePath = path.join(root, "node_modules/yaml/dist/index.js");
        writeFileSync(
          modulePath,
          `${readFileSync(modulePath, "utf8")}\n// attacker mutation\n`,
          "utf8",
        );
      },
      error:
        /Installed audit bootstrap package yaml tree does not match pinned sha512/,
    },
    {
      name: "lifecycle script",
      mutate(root) {
        mutateJson(root, "package.json", (manifest) => {
          manifest.scripts.postinstall = "node attacker.js";
        });
      },
      error: /lifecycle script postinstall is not allowlisted/,
    },
    {
      name: "nested pnpm policy",
      mutate(root) {
        mutateJson(root, "apps/web/package.json", (manifest) => {
          manifest.pnpm = { onlyBuiltDependencies: ["attacker"] };
        });
      },
      error: /contains unsupported fields: pnpm/,
    },
    {
      name: "workspace platform selector",
      mutate(root) {
        mutateJson(root, "apps/web/package.json", (manifest) => {
          manifest.os = ["linux"];
        });
      },
      error: /contains unsupported fields: os/,
    },
    {
      name: "wildcard direct dependency",
      mutate(root) {
        mutateJson(root, "apps/web/package.json", (manifest) => {
          manifest.dependencies["@tanstack/react-router"] = "*";
        });
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          lockfile.importers["apps/web"].dependencies[
            "@tanstack/react-router"
          ].specifier = "*";
        });
      },
      error: /uses mutable or non-registry specifier "\*"/,
    },
    {
      name: "mutable direct dependency",
      mutate(root) {
        mutateJson(root, "apps/web/package.json", (manifest) => {
          manifest.dependencies["@tanstack/react-router"] = "latest";
        });
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          lockfile.importers["apps/web"].dependencies[
            "@tanstack/react-router"
          ].specifier = "latest";
        });
      },
      error: /uses mutable or non-registry specifier "latest"/,
    },
    ...[
      "github:attacker/router#main",
      "git+https://github.com/attacker/router.git#main",
      "file:../../attacker",
      "https://attacker.invalid/router.tgz",
    ].map((specifier, index) => ({
      name: `non-registry direct source ${String(index + 1)}`,
      mutate(root) {
        mutateJson(root, "apps/web/package.json", (manifest) => {
          manifest.dependencies["@tanstack/react-router"] = specifier;
        });
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          const dependency =
            lockfile.importers["apps/web"].dependencies[
              "@tanstack/react-router"
            ];
          dependency.specifier = specifier;
          dependency.version = specifier;
        });
      },
      error: /uses mutable or non-registry specifier/,
    })),
    {
      name: "workspace link drift",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          lockfile.importers["apps/web"].dependencies[
            "@zevium/shared"
          ].version = "link:../gateway";
        });
      },
      error: /workspace link must be exactly link:\.\.\/\.\.\/packages\/shared/,
    },
    {
      name: "peer range drift",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          lockfile.packages["react-dom@19.2.7"].peerDependencies.react =
            ">=999.0.0";
        });
      },
      error: /peer dependency react@19\.2\.7 violates declared range/,
    },
    {
      name: "optional flag drift",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          const [, snapshot] = firstObjectEntry(
            lockfile.snapshots,
            (candidate) => candidate.optional === true,
          );
          delete snapshot.optional;
        });
      },
      error: /optional classification does not match complete importer graph/,
    },
    {
      name: "platform selector drift",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          lockfile.packages["@esbuild/linux-x64@0.28.1"].cpu.push("x64");
        });
      },
      error: /\.cpu contains duplicate platforms/,
    },
    {
      name: "transitive local source",
      mutate(root) {
        mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
          lockfile.snapshots["debug@4.4.3"].dependencies.ms =
            "file:../../attacker";
        });
      },
      error: /forbidden local, URL, git, or protocol source/,
    },
    {
      name: "duplicate YAML key",
      mutate(root) {
        const lockfilePath = path.join(root, "pnpm-lock.yaml");
        writeFileSync(
          lockfilePath,
          `${readFileSync(lockfilePath, "utf8")}\nsettings:\n  autoInstallPeers: true\n`,
          "utf8",
        );
      },
      error: /invalid or non-deterministic YAML: Map keys must be unique/,
    },
    {
      name: "duplicate JSON key",
      mutate(root) {
        const manifestPath = path.join(root, "package.json");
        const manifest = readFileSync(manifestPath, "utf8").replace(
          '  "name": "zevium",',
          '  "name": "zevium",\n  "name": "attacker",',
        );
        writeFileSync(manifestPath, manifest, "utf8");
      },
      error: /contains duplicate JSON key name/,
    },
    {
      name: "mutable action tag",
      mutate(root) {
        const workflowPath = path.join(root, ".github/workflows/ci.yml");
        writeFileSync(
          workflowPath,
          readFileSync(workflowPath, "utf8").replace(
            /actions\/checkout@[a-f0-9]{40}/,
            "actions/checkout@v6",
          ),
          "utf8",
        );
      },
      error:
        /uses mutable or malformed action reference "actions\/checkout@v6"/,
    },
    {
      name: "mise tool drift",
      mutate(root) {
        const misePath = path.join(root, "mise.toml");
        writeFileSync(
          misePath,
          readFileSync(misePath, "utf8").replace(
            'node = "24.15.0"',
            'node = "24.15.1"',
          ),
          "utf8",
        );
      },
      error:
        /mise\.toml toolchain policy does not exactly match pinned dependency policy/,
    },
    {
      name: "mise bootstrap bypass",
      mutate(root) {
        const misePath = path.join(root, "mise.toml");
        writeFileSync(
          misePath,
          readFileSync(misePath, "utf8").replace(
            "node scripts/audit-preflight.mjs && ",
            "",
          ),
          "utf8",
        );
      },
      error:
        /mise\.toml toolchain policy does not exactly match pinned dependency policy/,
    },
    {
      name: "CI audit removal",
      mutate(root) {
        const workflowPath = path.join(root, ".github/workflows/ci.yml");
        writeFileSync(
          workflowPath,
          readFileSync(workflowPath, "utf8").replace(
            "run: node scripts/audit.mjs",
            "run: echo bypassed",
          ),
          "utf8",
        );
      },
      error:
        /must verify exact Node\/pnpm and install once with a frozen lockfile|must use exact root bootstrap|without audited full workspace install/,
    },
    {
      name: "lifecycle allowlist drift",
      mutate(root) {
        mutateYaml(root, "pnpm-workspace.yaml", (workspace) => {
          workspace.allowBuilds.sharp = true;
        });
      },
      error:
        /workspace\.allowBuilds does not exactly match pinned dependency policy/,
    },
    {
      name: "workflow global npm install",
      mutate(root) {
        mutateYaml(root, ".github/workflows/payment-drill.yml", (workflow) => {
          const step = workflow.jobs[
            "real-zevium-stripe-acceptance"
          ].steps.find(
            (candidate) => candidate.name === "Install pinned browser runtime",
          );
          step.run = "npm install --global attacker@1.0.0";
        });
      },
      error: /uses forbidden mutable package-manager install/,
    },
    {
      name: "workflow install scripts enabled",
      mutate(root) {
        const workflowPath = path.join(root, ".github/workflows/ci.yml");
        writeFileSync(
          workflowPath,
          readFileSync(workflowPath, "utf8").replace(
            "pnpm --filter . install --frozen-lockfile --ignore-pnpmfile --ignore-scripts --registry=https://registry.npmjs.org/ --config.trust-lockfile=false --config.verify-store-integrity=true",
            "pnpm --filter . install --frozen-lockfile --ignore-pnpmfile --registry=https://registry.npmjs.org/ --config.trust-lockfile=false --config.verify-store-integrity=true",
          ),
          "utf8",
        );
      },
      error: /uses forbidden mutable package-manager install/,
    },
    {
      name: "workflow pnpm hook enabled",
      mutate(root) {
        const workflowPath = path.join(root, ".github/workflows/ci.yml");
        writeFileSync(
          workflowPath,
          readFileSync(workflowPath, "utf8").replace(
            "pnpm --filter . install --frozen-lockfile --ignore-pnpmfile --ignore-scripts --registry=https://registry.npmjs.org/ --config.trust-lockfile=false --config.verify-store-integrity=true",
            "pnpm --filter . install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org/ --config.trust-lockfile=false --config.verify-store-integrity=true",
          ),
          "utf8",
        );
      },
      error: /uses forbidden mutable package-manager install/,
    },
    {
      name: "audit failure suppression",
      mutate(root) {
        mutateYaml(root, ".github/workflows/ci.yml", (workflow) => {
          const step = workflow.jobs.security.steps.find(
            (candidate) => candidate.run === "node scripts/audit.mjs",
          );
          step["continue-on-error"] = true;
        });
      },
      error: /contains unsupported fields: continue-on-error/,
    },
    {
      name: "downstream audit dependency removal",
      mutate(root) {
        mutateYaml(root, ".github/workflows/ci.yml", (workflow) => {
          delete workflow.jobs.quality.needs;
        });
      },
      error:
        /quality can execute dependency code without successful audit dependency/,
    },
    {
      name: "downstream failed-audit status bypass",
      mutate(root) {
        mutateYaml(root, ".github/workflows/ci.yml", (workflow) => {
          workflow.jobs.quality.if = "always()";
        });
      },
      error: /quality can bypass failed audit with status condition/,
    },
    {
      name: "workflow dependency environment override",
      mutate(root) {
        mutateYaml(root, ".github/workflows/ci.yml", (workflow) => {
          workflow.jobs.quality.env = {
            NPM_CONFIG_REGISTRY: "https://attacker.invalid/",
          };
        });
      },
      error: /overrides protected dependency environment NPM_CONFIG_REGISTRY/,
    },
    {
      name: "mise bootstrap mutable reference",
      mutate(root) {
        const workflowPath = path.join(root, ".github/workflows/ci.yml");
        writeFileSync(
          workflowPath,
          readFileSync(workflowPath, "utf8").replace(
            "jdx/mise-action@7e36c90d9ab29c415a2384db3006f3ec8a8cc654",
            "jdx/mise-action@v4",
          ),
          "utf8",
        );
      },
      error:
        /uses mutable or malformed action reference|without pinned setup-node or mise bootstrap/,
    },
    {
      name: "workflow preflight removal",
      mutate(root) {
        const workflowPath = path.join(root, ".github/workflows/ci.yml");
        writeFileSync(
          workflowPath,
          readFileSync(workflowPath, "utf8").replace(
            "run: node scripts/audit-preflight.mjs",
            "run: node --version",
          ),
          "utf8",
        );
      },
      error:
        /must verify exact Node\/pnpm and install once with a frozen lockfile|must use exact root bootstrap|without audited full workspace install/,
    },
    {
      name: "workflow package manager bootstrap drift",
      mutate(root) {
        const workflowPath = path.join(root, ".github/workflows/ci.yml");
        writeFileSync(
          workflowPath,
          readFileSync(workflowPath, "utf8").replace(
            "pnpm --filter . install --frozen-lockfile --ignore-pnpmfile --ignore-scripts --registry=https://registry.npmjs.org/ --config.trust-lockfile=false --config.verify-store-integrity=true",
            "pnpm install --no-frozen-lockfile",
          ),
          "utf8",
        );
      },
      error:
        /uses forbidden mutable package-manager install|without pinned setup-node or mise bootstrap|must verify exact Node\/pnpm|without audited full workspace install/,
    },
    {
      name: "package manager integrity drift",
      mutate(root) {
        mutateJson(root, "package.json", (manifest) => {
          manifest.packageManager = "pnpm@11.8.0";
        });
      },
      error: /identity or package manager drifted during audit bootstrap/,
    },
    {
      name: "Corepack environment override file",
      mutate(root) {
        writeFileSync(
          path.join(root, ".corepack.env"),
          "COREPACK_ENABLE_STRICT=0\n",
          "utf8",
        );
      },
      error: /\.corepack\.env is forbidden during dependency audit bootstrap/,
    },
    {
      name: "Corepack environment integrity bypass",
      mutate() {},
      environment: { COREPACK_INTEGRITY_KEYS: "0" },
      error:
        /COREPACK_INTEGRITY_KEYS is forbidden during dependency audit bootstrap/,
    },
    {
      name: "audit before bootstrap install",
      mutate(root) {
        mutateYaml(root, ".github/workflows/ci.yml", (workflow) => {
          const steps = workflow.jobs.security.steps;
          const auditIndex = steps.findIndex(
            (candidate) => candidate.run === "node scripts/audit.mjs",
          );
          const installIndex = steps.findIndex(
            (candidate) =>
              typeof candidate.run === "string" &&
              candidate.run.startsWith("pnpm --filter . install"),
          );
          [steps[auditIndex], steps[installIndex]] = [
            steps[installIndex],
            steps[auditIndex],
          ];
        });
      },
      error:
        /must audit after the frozen no-script bootstrap install|must audit after isolated frozen no-script bootstrap|must order mise bootstrap/,
    },
  ];

  for (const attack of attacks) {
    const result = runMutatedPublicCli(attack.mutate, {
      environment: attack.environment,
    });
    assert.equal(result.error, undefined, attack.name);
    assert.equal(result.status, 2, attack.name);
    assert.match(result.stderr, attack.error, attack.name);
    assert.doesNotMatch(result.stdout, /"vulnerabilities"/, attack.name);
  }
});

test(
  "public CLI rejects internally well-formed digest and dependency-kind forgeries",
  { timeout: 180_000 },
  () => {
    const attacks = [
      {
        name: "complete sha512 digest forgery",
        mutate(root) {
          mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
            lockfile.packages["@acemir/cssom@0.9.31"].resolution.integrity =
              `sha512-${Buffer.alloc(64, 0xa5).toString("base64")}`;
          });
        },
        error:
          /registry metadata @acemir\/cssom@0\.9\.31 integrity does not match pnpm-lock\.yaml/,
        offline: false,
      },
      {
        name: "dependency kind forgery",
        mutate(root) {
          mutateYaml(root, "pnpm-lock.yaml", (lockfile) => {
            const snapshot = lockfile.snapshots["debug@4.4.3"];
            snapshot.optionalDependencies = { ms: snapshot.dependencies.ms };
            delete snapshot.dependencies;
          });
        },
        error:
          /Dependency snapshot ms@2\.1\.3 optional classification does not match complete importer graph/,
        offline: true,
      },
    ];
    for (const attack of attacks) {
      const result = runMutatedPublicCli(attack.mutate, {
        offline: attack.offline,
      });
      assert.equal(result.error, undefined, attack.name);
      assert.equal(result.status, 2, attack.name);
      assert.match(result.stderr, attack.error, attack.name);
      assert.doesNotMatch(result.stdout, /"vulnerabilities"/, attack.name);
    }
  },
);

test("rejects hostile registry config and every dependency-scope selector", () => {
  assert.throws(
    () =>
      validateAuditConfig(
        expectedPnpmConfig({ registry: "https://hostile.invalid/" }),
      ),
    /registry overrides canonical/,
  );
  assert.deepEqual(validateAuditConfig(expectedPnpmConfig()), []);

  const overrides = [
    ["production", true],
    ["prod", true],
    ["dev", true],
    ["optional", false],
    ["only", "prod"],
    ["omit", ["dev"]],
    ["include", ["prod"]],
    ["filter", "web"],
    ["filter-prod", "web"],
    ["workspace", true],
    ["workspace-root", true],
    ["include-workspace-root", false],
    ["recursive", false],
  ];
  for (const [key, value] of overrides) {
    assert.throws(
      () => validateAuditConfig(expectedPnpmConfig({ [key]: value })),
      /overrides audit scope or workspace selection/,
      key,
    );
  }
});

test("rejects alternate lockfile, workspace, filtering, and suppressions", () => {
  for (const [key, value] of [
    ["lockfile-dir", "/tmp/alternate"],
    ["lockfile", false],
    ["shared-workspace-lockfile", false],
    ["dir", "/tmp/alternate"],
    ["prefix", "/tmp/alternate"],
    ["userconfig", "/tmp/hostile.npmrc"],
    ["globalconfig", "/tmp/hostile.npmrc"],
  ]) {
    assert.throws(
      () => validateAuditConfig(expectedPnpmConfig({ [key]: value })),
      /audit scope or workspace selection/,
      key,
    );
  }

  for (const config of [
    { auditConfig: { ignoreGhsas: ["GHSA-1111-2222-3333"] } },
    { auditConfig: { ignoreCves: ["CVE-2099-0001"] } },
    { auditConfig: { ignore: { "GHSA-path": [".>package"] } } },
    { auditConfig: { ignoreUnfixable: true } },
    { auditConfig: { ignoreRegistryErrors: true } },
    { "audit-config-ignore-ghsas": ["GHSA-1111-2222-3333"] },
  ]) {
    assert.throws(
      () => validateAuditConfig(expectedPnpmConfig(config)),
      /no suppressions/,
    );
  }
  assert.deepEqual(
    validateAuditConfig(
      expectedPnpmConfig({
        auditConfig: {
          ignoreGhsas: [],
          ignoreCves: [],
          ignore: {},
          ignoreUnfixable: false,
          ignoreRegistryErrors: false,
        },
      }),
    ),
    [],
  );
});

test("rejects environment and CLI target overrides", () => {
  for (const key of [
    "npm_config_registry",
    "NPM_CONFIG_PRODUCTION",
    "npm_config_prod",
    "npm_config_dev",
    "npm_config_optional",
    "npm_config_only",
    "npm_config_omit",
    "npm_config_include",
    "npm_config_filter",
    "pnpm_config_filter_prod",
    "npm_config_lockfile_dir",
    "npm_config_shared_workspace_lockfile",
    "npm_config_workspace_root",
    "npm_config_userconfig",
    "npm_config_ignore_unfixable",
    "PNPM_FILTER",
    "PNPM_LOCKFILE_DIR",
    "PNPM_REGISTRY",
    "COREPACK_ENABLE_PROJECT_SPEC",
    "COREPACK_ENABLE_STRICT",
    "COREPACK_INTEGRITY_KEYS",
    "COREPACK_NPM_REGISTRY",
  ]) {
    assert.throws(
      () => validateAuditEnvironment({ [key]: "hostile" }),
      /overrides audit scope, registry, lockfile, (?:or filtering|filtering, or suppression) policy|changes package-manager identity, source, or integrity policy/,
      key,
    );
  }
  assert.throws(
    () => validateAuditEnvironment({ NODE_ENV: "production" }),
    /overrides dependency scope/,
  );
  assert.doesNotThrow(() =>
    validateAuditEnvironment({
      NODE_ENV: "test",
      COREPACK_ROOT: "/tooling/corepack",
      PNPM_HOME: "/tooling",
      npm_config_user_agent: "pnpm/11.8.0",
    }),
  );

  for (const args of [
    ["--registry=https://hostile.invalid"],
    ["--prod"],
    ["--dev"],
    ["--no-optional"],
    ["--filter", "web"],
    ["--lockfile-dir", "/tmp/alternate"],
    ["--workspace-root"],
  ]) {
    assert.throws(
      () => validateAuditArguments(args),
      /overrides are forbidden/,
    );
  }
  assert.doesNotThrow(() => validateAuditArguments([]));
});

test("rejects alternate working directory and INIT_CWD", () => {
  assert.throws(
    () => validateWorkspaceRoot(path.dirname(repositoryRoot)),
    /exact repository workspace root/,
  );
  assert.throws(
    () => validateWorkspaceRoot(repositoryRoot, path.dirname(repositoryRoot)),
    /alternate workspace/,
  );
  assert.doesNotThrow(() =>
    validateWorkspaceRoot(repositoryRoot, repositoryRoot),
  );
});

test("reports every severity, blocks high/critical, and reconciles paths", () => {
  const raw = {
    "fixture-package": [
      advisory({ id: 1, severity: "info" }),
      advisory({ id: 2, severity: "low" }),
      advisory({ id: 3, severity: "moderate" }),
      advisory({ id: 4, severity: "high" }),
      advisory({ id: 5, severity: "critical" }),
    ],
  };
  const outcome = evaluateBulkAdvisories(raw, fixtureGraph());

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.blockingAdvisories.length, 2);
  assert.deepEqual(outcome.summary.vulnerabilities, {
    info: 1,
    low: 1,
    moderate: 1,
    high: 1,
    critical: 1,
  });
  assert.equal(outcome.summary.advisories.length, 5);
  assert.deepEqual(outcome.summary.advisories[0].findings, [
    {
      version: "1.0.0",
      paths: [".>fixture-package", "apps/web>parent>fixture-package"],
      dev: false,
      optional: false,
      bundled: false,
    },
  ]);
  assert.deepEqual(outcome.summary.policy.allowlist, []);
  assert.deepEqual(outcome.summary.policy.dependencyScope, [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]);
  assert.equal(outcome.summary.policy.endpoint, BULK_ADVISORY_URL.href);
});

test("supports unfixable and complex ranges with absent patched versions", () => {
  const graph = graphFor([
    {
      name: "range-package",
      version: "1.5.0",
      paths: [".>range-package"],
    },
    {
      name: "range-package",
      version: "3.2.0",
      paths: ["apps/web>range-package"],
      dev: true,
    },
  ]);
  const outcome = evaluateBulkAdvisories(
    {
      "range-package": [
        advisory({
          id: 11,
          severity: "low",
          vulnerable_versions: "*",
        }),
        advisory({
          id: 12,
          vulnerable_versions: ">=1.0.0 <2.0.0 || >=3.0.0 <4.0.1",
        }),
      ],
    },
    graph,
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.summary.advisories[0].patched_versions, null);
  assert.equal(outcome.summary.advisories[1].patched_versions, null);
  assert.deepEqual(
    outcome.summary.advisories[1].findings.map((finding) => finding.version),
    ["1.5.0", "3.2.0"],
  );
  assert.equal(outcome.summary.vulnerabilities.low, 1);
  assert.equal(outcome.summary.vulnerabilities.moderate, 1);
});

test("accepts legacy scalar CWE values returned by npm bulk advisories", () => {
  const outcome = evaluateBulkAdvisories(
    {
      "fixture-package": [advisory({ cwe: "CWE-79" })],
    },
    fixtureGraph(),
  );

  assert.equal(outcome.summary.advisories[0].cwe, "CWE-79");
});

test("fails closed on malformed raw advisory, unknown severity, and schema drift", () => {
  const graph = fixtureGraph();
  assert.throws(
    () => evaluateBulkAdvisories({ "fixture-package": [null] }, graph),
    /must be an object/,
  );
  assert.throws(
    () =>
      evaluateBulkAdvisories(
        {
          "fixture-package": [advisory({ severity: "urgent" })],
        },
        graph,
      ),
    /unsupported value "urgent"/,
  );
  assert.throws(
    () =>
      evaluateBulkAdvisories(
        {
          "fixture-package": [advisory({ future_field: "hidden" })],
        },
        graph,
      ),
    /unsupported fields: future_field/,
  );
  assert.throws(
    () => evaluateBulkAdvisories({ "fixture-package": [] }, graph),
    /must not be an empty advisory array/,
  );
});

test("rejects invalid and duplicate advisory IDs before normalization", () => {
  for (const id of ["1001", 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        evaluateBulkAdvisories(
          { "fixture-package": [advisory({ id })] },
          fixtureGraph(),
        ),
      /id must be a positive integer/,
    );
  }
  assert.throws(
    () =>
      evaluateBulkAdvisories(
        {
          "fixture-package": [advisory({ id: 9 }), advisory({ id: 9 })],
        },
        fixtureGraph(),
      ),
    /duplicate advisory id 9/,
  );
});

test("rejects advisories not bound to requested packages and versions", () => {
  assert.throws(
    () =>
      evaluateBulkAdvisories(
        { "unrequested-package": [advisory()] },
        fixtureGraph(),
      ),
    /was not requested from exact lockfile graph/,
  );
  assert.throws(
    () =>
      evaluateBulkAdvisories(
        {
          "fixture-package": [
            advisory({ vulnerable_versions: ">=2.0.0 <3.0.0" }),
          ],
        },
        fixtureGraph(),
      ),
    /does not match any requested fixture-package version/,
  );
  assert.throws(
    () =>
      evaluateBulkAdvisories(
        {
          "fixture-package": [advisory({ name: "different-package" })],
        },
        fixtureGraph(),
      ),
    /does not bind to requested package/,
  );
});

test("rejects inconsistent dependency counts and occurrence paths", () => {
  const graph = fixtureGraph();
  const wrongCount = {
    ...graph,
    dependencyCounts: { ...graph.dependencyCounts, totalDependencies: 2 },
  };
  assert.throws(
    () => evaluateBulkAdvisories({}, wrongCount),
    /Dependency count mismatch for totalDependencies/,
  );

  const occurrence = graph.occurrences.get("fixture-package\u00001.0.0");
  const wrongPaths = {
    ...graph,
    occurrences: new Map([
      [
        "fixture-package\u00001.0.0",
        { ...occurrence, paths: ["z>path", "a>path"] },
      ],
    ]),
  };
  assert.throws(
    () => evaluateBulkAdvisories({}, wrongPaths),
    /must be nonempty, unique, and sorted/,
  );
});

test("escapes complete summary for GitHub HTML output", () => {
  const outcome = evaluateBulkAdvisories(
    {
      "fixture-package": [
        advisory({ title: `<script>"hostile" & 'payload'</script>` }),
      ],
    },
    fixtureGraph(),
  );
  const html = renderSummaryHtml(outcome.summary);

  assert.match(
    html,
    /&lt;script&gt;\\&quot;hostile\\&quot; &amp; &#39;payload&#39;&lt;\/script&gt;/,
  );
  // codeql[js/bad-tag-filter] -- assertion proves escaping removed every tag; lowercase-only check is the invariant under test
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /fixture-package/);
  assert.match(html, /vulnerabilities/);
});

test("bounded request sends exact JSON and configured authorization", async () => {
  let receivedBody = "";
  let receivedAuthorization;
  const server = createHttpServer((request, response) => {
    receivedAuthorization = request.headers.authorization;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      receivedBody += chunk;
    });
    request.on("end", () => {
      response.writeHead(200);
      response.end("{}");
    });
  });
  const port = await listen(server);
  try {
    const result = await postBoundedJson(
      `http://127.0.0.1:${String(port)}/audit`,
      { package: ["1.0.0"] },
      {
        authorization: "Bearer fixture-token",
        requestImpl: httpRequest,
        connectTimeoutMs: 500,
        idleTimeoutMs: 500,
        totalTimeoutMs: 1_000,
      },
    );
    assert.deepEqual(result, {});
    assert.equal(receivedAuthorization, "Bearer fixture-token");
    assert.deepEqual(JSON.parse(receivedBody), { package: ["1.0.0"] });
  } finally {
    await closeServer(server);
  }
});

test("network total timeout aborts a hanging response", async () => {
  const server = createHttpServer(() => {});
  const port = await listen(server);
  try {
    await assert.rejects(
      postBoundedJson(
        `http://127.0.0.1:${String(port)}/hang`,
        { package: ["1.0.0"] },
        {
          requestImpl: httpRequest,
          connectTimeoutMs: 500,
          idleTimeoutMs: 500,
          totalTimeoutMs: 80,
        },
      ),
      /total timeout after 80ms/,
    );
  } finally {
    await closeServer(server);
  }
});

test("network idle timeout aborts a silent response", async () => {
  const server = createHttpServer(() => {});
  const port = await listen(server);
  try {
    await assert.rejects(
      postBoundedJson(
        `http://127.0.0.1:${String(port)}/idle`,
        { package: ["1.0.0"] },
        {
          requestImpl: httpRequest,
          connectTimeoutMs: 500,
          idleTimeoutMs: 80,
          totalTimeoutMs: 1_000,
        },
      ),
      /idle timeout after 80ms/,
    );
  } finally {
    await closeServer(server);
  }
});

test("network connect timeout aborts a stalled TLS handshake", async () => {
  const sockets = new Set();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const port = await listen(server);
  try {
    await assert.rejects(
      postBoundedJson(
        `https://127.0.0.1:${String(port)}/hang`,
        { package: ["1.0.0"] },
        {
          requestImpl: httpsRequest,
          // codeql[js/disabling-certificate-validation] -- loopback fixture simulates a hostile TLS peer to prove connect-timeout handling
          requestOptions: { rejectUnauthorized: false },
          connectTimeoutMs: 80,
          idleTimeoutMs: 500,
          totalTimeoutMs: 1_000,
        },
      ),
      /connect timeout after 80ms/,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
  }
});

test("network rejects partial bodies and invalid JSON", async () => {
  let requestCount = 0;
  const server = createHttpServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": requestCount === 1 ? "50" : "5",
    });
    if (requestCount === 1) {
      response.write('{"fixture":');
      setTimeout(() => response.destroy(), 10);
    } else {
      response.end("nope!");
    }
  });
  const port = await listen(server);
  const options = {
    requestImpl: httpRequest,
    connectTimeoutMs: 500,
    idleTimeoutMs: 500,
    totalTimeoutMs: 1_000,
  };
  try {
    await assert.rejects(
      postBoundedJson(`http://127.0.0.1:${String(port)}/partial`, {}, options),
      /truncated|incomplete|aborted/,
    );
    await assert.rejects(
      postBoundedJson(`http://127.0.0.1:${String(port)}/invalid`, {}, options),
      /invalid JSON/,
    );
  } finally {
    await closeServer(server);
  }
});

test("network rejects non-200 status and oversized body", async () => {
  let requestCount = 0;
  const server = createHttpServer((_request, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end('{"error":"unavailable"}');
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": "100",
    });
    response.end("{}".padEnd(100, " "));
  });
  const port = await listen(server);
  const options = {
    requestImpl: httpRequest,
    connectTimeoutMs: 500,
    idleTimeoutMs: 500,
    totalTimeoutMs: 1_000,
  };
  try {
    await assert.rejects(
      postBoundedJson(`http://127.0.0.1:${String(port)}/status`, {}, options),
      /registry returned HTTP 503/,
    );
    await assert.rejects(
      postBoundedJson(
        `http://127.0.0.1:${String(port)}/large`,
        {},
        { ...options, maxResponseBytes: 20 },
      ),
      /response exceeds 20 byte limit/,
    );
  } finally {
    await closeServer(server);
  }
});

test("bounded child returns nonzero status without normalizing it", async () => {
  const result = await runBoundedChild(
    process.execPath,
    ["-e", "process.stderr.write('fixture failure'); process.exit(7)"],
    { timeoutMs: 1_000, label: "nonzero fixture" },
  );

  assert.equal(result.status, 7);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "fixture failure");
});

test("bounded child terminates a hanging process", async () => {
  await assert.rejects(
    runBoundedChild(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      timeoutMs: 80,
      killGraceMs: 40,
      label: "hanging fixture",
    }),
    /hanging fixture timed out after 80ms/,
  );
});

test("full audit pins pnpm/config/root while allowing deterministic transport", async () => {
  let capturedRequest;
  let capturedAuthorization;
  let capturedProvenanceGraph;
  const outcome = await runAudit({
    verifyProvenance: async (graph) => {
      capturedProvenanceGraph = graph;
    },
    requestAdvisories: async (request, authorization) => {
      capturedRequest = request;
      capturedAuthorization = authorization;
      return {};
    },
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(capturedProvenanceGraph.supplyChain.integrity.entries, 747);
  assert.equal(Object.keys(capturedRequest).length, 662);
  assert.equal(
    capturedAuthorization === undefined ||
      /^Bearer [^\s]+$/.test(capturedAuthorization),
    true,
  );
  assert.deepEqual(outcome.summary.vulnerabilities, {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  });
  assert.equal(outcome.summary.dependencyGraph.totalDependencies, 747);
});

test(
  "live canonical bulk advisory audit",
  { skip: process.env.RUN_LIVE_AUDIT !== "1", timeout: 30_000 },
  async () => {
    const outcome = await runAudit();
    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(outcome.summary.vulnerabilities, {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
    });
  },
);
