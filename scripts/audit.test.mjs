import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BULK_ADVISORY_URL,
  CANONICAL_REGISTRY,
  evaluateBulkAdvisories,
  loadWorkspaceAuditGraph,
  postBoundedJson,
  renderSummaryHtml,
  runAudit,
  runBoundedChild,
  validateAuditArguments,
  validateAuditConfig,
  validateAuditEnvironment,
  validateWorkspaceRoot,
} from "./audit.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

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

test("parses exact repository workspace graph with every dependency type", () => {
  const graph = loadWorkspaceAuditGraph();

  assert.deepEqual(graph.lockfile.workspaceImporters, [
    ".",
    "apps/gateway",
    "apps/web",
    "packages/shared",
  ]);
  assert.deepEqual(graph.dependencyCounts, {
    dependencies: 283,
    devDependencies: 214,
    optionalDependencies: 205,
    totalDependencies: 642,
  });
  assert.equal(graph.occurrences.size, 642);
  assert.equal(Object.keys(graph.request).length, 566);
  assert.match(graph.lockfile.sha256, /^[a-f0-9]{64}$/);
  assert.equal(graph.lockfile.path, "pnpm-lock.yaml");
});

test("rejects hostile registry config and every dependency-scope selector", () => {
  assert.throws(
    () => validateAuditConfig({ registry: "https://hostile.invalid/" }),
    /registry overrides canonical/,
  );
  assert.deepEqual(
    validateAuditConfig({
      registry: CANONICAL_REGISTRY,
      "@jsr:registry": "https://npm.jsr.io/",
    }),
    [],
  );

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
      () => validateAuditConfig({ registry: CANONICAL_REGISTRY, [key]: value }),
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
      () => validateAuditConfig({ registry: CANONICAL_REGISTRY, [key]: value }),
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
    assert.throws(() => validateAuditConfig(config), /no suppressions/);
  }
  assert.deepEqual(
    validateAuditConfig({
      auditConfig: {
        ignoreGhsas: [],
        ignoreCves: [],
        ignore: {},
        ignoreUnfixable: false,
        ignoreRegistryErrors: false,
      },
    }),
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
  ]) {
    assert.throws(
      () => validateAuditEnvironment({ [key]: "hostile" }),
      /overrides audit scope, registry, lockfile, (?:or filtering|filtering, or suppression) policy/,
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
  const outcome = await runAudit({
    requestAdvisories: async (request, authorization) => {
      capturedRequest = request;
      capturedAuthorization = authorization;
      return {};
    },
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(Object.keys(capturedRequest).length, 566);
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
  assert.equal(outcome.summary.dependencyGraph.totalDependencies, 642);
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
