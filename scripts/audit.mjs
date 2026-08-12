import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const severities = ["info", "low", "moderate", "high", "critical"];

const blockingSeverities = new Set(["high", "critical"]);
const capturedSeverities = new Set(severities);
const dependencyCountKeys = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "totalDependencies",
];
const auditConfigKeys = new Set([
  "ignoreGhsas",
  "ignoreCves",
  "ignore",
  "ignoreUnfixable",
  "ignoreRegistryErrors",
]);
const flattenedSuppressionKeys = new Set([
  "auditconfigignoreghsas",
  "auditconfigignorecves",
  "auditconfigignore",
  "auditconfigignoreunfixable",
  "auditconfigignoreregistryerrors",
  "auditignore",
  "ignoreunfixable",
  "ignoreregistryerrors",
]);

class AuditValidationError extends Error {}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) {
    throw new AuditValidationError(`${label} must be an object.`);
  }
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new AuditValidationError(`${label} must be a non-negative integer.`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new AuditValidationError(`${label} must be a non-empty string.`);
  }
  return value;
}

function parseJsonObject(stdout, label) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AuditValidationError(`${label} returned invalid JSON: ${detail}`);
  }
  return requireRecord(parsed, label);
}

function isEmptySuppression(value) {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    (Array.isArray(value) && value.length === 0) ||
    (isRecord(value) && Object.keys(value).length === 0)
  );
}

export function validateAuditConfig(config) {
  const root = requireRecord(config, "pnpm config");
  const auditConfig = root.auditConfig;

  if (auditConfig !== undefined) {
    const entries = Object.entries(requireRecord(auditConfig, "auditConfig"));
    for (const [key, value] of entries) {
      if (!auditConfigKeys.has(key)) {
        throw new AuditValidationError(
          `Unsupported auditConfig.${key} is configured; audit policy requires an empty allowlist.`,
        );
      }
      if (!isEmptySuppression(value)) {
        throw new AuditValidationError(
          `auditConfig.${key} suppresses audit results; audit policy requires an empty allowlist.`,
        );
      }
    }
  }

  for (const [key, value] of Object.entries(root)) {
    const normalized = key.replaceAll(/[-_.]/g, "").toLowerCase();
    if (flattenedSuppressionKeys.has(normalized)) {
      if (!isEmptySuppression(value)) {
        throw new AuditValidationError(
          `${key} suppresses audit results; audit policy requires an empty allowlist.`,
        );
      }
    }
  }

  return [];
}

function validateFinding(finding, label) {
  const value = requireRecord(finding, label);
  requireString(value.version, `${label}.version`);
  if (
    !Array.isArray(value.paths) ||
    value.paths.length === 0 ||
    value.paths.some((path) => typeof path !== "string" || path.length === 0)
  ) {
    throw new AuditValidationError(
      `${label}.paths must contain at least one dependency path.`,
    );
  }
}

function validateAdvisory(advisory, key) {
  const label = `advisories.${key}`;
  const value = requireRecord(advisory, label);
  if (typeof value.id !== "number" && typeof value.id !== "string") {
    throw new AuditValidationError(`${label}.id must be a number or string.`);
  }
  requireString(value.module_name, `${label}.module_name`);
  requireString(value.title, `${label}.title`);
  requireString(value.vulnerable_versions, `${label}.vulnerable_versions`);
  requireString(value.patched_versions, `${label}.patched_versions`);
  requireString(value.severity, `${label}.severity`);
  if (!capturedSeverities.has(value.severity)) {
    throw new AuditValidationError(
      `${label}.severity has unsupported value ${JSON.stringify(value.severity)}.`,
    );
  }
  if (!Array.isArray(value.findings) || value.findings.length === 0) {
    throw new AuditValidationError(
      `${label}.findings must be a non-empty array.`,
    );
  }
  value.findings.forEach((finding, index) =>
    validateFinding(finding, `${label}.findings[${index}]`),
  );
  return value;
}

export function parseAuditReport(report) {
  const root = requireRecord(report, "pnpm audit report");
  if ("error" in root) {
    throw new AuditValidationError("pnpm audit returned an error report.");
  }

  const metadata = requireRecord(root.metadata, "metadata");
  const vulnerabilities = requireRecord(
    metadata.vulnerabilities,
    "metadata.vulnerabilities",
  );
  const unknownSeverities = Object.keys(vulnerabilities).filter(
    (severity) => !capturedSeverities.has(severity),
  );
  if (unknownSeverities.length > 0) {
    throw new AuditValidationError(
      `metadata.vulnerabilities contains unsupported severities: ${unknownSeverities.join(", ")}.`,
    );
  }

  const counts = Object.fromEntries(
    severities.map((severity) => [
      severity,
      requireNonNegativeInteger(
        vulnerabilities[severity],
        `metadata.vulnerabilities.${severity}`,
      ),
    ]),
  );
  const dependencyCounts = Object.fromEntries(
    dependencyCountKeys.map((key) => [
      key,
      requireNonNegativeInteger(metadata[key], `metadata.${key}`),
    ]),
  );

  const advisoryMap = requireRecord(root.advisories, "advisories");
  const advisories = Object.entries(advisoryMap)
    .map(([key, advisory]) => validateAdvisory(advisory, key))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const detailCounts = Object.fromEntries(
    severities.map((severity) => [
      severity,
      advisories.filter((advisory) => advisory.severity === severity).length,
    ]),
  );

  for (const severity of severities) {
    if (counts[severity] !== detailCounts[severity]) {
      throw new AuditValidationError(
        `metadata/detail mismatch for ${severity}: metadata=${counts[severity]}, advisories=${detailCounts[severity]}.`,
      );
    }
  }

  return { advisories, counts, dependencyCounts };
}

export function evaluateAuditResults(configResult, auditResult) {
  if (configResult.error) {
    throw new AuditValidationError(
      `Unable to inspect pnpm config: ${configResult.error.message}`,
    );
  }
  if (configResult.status !== 0) {
    throw new AuditValidationError(
      `pnpm config exited ${String(configResult.status)}: ${configResult.stderr.trim()}`,
    );
  }
  const allowlist = validateAuditConfig(
    parseJsonObject(configResult.stdout, "pnpm config"),
  );

  if (auditResult.error) {
    throw new AuditValidationError(
      `Unable to run pnpm audit: ${auditResult.error.message}`,
    );
  }
  const report = parseAuditReport(
    parseJsonObject(auditResult.stdout, "pnpm audit"),
  );
  const totalAdvisories = Object.values(report.counts).reduce(
    (sum, count) => sum + count,
    0,
  );
  const expectedPnpmStatus = totalAdvisories > 0 ? 1 : 0;
  if (auditResult.status !== expectedPnpmStatus) {
    throw new AuditValidationError(
      `pnpm audit exited ${String(auditResult.status)}; expected ${expectedPnpmStatus} for full parsed report.`,
    );
  }

  const blockingAdvisories = report.advisories.filter((advisory) =>
    blockingSeverities.has(advisory.severity),
  );
  const summary = {
    policy: {
      command: "pnpm audit --audit-level info --json",
      blocks: ["high", "critical"],
      reportsWithoutBlocking: ["info", "low", "moderate"],
      allowlist,
    },
    vulnerabilities: report.counts,
    dependencyGraph: report.dependencyCounts,
    advisories: report.advisories,
  };

  return {
    blockingAdvisories,
    exitCode: blockingAdvisories.length > 0 ? 1 : 0,
    summary,
  };
}

export function renderSummaryHtml(summary) {
  const escapedSummary = JSON.stringify(summary, null, 2)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `## Dependency audit\n\n<pre>${escapedSummary}</pre>\n`;
}

export function runAudit() {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const options = {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  };
  const configResult = spawnSync(pnpm, ["config", "list", "--json"], options);
  const auditResult = spawnSync(
    pnpm,
    ["audit", "--audit-level", "info", "--json"],
    options,
  );
  return evaluateAuditResults(configResult, auditResult);
}

export function main() {
  try {
    const outcome = runAudit();
    const jsonSummary = JSON.stringify(outcome.summary, null, 2);
    console.log(jsonSummary);

    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        renderSummaryHtml(outcome.summary),
      );
    }
    if (outcome.blockingAdvisories.length > 0) {
      console.error(
        `Dependency audit blocked: ${outcome.blockingAdvisories.length} high/critical advisories found.`,
      );
    }
    return outcome.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main();
}
