import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  evaluateAuditResults,
  parseAuditReport,
  renderSummaryHtml,
  runAudit,
  validateAuditConfig,
} from "./audit.mjs";

const fixtureUrl = new URL("./fixtures/audit/", import.meta.url);

function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, fixtureUrl), "utf8"));
}

function commandResult(value, status = 0) {
  return {
    error: undefined,
    status,
    stderr: "",
    stdout: typeof value === "string" ? value : JSON.stringify(value),
  };
}

const emptyConfigResult = commandResult({ auditConfig: { ignoreGhsas: [] } });

test("fails closed on empty or missing audit schema", () => {
  assert.throws(
    () => parseAuditReport(fixture("empty-object.json")),
    /metadata must be an object/,
  );
});

test("rejects filtered advisories even when pnpm exits zero", () => {
  assert.throws(
    () =>
      evaluateAuditResults(
        emptyConfigResult,
        commandResult(fixture("filtered-advisories.json")),
      ),
    /metadata\/detail mismatch for high/,
  );
});

test("rejects configured GHSA, path, and broad suppressions", () => {
  assert.throws(
    () => validateAuditConfig(fixture("ignored-ghsa-config.json")),
    /ignoreGhsas suppresses audit results/,
  );

  for (const config of [
    { auditConfig: { ignore: { "GHSA-path": [".>package"] } } },
    { auditConfig: { ignoreCves: ["CVE-2099-0001"] } },
    { auditConfig: { ignoreUnfixable: true } },
    { "auditConfig.ignoreGhsas": ["GHSA-flat-config"] },
    { ignoreRegistryErrors: true },
  ]) {
    assert.throws(
      () => validateAuditConfig(config),
      /suppresses audit results/,
    );
  }
  assert.deepEqual(
    validateAuditConfig({
      auditConfig: {
        ignore: {},
        ignoreCves: [],
        ignoreGhsas: [],
        ignoreRegistryErrors: false,
        ignoreUnfixable: false,
      },
    }),
    [],
  );
});

test("rejects mismatched metadata and advisory severities", () => {
  assert.throws(
    () => parseAuditReport(fixture("mismatched-metadata-advisories.json")),
    /metadata\/detail mismatch for moderate/,
  );
});

test("reports full moderate advisory detail without blocking", () => {
  const outcome = evaluateAuditResults(
    emptyConfigResult,
    commandResult(fixture("moderate-only.json"), 1),
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.blockingAdvisories.length, 0);
  assert.equal(outcome.summary.vulnerabilities.moderate, 1);
  assert.deepEqual(outcome.summary.policy.allowlist, []);
  assert.deepEqual(outcome.summary.advisories[0].cves, ["CVE-2099-0001"]);
  assert.deepEqual(outcome.summary.advisories[0].findings[0].paths, [
    ".>hostile-package@1.0.0",
  ]);
  assert.equal(
    outcome.summary.advisories[0].recommendation,
    "Upgrade to version 2.0.0 or later.",
  );
});

test("rejects unknown severities", () => {
  assert.throws(
    () => parseAuditReport(fixture("unknown-severity.json")),
    /unsupported severities: urgent/,
  );
});

test("turns nonzero network and parser failures into infrastructure failure", () => {
  assert.throws(
    () =>
      evaluateAuditResults(
        emptyConfigResult,
        commandResult(fixture("network-error.json"), 1),
      ),
    /pnpm audit returned an error report/,
  );
  assert.throws(
    () =>
      evaluateAuditResults(
        emptyConfigResult,
        commandResult("<html>registry failure</html>", 1),
      ),
    /pnpm audit returned invalid JSON/,
  );
});

test("rejects pnpm exit statuses inconsistent with parsed advisory detail", () => {
  assert.throws(
    () =>
      evaluateAuditResults(
        emptyConfigResult,
        commandResult(fixture("moderate-only.json"), 0),
      ),
    /pnpm audit exited 0; expected 1/,
  );
  assert.throws(
    () =>
      evaluateAuditResults(
        emptyConfigResult,
        commandResult(fixture("zero-workspace-graph.json"), 1),
      ),
    /pnpm audit exited 1; expected 0/,
  );
});

test("blocks high advisories and escapes HTML summary output", () => {
  const outcome = evaluateAuditResults(
    emptyConfigResult,
    commandResult(fixture("blocking-high.json"), 1),
  );
  const html = renderSummaryHtml(outcome.summary);

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.blockingAdvisories.length, 1);
  assert.match(html, /&lt;script&gt;alert\('hostile'\)&lt;\/script&gt; &amp;/);
  assert.doesNotMatch(html, /<script>/);
});

test("accepts captured zero-audit workspace graph", () => {
  const outcome = evaluateAuditResults(
    emptyConfigResult,
    commandResult(fixture("zero-workspace-graph.json")),
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.summary.dependencyGraph.totalDependencies, 642);
  assert.deepEqual(outcome.summary.advisories, []);
});

test(
  "real workspace graph remains a zero-audit graph",
  { timeout: 30_000 },
  () => {
    const outcome = runAudit();

    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(outcome.summary.vulnerabilities, {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
    });
    assert.ok(outcome.summary.dependencyGraph.totalDependencies > 0);
    assert.deepEqual(outcome.summary.advisories, []);
  },
);
