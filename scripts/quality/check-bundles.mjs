import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const budgetKeys = [
  ["maxFiles", "files"],
  ["maxTotalBytes", "totalBytes"],
  ["maxTotalGzipBytes", "totalGzipBytes"],
  ["maxFileBytes", "fileBytes"],
  ["maxFileGzipBytes", "fileGzipBytes"],
];

function collectFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(path);
    }
  }
  visit(root);
  return files;
}

function validateProvenance(config, repository) {
  const measurement = config.measurement;
  if (
    !measurement ||
    typeof measurement.command !== "string" ||
    !measurement.command.trim()
  )
    throw new Error("Bundle measurement command is required");
  if (!/^[0-9a-f]{40}$/.test(measurement.baselineCommit ?? ""))
    throw new Error("Bundle baselineCommit must be a full commit SHA");
  if (
    !Number.isFinite(measurement.headroomPercent) ||
    measurement.headroomPercent < 0 ||
    measurement.headroomPercent > 20
  )
    throw new Error("Bundle headroomPercent must be between 0 and 20");
  if (
    typeof measurement.reason !== "string" ||
    measurement.reason.trim().length < 20
  )
    throw new Error("Bundle measurement reason must explain headroom");
  try {
    execFileSync(
      "git",
      ["cat-file", "-e", `${measurement.baselineCommit}^{commit}`],
      { cwd: repository, stdio: "pipe" },
    );
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", measurement.baselineCommit, "HEAD"],
      { cwd: repository, stdio: "pipe" },
    );
  } catch {
    throw new Error(
      `Bundle baseline commit is missing or not an ancestor: ${measurement.baselineCommit}`,
    );
  }
  return measurement;
}

export function checkBundles({
  bundleRoot,
  configPath,
  repository = repositoryRoot,
}) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const measurement = validateProvenance(config, repository);
  const failures = [];
  const measurements = [];
  const configuredArtifacts = new Set(
    Object.entries(config.budgets ?? {}).flatMap(([target, extensions]) =>
      Object.keys(extensions).map((extension) => `${target}:${extension}`),
    ),
  );
  if (
    !Array.isArray(measurement.requiredArtifacts) ||
    measurement.requiredArtifacts.length === 0
  ) {
    failures.push("Bundle measurement requiredArtifacts must be non-empty");
  } else {
    for (const artifact of measurement.requiredArtifacts) {
      if (!configuredArtifacts.has(artifact)) {
        failures.push(`Bundle budget missing required artifact: ${artifact}`);
      }
    }
  }
  for (const [target, extensionBudgets] of Object.entries(
    config.budgets ?? {},
  )) {
    const files = collectFiles(resolve(bundleRoot, target));
    for (const [extension, budget] of Object.entries(extensionBudgets)) {
      const matching = files.filter((path) => extname(path) === extension);
      const sizes = matching.map((path) => {
        const source = readFileSync(path);
        return {
          bytes: statSync(path).size,
          gzipBytes: gzipSync(source, { level: 9 }).length,
        };
      });
      const actual = {
        files: sizes.length,
        totalBytes: sizes.reduce((sum, file) => sum + file.bytes, 0),
        totalGzipBytes: sizes.reduce((sum, file) => sum + file.gzipBytes, 0),
        fileBytes: Math.max(0, ...sizes.map((file) => file.bytes)),
        fileGzipBytes: Math.max(0, ...sizes.map((file) => file.gzipBytes)),
      };
      measurements.push({ target, extension, ...actual });
      if (actual.files === 0)
        failures.push(`${target} ${extension} has no measured artifacts`);
      for (const [budgetKey, actualKey] of budgetKeys) {
        const baseline = budget.baseline?.[actualKey];
        const maximum = budget[budgetKey];
        if (!Number.isInteger(baseline) || baseline <= 0)
          failures.push(
            `${target} ${extension} missing positive baseline.${actualKey}`,
          );
        const derivedMaximum = Number.isInteger(baseline)
          ? Math.ceil(baseline * (1 + measurement.headroomPercent / 100))
          : NaN;
        if (maximum !== derivedMaximum)
          failures.push(
            `${target} ${extension} ${budgetKey}=${maximum} does not match baseline/headroom=${derivedMaximum}`,
          );
        if (actual[actualKey] > maximum)
          failures.push(
            `${target} ${extension} ${actualKey}=${actual[actualKey]} exceeds ${maximum}`,
          );
      }
    }
  }
  if (!measurements.length)
    failures.push("Bundle config defines no measured artifacts");
  if (failures.length)
    throw new Error(`Bundle budget failures:\n${failures.join("\n")}`);
  return measurements;
}

if (process.argv[1] === import.meta.filename) {
  const rootFlag = process.argv.indexOf("--root");
  const configFlag = process.argv.indexOf("--config");
  const repositoryFlag = process.argv.indexOf("--repository");
  const bundleRoot = resolve(
    rootFlag === -1
      ? join(repositoryRoot, "apps/web/dist")
      : process.argv[rootFlag + 1],
  );
  const configPath = resolve(
    configFlag === -1
      ? join(import.meta.dirname, "bundle-budgets.json")
      : process.argv[configFlag + 1],
  );
  const repository = resolve(
    repositoryFlag === -1 ? repositoryRoot : process.argv[repositoryFlag + 1],
  );
  try {
    for (const measurement of checkBundles({
      bundleRoot,
      configPath,
      repository,
    })) {
      process.stdout.write(
        `${measurement.target} ${measurement.extension}: files=${measurement.files} bytes=${measurement.totalBytes} gzip=${measurement.totalGzipBytes}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
