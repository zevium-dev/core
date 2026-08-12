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
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  assertTrackedTreeUnchanged,
  runTrackedCommand,
  snapshotTrackedTree,
} from "./tracked-tree.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const expectedConvexOutputs = [
  "convex/_generated/api.d.ts",
  "convex/_generated/api.js",
  "convex/_generated/dataModel.d.ts",
  "convex/_generated/server.d.ts",
  "convex/_generated/server.js",
];
const expectedRouteOutputs = ["apps/web/src/routeTree.gen.ts"];

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
    if (!pathExists(path)) continue;
    const files = lstatSync(path).isDirectory()
      ? listFiles(path).map((file) => join(target, file))
      : [target];
    for (const file of files) {
      const filePath = resolve(root, file);
      snapshot.set(
        file,
        lstatSync(filePath).isSymbolicLink()
          ? Buffer.from(`symlink:${readlinkSync(filePath)}`)
          : readFileSync(filePath),
      );
    }
  }
  return snapshot;
}

function changedSnapshots(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((path) => {
      const left = before.get(path);
      const right = after.get(path);
      return !left || !right || !left.equals(right);
    })
    .sort();
}

function generatedContents(snapshot, paths) {
  return paths
    .map((path) => {
      const contents = snapshot.get(path);
      if (!contents || contents.includes(0)) return undefined;
      return `--- generated ${path}\n${contents.toString("utf8")}`;
    })
    .filter(Boolean)
    .join("\n");
}

function assertExactGeneratedFiles(root, directory, expected) {
  const actual = listFiles(resolve(root, directory))
    .map((file) => join(directory, file))
    .sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(
      `Generated output inventory is not exact for ${directory}:\nexpected=${wanted.join(",")}\nactual=${actual.join(",")}`,
    );
  }
}

function runGenerator({ root, targets, command, args, commandDirectory, env }) {
  const beforeTracked = snapshotTrackedTree(root);
  const beforeTargets = snapshotTargets(root, targets);
  const result = spawnSync(command, args, {
    cwd: resolve(root, commandDirectory),
    env,
    encoding: "utf8",
    stdio: "inherit",
  });
  const afterTargets = snapshotTargets(root, targets);
  const afterTracked = snapshotTrackedTree(root);
  const changedTargets = changedSnapshots(beforeTargets, afterTargets);
  if (changedTargets.length > 0) {
    throw new Error(
      `Generated targets were stale after ${command} ${args.join(" ")}:\n${changedTargets.join("\n")}\n${generatedContents(afterTargets, changedTargets)}`,
    );
  }
  assertTrackedTreeUnchanged(
    beforeTracked,
    afterTracked,
    `generator ${command} ${args.join(" ")}`,
  );
  if (result.status !== 0) {
    throw new Error(`Generator command failed: ${command} ${args.join(" ")}`);
  }
}

export function sanitizedConvexEnvironment(source = process.env) {
  const environment = Object.fromEntries(
    Object.entries(source).filter(([name]) => !name.startsWith("CONVEX_")),
  );
  return {
    ...environment,
    CI: "true",
    CLERK_JWT_ISSUER_DOMAIN: "https://clerk.invalid",
    CONVEX_AGENT_MODE: "anonymous",
  };
}

export function assertAnonymousLocalConvex(root) {
  const environmentPath = resolve(root, ".env.local");
  if (!existsSync(environmentPath)) {
    throw new Error("Convex init did not create isolated .env.local");
  }
  const environment = readFileSync(environmentPath, "utf8");
  const required = [
    /^CONVEX_DEPLOYMENT=anonymous:[^\s]+$/m,
    /^CONVEX_URL=http:\/\/127\.0\.0\.1:\d+$/m,
    /^CONVEX_SITE_URL=http:\/\/127\.0\.0\.1:\d+$/m,
  ];
  if (required.some((pattern) => !pattern.test(environment))) {
    throw new Error(
      "Convex init was not pinned to anonymous local deployment URLs",
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

function copyRepositorySnapshot(destination) {
  const output = git(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    repositoryRoot,
    "buffer",
  );
  const files = output.toString().split("\0").filter(Boolean).sort();
  for (const file of files) {
    const source = resolve(repositoryRoot, file);
    if (!pathExists(source)) continue;
    const target = resolve(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, preserveTimestamps: true });
  }
}

function initializeSnapshotRepository(path) {
  git(["init", "--quiet", "--initial-branch=generated-check"], path);
  git(["config", "user.name", "Zevium generated check"], path);
  git(["config", "user.email", "generated-check@invalid"], path);
  git(["add", "--all"], path);
  git(
    [
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "generated-check snapshot",
    ],
    path,
  );
}

export function assertRepositoryGeneratedFresh() {
  const tempRoot = mkdtempSync(join(tmpdir(), "zevium-generated-"));
  const isolated = join(tempRoot, "repository");
  try {
    mkdirSync(isolated, { recursive: true });
    copyRepositorySnapshot(isolated);
    initializeSnapshotRepository(isolated);
    const install = runTrackedCommand({
      cwd: isolated,
      command: "pnpm",
      args: ["install", "--frozen-lockfile"],
      env: { ...process.env, CI: "true" },
      label: "generated-check frozen dependency install",
    });
    if (install.status !== 0) {
      throw new Error("Generated-check dependency install failed");
    }

    assertExactGeneratedFiles(
      isolated,
      "convex/_generated",
      expectedConvexOutputs,
    );

    runGenerator({
      root: isolated,
      targets: ["convex/_generated"],
      command: "pnpm",
      args: ["exec", "convex", "init"],
      commandDirectory: ".",
      env: sanitizedConvexEnvironment(),
    });
    assertAnonymousLocalConvex(isolated);

    runGenerator({
      root: isolated,
      targets: ["convex/_generated"],
      command: "pnpm",
      args: [
        "exec",
        "convex",
        "env",
        "set",
        "CLERK_JWT_ISSUER_DOMAIN",
        "https://clerk.invalid",
      ],
      commandDirectory: ".",
      env: sanitizedConvexEnvironment(),
    });

    runGenerator({
      root: isolated,
      targets: ["convex/_generated"],
      command: "pnpm",
      args: ["exec", "convex", "codegen", "--typecheck", "disable"],
      commandDirectory: ".",
      env: sanitizedConvexEnvironment(),
    });
    assertExactGeneratedFiles(
      isolated,
      "convex/_generated",
      expectedConvexOutputs,
    );
    runGenerator({
      root: isolated,
      targets: expectedRouteOutputs,
      command: "pnpm",
      args: ["exec", "vite", "build"],
      commandDirectory: "apps/web",
      env: {
        ...process.env,
        CI: "true",
        CLERK_PUBLISHABLE_KEY: "pk_test_ZmFrZS5jbGVyay5hY2NvdW50JA",
        CLERK_SECRET_KEY: "sk_test_ZmFrZS5jbGVyay5hY2NvdW50JA",
        VITE_CONVEX_URL: "https://ci.invalid",
        VITE_GATEWAY_URL: "https://ci.invalid",
      },
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function assertGeneratedTargetsFresh({
  cwd,
  targets,
  command,
  args,
  commandDirectory = ".",
  env = process.env,
}) {
  const tempRoot = mkdtempSync(join(tmpdir(), "zevium-generator-fixture-"));
  const isolated = join(tempRoot, "repository");
  try {
    cpSync(cwd, isolated, { recursive: true });
    const beforeTree = snapshotTargets(isolated, ["."]);
    const beforeTargets = snapshotTargets(isolated, targets);
    const result = spawnSync(command, args, {
      cwd: resolve(isolated, commandDirectory),
      env,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        result.stderr || result.stdout || "Generator command failed",
      );
    }
    const changedTargets = changedSnapshots(
      beforeTargets,
      snapshotTargets(isolated, targets),
    );
    const changedTree = changedSnapshots(
      beforeTree,
      snapshotTargets(isolated, ["."]),
    );
    if (changedTargets.length || changedTree.length) {
      throw new Error(
        `Generated targets were stale:\n${[
          ...new Set([...changedTargets, ...changedTree]),
        ]
          .sort()
          .join("\n")}`,
      );
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] === import.meta.filename) {
  try {
    assertRepositoryGeneratedFresh();
    process.stdout.write(
      `Generated outputs fresh: ${expectedConvexOutputs.length} Convex files and ${expectedRouteOutputs.length} route tree; every generator left tracked tree unchanged\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
