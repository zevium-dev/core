import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const repositoryRoot = resolve(import.meta.dirname, "../..");

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

export function checkBundles({ bundleRoot, configPath }) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const failures = [];
  const measurements = [];

  for (const [target, extensionBudgets] of Object.entries(config.budgets)) {
    const targetRoot = resolve(bundleRoot, target);
    const files = collectFiles(targetRoot);
    for (const [extension, budget] of Object.entries(extensionBudgets)) {
      const matching = files.filter((path) => extname(path) === extension);
      const sizes = matching.map((path) => {
        const source = readFileSync(path);
        return {
          path,
          bytes: statSync(path).size,
          gzipBytes: gzipSync(source, { level: 9 }).length,
        };
      });
      const totalBytes = sizes.reduce((sum, file) => sum + file.bytes, 0);
      const totalGzipBytes = sizes.reduce(
        (sum, file) => sum + file.gzipBytes,
        0,
      );
      const largest = sizes.toSorted((a, b) => b.bytes - a.bytes)[0];
      const largestGzip = sizes.toSorted(
        (a, b) => b.gzipBytes - a.gzipBytes,
      )[0];

      const actual = {
        files: sizes.length,
        totalBytes,
        totalGzipBytes,
        fileBytes: largest?.bytes ?? 0,
        fileGzipBytes: largestGzip?.gzipBytes ?? 0,
      };
      measurements.push({ target, extension, ...actual });

      for (const [budgetKey, actualKey] of [
        ["maxFiles", "files"],
        ["maxTotalBytes", "totalBytes"],
        ["maxTotalGzipBytes", "totalGzipBytes"],
        ["maxFileBytes", "fileBytes"],
        ["maxFileGzipBytes", "fileGzipBytes"],
      ]) {
        if (actual[actualKey] > budget[budgetKey]) {
          failures.push(
            `${target} ${extension} ${actualKey}=${actual[actualKey]} exceeds ${budget[budgetKey]}`,
          );
        }
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Bundle budget failures:\n${failures.join("\n")}`);
  }
  return measurements;
}

if (process.argv[1] === import.meta.filename) {
  const rootFlag = process.argv.indexOf("--root");
  const configFlag = process.argv.indexOf("--config");
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

  try {
    const measurements = checkBundles({ bundleRoot, configPath });
    for (const measurement of measurements) {
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
