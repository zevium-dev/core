import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const ignoredDirectoryNames = new Set([
  ".agents",
  ".git",
  ".nitro",
  ".output",
  ".tanstack",
  ".turbo",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
]);
const generatedOrFixturePaths = [
  "apps/web/src/routeTree.gen.ts",
  "convex/_generated/",
  "scripts/quality/fixtures/",
];
const forbiddenSyntax = /[;&|<>`$(){}\n\r\\'"*?]/;

function normalize(path) {
  return path.split(sep).join("/");
}

function isGeneratedOrFixture(path, workspace) {
  const repositoryPath = normalize(relative(repositoryRoot, path));
  if (
    resolve(workspace) === repositoryRoot &&
    !repositoryPath.startsWith("../")
  ) {
    return generatedOrFixturePaths.some(
      (excluded) =>
        repositoryPath === excluded.replace(/\/$/, "") ||
        repositoryPath.startsWith(excluded),
    );
  }
  const workspacePath = normalize(relative(workspace, path));
  return workspacePath.startsWith("scripts/quality/fixtures/");
}

function collectOwnedFiles(directory, workspace, excludedRoots = []) {
  const files = [];
  const excluded = excludedRoots.map((path) => resolve(workspace, path));

  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirectoryNames.has(entry.name)) continue;
        if (
          excluded.some(
            (root) => path === root || path.startsWith(`${root}${sep}`),
          )
        )
          continue;
        visit(path);
      } else if (
        sourceExtensions.has(extname(entry.name)) &&
        !isGeneratedOrFixture(path, workspace)
      ) {
        files.push(path);
      }
    }
  }

  visit(directory);
  return files.sort();
}

function parseOxlintCommand(command, packageName, cwd, expectedConfig) {
  if (typeof command !== "string" || command.trim() === "<NONEXISTENT>") {
    throw new Error(`${packageName}: missing lint command`);
  }
  if (
    forbiddenSyntax.test(command) ||
    command.includes("[") ||
    command.includes("]")
  ) {
    throw new Error(
      `${packageName}: shell composition, quoting, and globs are forbidden in lint command`,
    );
  }

  const words = command.trim().split(/\s+/);
  if (words.shift() !== "oxlint") {
    throw new Error(
      `${packageName}: lint command must execute oxlint directly`,
    );
  }

  const args = [...words];
  const targets = [];
  let configuredPath;
  let denyWarnings = 0;
  let unusedDirectives = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "--config" || word === "-c") {
      if (configuredPath !== undefined || !words[index + 1]) {
        throw new Error(`${packageName}: lint config must be specified once`);
      }
      configuredPath = words[index + 1];
      index += 1;
      continue;
    }
    if (word === "--deny-warnings") {
      denyWarnings += 1;
      continue;
    }
    if (word === "--report-unused-disable-directives") {
      unusedDirectives += 1;
      continue;
    }
    if (word === "--no-ignore") continue;
    if (word.startsWith("-")) {
      throw new Error(
        `${packageName}: lint weakening or config override flag is forbidden: ${word}`,
      );
    }
    targets.push(word);
  }

  if (denyWarnings !== 1 || unusedDirectives !== 1) {
    throw new Error(
      `${packageName}: lint must deny warnings and report unused disable directives`,
    );
  }
  if (
    configuredPath === undefined ||
    resolve(cwd, configuredPath) !== resolve(expectedConfig)
  ) {
    throw new Error(
      `${packageName}: lint must use exact root config ${normalize(relative(cwd, expectedConfig))}`,
    );
  }
  if (targets.length === 0) {
    throw new Error(`${packageName}: lint command configures no file targets`);
  }
  return { args, targets };
}

function selectedFiles(oxlint, args, cwd, packageName) {
  const result = spawnSync(oxlint, [...args, "--debug=files"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `${packageName}: Oxlint file enumeration failed\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((path) => resolve(cwd, path))
    .sort();
}

function compareExactCoverage(packageName, expected, selected) {
  const expectedSet = new Set(expected);
  const selectedSet = new Set(selected);
  const missing = expected.filter((path) => !selectedSet.has(path));
  const extra = selected.filter((path) => !expectedSet.has(path));
  if (missing.length || extra.length) {
    const details = [
      ...missing.map(
        (path) =>
          `ignored/missing owned file: ${normalize(relative(repositoryRoot, path))}`,
      ),
      ...extra.map(
        (path) =>
          `outside owned scope: ${normalize(relative(repositoryRoot, path))}`,
      ),
    ];
    throw new Error(
      `${packageName}: lint coverage is not exact\n${details.join("\n")}`,
    );
  }
}

export function attestLintTask({
  task,
  workspace,
  expectedConfig = resolve(repositoryRoot, ".oxlintrc.json"),
  excludedRoots = [],
}) {
  const cwd = resolve(workspace, task.directory);
  if (!existsSync(cwd)) {
    throw new Error(`${task.package}: lint directory does not exist`);
  }
  const { args } = parseOxlintCommand(
    task.command,
    task.package,
    cwd,
    expectedConfig,
  );
  const expected = collectOwnedFiles(cwd, workspace, excludedRoots);
  if (expected.length === 0) {
    throw new Error(`${task.package}: owned lint scope is empty`);
  }

  const oxlint = resolve(repositoryRoot, "node_modules/.bin/oxlint");
  if (!existsSync(oxlint))
    throw new Error(`Oxlint executable missing: ${oxlint}`);
  compareExactCoverage(
    task.package,
    expected,
    selectedFiles(oxlint, args, cwd, task.package),
  );

  const production = spawnSync(oxlint, args, { cwd, encoding: "utf8" });
  if (production.status !== 0) {
    throw new Error(
      `${task.package}: actual production lint command failed\n${production.stdout}${production.stderr}`,
    );
  }
  return expected.map((path) => normalize(relative(workspace, path)));
}

export function validateLintGraph(report, workspace = repositoryRoot) {
  const packages = new Set(report.packages ?? []);
  const lintTasks = (report.tasks ?? []).filter((task) => task.task === "lint");
  const tasksByPackage = new Map();
  for (const task of lintTasks) {
    const matches = tasksByPackage.get(task.package) ?? [];
    matches.push(task);
    tasksByPackage.set(task.package, matches);
  }

  const missing = [...packages].filter((name) => !tasksByPackage.has(name));
  const duplicates = [...tasksByPackage]
    .filter(([, tasks]) => tasks.length !== 1)
    .map(([name]) => name);
  if (
    packages.size === 0 ||
    lintTasks.length !== packages.size ||
    missing.length ||
    duplicates.length
  ) {
    const details = [
      `packages=${packages.size}`,
      `lintTasks=${lintTasks.length}`,
      missing.length ? `missing=${missing.join(",")}` : "",
      duplicates.length ? `duplicates=${duplicates.join(",")}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    throw new Error(`Turbo lint graph is skippable: ${details}`);
  }

  const ownedFiles = Object.fromEntries(
    [...packages].sort().map((packageName) => [
      packageName,
      attestLintTask({
        task: tasksByPackage.get(packageName)[0],
        workspace,
      }),
    ]),
  );
  return {
    packages: packages.size,
    tasks: lintTasks.length,
    fileCounts: Object.fromEntries(
      Object.entries(ownedFiles).map(([name, files]) => [name, files.length]),
    ),
    ownedFiles,
  };
}

export function inspectTurboLint(workspace = repositoryRoot) {
  const turbo = resolve(repositoryRoot, "node_modules/.bin/turbo");
  if (!existsSync(turbo)) throw new Error(`Turbo executable missing: ${turbo}`);
  const result = spawnSync(turbo, ["run", "lint", "--dry=json"], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Turbo dry run failed");
  }
  const report = JSON.parse(result.stdout);
  const attestation = validateLintGraph(report, workspace);

  if (resolve(workspace) === repositoryRoot) {
    const rootPackage = JSON.parse(
      readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
    );
    const workspaceRoots = (report.tasks ?? [])
      .filter((task) => task.task === "lint")
      .map((task) => task.directory);
    const rootFiles = attestLintTask({
      task: {
        package: "<root>",
        directory: ".",
        command: rootPackage.scripts?.["lint:repo"],
      },
      workspace,
      excludedRoots: workspaceRoots,
    });
    attestation.fileCounts["<root>"] = rootFiles.length;
    attestation.ownedFiles["<root>"] = rootFiles;
  }
  return attestation;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workspaceFlag = process.argv.indexOf("--workspace");
  const workspace =
    workspaceFlag === -1
      ? repositoryRoot
      : resolve(process.argv[workspaceFlag + 1] ?? "");
  try {
    const result = inspectTurboLint(workspace);
    process.stdout.write(
      `Turbo lint graph locked: ${result.tasks}/${result.packages} runnable tasks\n`,
    );
    for (const [name, files] of Object.entries(result.ownedFiles)) {
      process.stdout.write(`${name}: ${files.length} exact owned files\n`);
      for (const file of files) process.stdout.write(`  ${file}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
