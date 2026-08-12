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
import { dirname, extname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { runTrackedCommand } from "./tracked-tree.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const headroomPercent = 5;
const artifactMatrix = Object.freeze([
  ["client", ".js"],
  ["client", ".css"],
  ["server", ".js"],
  ["server", ".css"],
]);
const metricNames = [
  "files",
  "totalBytes",
  "totalGzipBytes",
  "fileBytes",
  "fileGzipBytes",
];
const budgetMetricNames = metricNames.filter((metric) => metric !== "files");
const zeroSha = "0".repeat(40);

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function commit(cwd, candidate) {
  if (!/^[0-9a-f]{40}$/.test(candidate ?? "")) {
    throw new Error(`Bundle baseline candidate is not immutable: ${candidate}`);
  }
  return git(["rev-parse", "--verify", `${candidate}^{commit}`], cwd);
}

function mergeBase(cwd, left, right) {
  const result = spawnSync("git", ["merge-base", left, right], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(
      `Bundle policy found no merge base for ${left} and ${right}`,
    );
  }
  return result.stdout.trim();
}

function defaultBranchRef(cwd, event, environment) {
  const branch =
    event?.repository?.default_branch ??
    environment.GITHUB_BASE_REF ??
    "develop";
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new Error(`Unsafe default branch name: ${branch}`);
  }
  const candidates = [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`];
  for (const candidate of candidates) {
    try {
      return git(["rev-parse", "--verify", `${candidate}^{commit}`], cwd);
    } catch {
      // Try local branch after remote branch.
    }
  }
  throw new Error(
    `Default branch is unavailable; fetch full history for origin/${branch}`,
  );
}

function readEvent(environment) {
  const path = environment.GITHUB_EVENT_PATH;
  if (!path) return undefined;
  if (!existsSync(path))
    throw new Error(`GITHUB_EVENT_PATH is missing: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function resolveBundleBaseline(
  cwd = repositoryRoot,
  { event = readEvent(process.env), environment = process.env } = {},
) {
  if (environment.QUALITY_BUNDLE_BASE || environment.BUNDLE_BASE_SHA) {
    throw new Error("PR-controlled bundle baseline overrides are forbidden");
  }
  if (git(["rev-parse", "--is-shallow-repository"], cwd) !== "false") {
    throw new Error("Bundle baseline requires a full-history checkout");
  }
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"], cwd);

  if (event?.pull_request) {
    const base = commit(cwd, event.pull_request.base?.sha);
    return mergeBase(cwd, base, head);
  }

  if (event && Object.hasOwn(event, "before")) {
    const before = event.before;
    const after = event.after;
    const deleted = event.deleted === true || after === zeroSha;
    const created = event.created === true || before === zeroSha;
    if (deleted && created) {
      throw new Error("Bundle push event cannot be both created and deleted");
    }
    if (before === zeroSha && event.created !== true) {
      throw new Error("Zero bundle push base requires created=true");
    }
    if (after === zeroSha && event.deleted !== true) {
      throw new Error("Zero bundle push head requires deleted=true");
    }
    if (deleted) commit(cwd, before);
    else if (commit(cwd, after) !== head) {
      throw new Error(
        `Checked-out HEAD does not match bundle push head ${after}`,
      );
    }
    if (deleted || created) {
      const base = defaultBranchRef(cwd, event, environment);
      return mergeBase(cwd, base, head);
    }
    const immutableBefore = commit(cwd, before);
    return mergeBase(cwd, immutableBefore, head) === immutableBefore
      ? immutableBefore
      : mergeBase(cwd, defaultBranchRef(cwd, event, environment), head);
  }

  return mergeBase(cwd, defaultBranchRef(cwd, event, environment), head);
}

function collectFiles(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Bundle artifact directory is missing: ${root}`);
  }
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Bundle contains non-regular artifact: ${path}`);
    }
  }
  visit(root);
  return files.sort();
}

export function measureBundle(bundleRoot) {
  const measurements = new Map();
  for (const [target, extension] of artifactMatrix) {
    const files = collectFiles(resolve(bundleRoot, target)).filter(
      (path) => extname(path) === extension,
    );
    if (files.length === 0) {
      throw new Error(`${target} ${extension} has no measured artifacts`);
    }
    const sizes = files.map((path) => {
      const source = readFileSync(path);
      if (source.length === 0) {
        throw new Error(
          `${target} ${extension} contains zero-byte artifact ${relative(bundleRoot, path)}`,
        );
      }
      return {
        bytes: source.length,
        gzipBytes: gzipSync(source, { level: 9 }).length,
      };
    });
    measurements.set(`${target}:${extension}`, {
      target,
      extension,
      files: sizes.length,
      totalBytes: sizes.reduce((sum, file) => sum + file.bytes, 0),
      totalGzipBytes: sizes.reduce((sum, file) => sum + file.gzipBytes, 0),
      fileBytes: Math.max(...sizes.map((file) => file.bytes)),
      fileGzipBytes: Math.max(...sizes.map((file) => file.gzipBytes)),
    });
  }
  return measurements;
}

export function compareBundleMeasurements(baseline, candidate) {
  const failures = [];
  for (const [target, extension] of artifactMatrix) {
    const key = `${target}:${extension}`;
    const before = baseline.get(key);
    const after = candidate.get(key);
    if (!before || !after) {
      failures.push(`${key} measurement is missing`);
      continue;
    }
    for (const metric of metricNames) {
      if (!Number.isInteger(before[metric]) || before[metric] <= 0) {
        failures.push(`${key} baseline ${metric} is missing or zero`);
        continue;
      }
      if (!Number.isInteger(after[metric]) || after[metric] <= 0) {
        failures.push(`${key} candidate ${metric} is missing or zero`);
        continue;
      }
    }
    for (const metric of budgetMetricNames) {
      if (
        !Number.isInteger(before[metric]) ||
        before[metric] <= 0 ||
        !Number.isInteger(after[metric]) ||
        after[metric] <= 0
      )
        continue;
      const maximum = Math.ceil(before[metric] * (1 + headroomPercent / 100));
      if (after[metric] > maximum) {
        failures.push(
          `${key} ${metric}=${after[metric]} exceeds measured baseline ${before[metric]} + ${headroomPercent}% (${maximum})`,
        );
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`Bundle budget failures:\n${failures.join("\n")}`);
  }
}

function readPositiveJson(path, label) {
  if (
    !existsSync(path) ||
    !lstatSync(path).isFile() ||
    statSync(path).size <= 0
  ) {
    throw new Error(`${label} is missing or zero bytes: ${path}`);
  }
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Object.keys(value).length === 0) {
    throw new Error(`${label} is empty: ${path}`);
  }
  return value;
}

function routeSources(repository) {
  const root = resolve(repository, "apps/web/src/routes");
  return collectFiles(root)
    .filter((path) => [".ts", ".tsx"].includes(extname(path)))
    .map((path) => `src/routes/${relative(root, path).split("\\").join("/")}`)
    .sort();
}

function manifestEntry(manifest, route) {
  return Object.entries(manifest).find(([key]) => key.split("?")[0] === route);
}

function manifestArtifact(outputRoot, file, label) {
  if (typeof file !== "string" || file.length === 0 || file.includes("\0")) {
    throw new Error(`${label} contains invalid artifact path`);
  }
  const normalized = file.replace(/^\/+/, "");
  const artifact = resolve(outputRoot, normalized);
  const outside = relative(outputRoot, artifact);
  if (outside.startsWith("..") || resolve(outputRoot, outside) !== artifact) {
    throw new Error(`${label} artifact escapes output root: ${file}`);
  }
  if (
    !existsSync(artifact) ||
    !lstatSync(artifact).isFile() ||
    statSync(artifact).size <= 0
  ) {
    throw new Error(`${label} points to missing/zero ${file}`);
  }
}

function requireManifestRoutes({ manifest, routes, outputRoot, label }) {
  for (const route of routes) {
    const match = manifestEntry(manifest, route);
    if (!match) throw new Error(`${label} omits route ${route}`);
    const file = match[1]?.file;
    if (typeof file !== "string") {
      throw new Error(`${label} route ${route} has no emitted file`);
    }
    manifestArtifact(outputRoot, file, `${label} route ${route}`);
  }
}

function requireSsrManifestRoutes({ manifest, routes, outputRoot, label }) {
  for (const route of routes) {
    const match = manifestEntry(manifest, route);
    if (!match || !Array.isArray(match[1]) || match[1].length === 0) {
      throw new Error(`${label} omits route ${route}`);
    }
    for (const file of match[1])
      manifestArtifact(outputRoot, file, `${label} route ${route}`);
  }
}

export function validateBundleContract({ bundleRoot, repository }) {
  const clientRoot = resolve(bundleRoot, "client");
  const serverRoot = resolve(bundleRoot, "server");
  const clientManifest = readPositiveJson(
    resolve(clientRoot, ".vite/manifest.json"),
    "Client build manifest",
  );
  const ssrManifest = readPositiveJson(
    resolve(clientRoot, ".vite/ssr-manifest.json"),
    "Client SSR manifest",
  );
  const serverManifest = readPositiveJson(
    resolve(serverRoot, ".vite/manifest.json"),
    "SSR build manifest",
  );
  const serverSsrManifest = readPositiveJson(
    resolve(serverRoot, ".vite/ssr-manifest.json"),
    "SSR module manifest",
  );
  const routes = routeSources(repository);
  if (routes.length === 0) throw new Error("Route source inventory is empty");
  requireManifestRoutes({
    manifest: clientManifest,
    routes: routes.filter((route) => route !== "src/routes/__root.tsx"),
    outputRoot: clientRoot,
    label: "Client build manifest",
  });
  requireManifestRoutes({
    manifest: serverManifest,
    routes,
    outputRoot: serverRoot,
    label: "SSR build manifest",
  });
  requireSsrManifestRoutes({
    manifest: ssrManifest,
    routes,
    outputRoot: clientRoot,
    label: "Client SSR manifest",
  });
  requireSsrManifestRoutes({
    manifest: serverSsrManifest,
    routes,
    outputRoot: serverRoot,
    label: "SSR module manifest",
  });

  for (const required of ["index.js", "wrangler.json"]) {
    const path = resolve(serverRoot, required);
    if (
      !existsSync(path) ||
      !lstatSync(path).isFile() ||
      statSync(path).size <= 0
    ) {
      throw new Error(`Required SSR artifact is missing or zero: ${required}`);
    }
  }
  const wrangler = readPositiveJson(
    resolve(serverRoot, "wrangler.json"),
    "SSR Wrangler manifest",
  );
  if (
    wrangler.main !== "index.js" ||
    wrangler.assets?.directory !== "../client"
  ) {
    throw new Error(
      "SSR Wrangler manifest does not bind server and client outputs",
    );
  }
  return routes.length;
}

function addWorktree(repository, path, revision) {
  const result = spawnSync(
    "git",
    ["worktree", "add", "--detach", path, revision],
    { cwd: repository, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || `Failed to add worktree for ${revision}`);
  }
}

function removeWorktree(repository, path) {
  spawnSync("git", ["worktree", "remove", "--force", path], {
    cwd: repository,
    encoding: "utf8",
  });
}

export function overlayCandidateSnapshot(repository, worktree) {
  const output = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repository, encoding: "buffer" },
  );
  if (output.status !== 0) {
    throw new Error(
      output.stderr?.toString() || "Failed to enumerate candidate snapshot",
    );
  }
  const files = output.stdout.toString().split("\0").filter(Boolean).sort();
  for (const file of files) {
    const source = resolve(repository, file);
    const target = resolve(worktree, file);
    if (existsSync(source)) {
      mkdirSync(dirname(target), { recursive: true });
      if (lstatSync(source).isSymbolicLink()) {
        rmSync(target, { recursive: true, force: true });
        symlinkSync(readlinkSync(source), target);
      } else {
        cpSync(source, target, { preserveTimestamps: true });
      }
    } else {
      rmSync(target, { recursive: true, force: true });
    }
  }
  git(["add", "--all"], worktree);
  return git(["write-tree"], worktree);
}

function buildWorktree(path, revision) {
  for (const [command, args, label] of [
    ["pnpm", ["install", "--frozen-lockfile"], "frozen dependency install"],
    ["pnpm", ["--filter", "web", "build"], "production web build"],
  ]) {
    const result = runTrackedCommand({
      cwd: path,
      command,
      args,
      label: `${label} at ${revision}`,
      env: {
        ...process.env,
        CI: "true",
        CLERK_PUBLISHABLE_KEY: [
          "pk",
          "test",
          "ZmFrZS5jbGVyay5hY2NvdW50JA",
        ].join("_"),
        CLERK_SECRET_KEY: ["sk", "test", "ZmFrZS5jbGVyay5hY2NvdW50JA"].join(
          "_",
        ),
        VITE_CONVEX_URL: "https://ci.invalid",
        VITE_GATEWAY_URL: "https://ci.invalid",
      },
    });
    if (result.status !== 0) {
      throw new Error(`${label} failed at ${revision}`);
    }
  }
  return resolve(path, "apps/web/dist");
}

export function runBundleGate(repository = repositoryRoot) {
  const baselineRevision = resolveBundleBaseline(repository);
  const candidateCommit = git(
    ["rev-parse", "--verify", "HEAD^{commit}"],
    repository,
  );
  const tempRoot = mkdtempSync(join(tmpdir(), "zevium-bundles-"));
  const baselineTree = join(tempRoot, "baseline");
  const candidateTree = join(tempRoot, "candidate");
  try {
    addWorktree(repository, baselineTree, baselineRevision);
    addWorktree(repository, candidateTree, candidateCommit);
    const candidateRevision = `tree:${overlayCandidateSnapshot(repository, candidateTree)}`;
    const baseline = measureBundle(
      buildWorktree(baselineTree, baselineRevision),
    );
    const candidateRoot = buildWorktree(candidateTree, candidateRevision);
    const candidate = measureBundle(candidateRoot);
    const routes = validateBundleContract({
      bundleRoot: candidateRoot,
      repository: candidateTree,
    });
    compareBundleMeasurements(baseline, candidate);
    return { baselineRevision, candidateRevision, baseline, candidate, routes };
  } finally {
    removeWorktree(repository, candidateTree);
    removeWorktree(repository, baselineTree);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] === import.meta.filename) {
  try {
    if (process.argv.length !== 2) {
      throw new Error(
        "Bundle gate accepts no PR-controlled config or baseline flags",
      );
    }
    const result = runBundleGate();
    process.stdout.write(
      `Bundle baseline ${result.baselineRevision} -> ${result.candidateRevision}; routes=${result.routes}; fixed headroom=${headroomPercent}%\n`,
    );
    for (const [key, measurement] of result.candidate) {
      process.stdout.write(
        `${key}: files=${measurement.files} bytes=${measurement.totalBytes} gzip=${measurement.totalGzipBytes}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
