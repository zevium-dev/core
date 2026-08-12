import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const generatedOutputDirectories = new Set([
  ".nitro",
  ".output",
  ".tanstack",
  ".turbo",
  ".wrangler",
  "dist",
  "node_modules",
]);

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function listFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(relative(root, path));
    }
  }
  if (existsSync(root)) visit(root);
  return files.sort();
}

function snapshotTargets(root, targets) {
  const snapshot = new Map();
  for (const target of targets) {
    const path = resolve(root, target);
    if (!existsSync(path)) continue;
    if (statSync(path).isFile()) snapshot.set(target, readFileSync(path));
    else
      for (const file of listFiles(path))
        snapshot.set(join(target, file), readFileSync(join(path, file)));
  }
  return snapshot;
}

function snapshotFiles(root, files) {
  return new Map(
    files
      .filter((file) => pathExists(resolve(root, file)))
      .map((file) => {
        const path = resolve(root, file);
        return [
          file,
          lstatSync(path).isSymbolicLink()
            ? Buffer.from(readlinkSync(path))
            : readFileSync(path),
        ];
      }),
  );
}

function snapshotSourceTree(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (generatedOutputDirectories.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(relative(root, path));
    }
  }
  visit(root);
  return snapshotFiles(root, files);
}

function copyRepository(source, destination) {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: source, encoding: "buffer" },
  );
  if (result.status !== 0) {
    cpSync(source, destination, { recursive: true });
    return listFiles(source);
  }
  const copiedFiles = result.stdout.toString().split("\0").filter(Boolean);
  for (const raw of copiedFiles) {
    const from = resolve(source, raw);
    if (!pathExists(from)) continue;
    mkdirSync(dirname(resolve(destination, raw)), { recursive: true });
    cpSync(from, resolve(destination, raw), { recursive: true });
  }
  for (const packagePath of [
    "node_modules",
    "apps/web/node_modules",
    "apps/gateway/node_modules",
    "packages/shared/node_modules",
  ]) {
    const sourcePath = resolve(source, packagePath);
    if (existsSync(sourcePath)) {
      mkdirSync(dirname(resolve(destination, packagePath)), {
        recursive: true,
      });
      symlinkSync(sourcePath, resolve(destination, packagePath), "dir");
    }
  }
  return copiedFiles;
}

export function assertGeneratedTargetsFresh({
  cwd,
  targets,
  command,
  args,
  commandDirectory = ".",
  env = process.env,
  stdio = "pipe",
}) {
  const tempRoot = mkdtempSync(join(tmpdir(), "zevium-generated-"));
  const isolated = join(tempRoot, "repository");
  try {
    copyRepository(cwd, isolated);
    const before = new Map([
      ...snapshotSourceTree(isolated),
      ...snapshotTargets(isolated, targets),
    ]);
    const result = spawnSync(command, args, {
      cwd: resolve(isolated, commandDirectory),
      encoding: "utf8",
      env,
      stdio,
    });
    if (result.status !== 0)
      throw new Error(
        result.stderr || result.stdout || "Generator command failed",
      );
    const after = new Map([
      ...snapshotSourceTree(isolated),
      ...snapshotTargets(isolated, targets),
    ]);
    const paths = new Set([...before.keys(), ...after.keys()]);
    const changed = [...paths].filter(
      (path) =>
        !before.get(path)?.equals(after.get(path) ?? Buffer.alloc(0)) ||
        !after.has(path),
    );
    if (changed.length)
      throw new Error(
        `Generated targets were stale:\n${changed.sort().join("\n")}`,
      );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function assertGeneratedFileFresh({ cwd, file, ...options }) {
  return assertGeneratedTargetsFresh({ cwd, targets: [file], ...options });
}

if (process.argv[1] === import.meta.filename) {
  try {
    assertGeneratedTargetsFresh({
      cwd: repositoryRoot,
      targets: ["apps/web/src/routeTree.gen.ts", "convex/_generated"],
      command: resolve(repositoryRoot, "node_modules/.bin/vite"),
      args: ["build"],
      commandDirectory: "apps/web",
      env: {
        ...process.env,
        CLERK_PUBLISHABLE_KEY: "pk_test_ZmFrZS5jbGVyay5hY2NvdW50JA",
        CLERK_SECRET_KEY: "sk_test_ZmFrZS5jbGVyay5hY2NvdW50JA",
        VITE_CONVEX_URL: "https://ci.invalid",
        VITE_GATEWAY_URL: "https://ci.invalid",
      },
      stdio: "inherit",
    });
    process.stdout.write(
      "Generated targets are fresh; source tree untouched\n",
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
