import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const executableForbiddenExtensions = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".mjs",
  ".mts",
  ".svg",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

export function assertNoExecutableArtifacts(
  root,
  label = "executable artifact policy",
) {
  const rootPath = resolve(root);
  const failures = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        const extension = extname(entry.name);
        if (
          executableForbiddenExtensions.has(extension) &&
          (lstatSync(path).mode & 0o111) !== 0
        ) {
          failures.push(relative(rootPath, path));
        }
      }
    }
  }
  visit(rootPath);
  if (failures.length > 0) {
    throw new Error(
      `${label}: generated/dist files must not be executable:\n${failures.join("\n")}`,
    );
  }
}

function git(args, cwd, encoding = "utf8") {
  const result = spawnSync("git", args, { cwd, encoding });
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.toString() || `git ${args.join(" ")} failed`,
    );
  }
  return result.stdout;
}

export function repositoryRoot(cwd) {
  return resolve(git(["rev-parse", "--show-toplevel"], cwd).trim());
}

function fileFingerprint(path) {
  try {
    const stat = lstatSync(path);
    const hash = createHash("sha256");
    if (stat.isSymbolicLink()) {
      hash.update("symlink\0");
      hash.update(readlinkSync(path));
    } else if (stat.isFile()) {
      hash.update("file\0");
      hash.update(readFileSync(path));
    } else {
      hash.update(`unsupported:${stat.mode}\0`);
    }
    hash.update(`\0executable:${stat.mode & 0o111 ? "yes" : "no"}`);
    return hash.digest("hex");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return "<missing>";
    }
    throw error;
  }
}

export function snapshotTrackedTree(cwd) {
  const root = repositoryRoot(cwd);
  const output = git(["ls-files", "-z", "--cached"], root, "buffer");
  const files = output.toString().split("\0").filter(Boolean).sort();
  return new Map(
    files.map((file) => [file, fileFingerprint(resolve(root, file))]),
  );
}

export function changedTrackedFiles(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}

export function assertTrackedTreeUnchanged(before, after, label) {
  const changed = changedTrackedFiles(before, after);
  if (changed.length > 0) {
    throw new Error(`${label} mutated tracked tree:\n${changed.join("\n")}`);
  }
}

export function runTrackedCommand({
  cwd,
  command,
  args = [],
  env = process.env,
  stdio = "inherit",
  label = `${command} ${args.join(" ")}`.trim(),
}) {
  const before = snapshotTrackedTree(cwd);
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio,
    encoding: "utf8",
  });
  const after = snapshotTrackedTree(cwd);
  assertTrackedTreeUnchanged(before, after, label);
  return result;
}

if (process.argv[1] === import.meta.filename) {
  const separator = process.argv.indexOf("--");
  const command = separator === -1 ? undefined : process.argv[separator + 1];
  const args = separator === -1 ? [] : process.argv.slice(separator + 2);
  if (!command) {
    process.stderr.write(
      "Usage: node tracked-tree.mjs -- <command> [args...]\n",
    );
    process.exitCode = 2;
  } else {
    try {
      const result = runTrackedCommand({
        cwd: process.cwd(),
        command,
        args,
      });
      process.exitCode = result.status ?? 1;
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
