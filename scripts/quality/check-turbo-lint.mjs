import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const shellSyntax = /[;&|<>`$(){}\n\r]/;

function parseOxlintCommand(command, packageName) {
  if (typeof command !== "string" || command.trim() === "<NONEXISTENT>") {
    throw new Error(`${packageName}: missing lint command`);
  }
  if (shellSyntax.test(command)) {
    throw new Error(
      `${packageName}: shell composition is forbidden in lint command`,
    );
  }
  const words = command.trim().split(/\s+/);
  if (words.shift() !== "oxlint") {
    throw new Error(
      `${packageName}: lint command must execute oxlint directly`,
    );
  }
  if (words.includes("--no-error-on-unmatched-pattern")) {
    throw new Error(`${packageName}: unmatched lint targets must fail`);
  }
  if (words.some((word) => word === "--silent" || word.startsWith("--fix"))) {
    throw new Error(
      `${packageName}: lint command may not hide or mutate diagnostics`,
    );
  }
  const targets = words.filter((word, index) => {
    if (word.startsWith("-")) return false;
    const previous = words[index - 1];
    return previous !== "--config" && previous !== "-c";
  });
  if (targets.length === 0) {
    throw new Error(`${packageName}: lint command configures no file targets`);
  }
  return { args: words, targets };
}

function runConfiguredLint(task, workspace) {
  const cwd = resolve(workspace, task.directory);
  const { args, targets } = parseOxlintCommand(task.command, task.package);
  const resolvedTargets = targets.map((target) => resolve(cwd, target));
  if (resolvedTargets.some((target) => !existsSync(target))) {
    throw new Error(`${task.package}: lint target does not exist`);
  }
  if (!resolvedTargets.some((target) => statSync(target).isDirectory())) {
    throw new Error(
      `${task.package}: lint command must cover a source directory`,
    );
  }

  const oxlint = resolve(repositoryRoot, "node_modules/.bin/oxlint");
  const result = spawnSync(oxlint, [...args, "--format=json"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `${task.package}: configured lint command failed\n${result.stdout}${result.stderr}`,
    );
  }
  const report = JSON.parse(result.stdout);
  if (
    !Number.isInteger(report.number_of_files) ||
    report.number_of_files <= targets.length
  ) {
    throw new Error(
      `${task.package}: lint file count is not nontrivial: files=${report.number_of_files} targets=${targets.length}`,
    );
  }
  return report.number_of_files;
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

  const fileCounts = Object.fromEntries(
    [...packages]
      .sort()
      .map((packageName) => [
        packageName,
        runConfiguredLint(tasksByPackage.get(packageName)[0], workspace),
      ]),
  );
  return { packages: packages.size, tasks: lintTasks.length, fileCounts };
}

export function inspectTurboLint(workspace = repositoryRoot) {
  const turbo = resolve(repositoryRoot, "node_modules/.bin/turbo");
  if (!existsSync(turbo)) throw new Error(`Turbo executable missing: ${turbo}`);
  const result = spawnSync(turbo, ["run", "lint", "--dry=json"], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
  });
  if (result.status !== 0)
    throw new Error(result.stderr || result.stdout || "Turbo dry run failed");
  return validateLintGraph(JSON.parse(result.stdout), workspace);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workspaceFlag = process.argv.indexOf("--workspace");
  const workspace =
    workspaceFlag === -1
      ? repositoryRoot
      : resolve(process.argv[workspaceFlag + 1] ?? "");
  try {
    const counts = inspectTurboLint(workspace);
    process.stdout.write(
      `Turbo lint graph locked: ${counts.tasks}/${counts.packages} runnable tasks\n`,
    );
    for (const [name, count] of Object.entries(counts.fileCounts)) {
      process.stdout.write(`${name}: linted ${count} files\n`);
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
