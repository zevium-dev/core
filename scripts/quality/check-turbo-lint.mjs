import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function validateLintGraph(report) {
  const packages = new Set(report.packages ?? []);
  const lintTasks = (report.tasks ?? []).filter((task) => task.task === "lint");
  const runnablePackages = new Set(
    lintTasks
      .filter(
        (task) =>
          typeof task.command === "string" &&
          task.command.trim().length > 0 &&
          task.command !== "<NONEXISTENT>",
      )
      .map((task) => task.package),
  );

  const missing = [...packages].filter((name) => !runnablePackages.has(name));
  const duplicates = [...runnablePackages].filter(
    (name) => lintTasks.filter((task) => task.package === name).length !== 1,
  );

  if (packages.size === 0) {
    throw new Error("Turbo reported zero workspace packages");
  }
  if (
    lintTasks.length !== packages.size ||
    missing.length > 0 ||
    duplicates.length > 0
  ) {
    const details = [
      `packages=${packages.size}`,
      `lintTasks=${lintTasks.length}`,
      `runnable=${runnablePackages.size}`,
      missing.length > 0 ? `missing=${missing.join(",")}` : "",
      duplicates.length > 0 ? `duplicates=${duplicates.join(",")}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    throw new Error(`Turbo lint graph is skippable: ${details}`);
  }

  return { packages: packages.size, tasks: lintTasks.length };
}

export function inspectTurboLint(workspace = repositoryRoot) {
  const turbo = resolve(repositoryRoot, "node_modules/.bin/turbo");
  if (!existsSync(turbo)) {
    throw new Error(`Turbo executable missing: ${turbo}`);
  }

  const result = spawnSync(turbo, ["run", "lint", "--dry=json"], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Turbo dry run failed");
  }

  const report = JSON.parse(result.stdout);
  return validateLintGraph(report);
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
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
