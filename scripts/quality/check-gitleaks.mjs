import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const zeroSha = "0".repeat(40);
const approvedGitleaksConfig = "[extend]\nuseDefault = true\n";
const approvedHistoricalFingerprintCount = 85;
const approvedHistoricalFingerprintSha256 =
  "638f4851cdf6ed8b5bd729721ff473000eba1f240ea6985a2a7ce4a0fa32dac8";
const historicalFingerprint =
  /^[0-9a-f]{40}:[^:\n]+:(?:curl-auth-header|curl-auth-user|generic-api-key|stripe-access-token):[1-9][0-9]*$/;

export function validateGitleaksPolicy({
  configPath = resolve(repositoryRoot, ".gitleaks.toml"),
  ignorePath = resolve(repositoryRoot, ".gitleaksignore"),
} = {}) {
  if (readFileSync(configPath, "utf8") !== approvedGitleaksConfig) {
    throw new Error("Gitleaks config differs from fail-closed approved policy");
  }
  const baseline = readFileSync(ignorePath, "utf8");
  const findings = baseline.split(/\r?\n/).filter(Boolean);
  const digest = createHash("sha256").update(baseline).digest("hex");
  if (
    findings.length !== approvedHistoricalFingerprintCount ||
    new Set(findings).size !== findings.length ||
    JSON.stringify(findings) !== JSON.stringify([...findings].sort()) ||
    findings.some((finding) => !historicalFingerprint.test(finding)) ||
    digest !== approvedHistoricalFingerprintSha256
  ) {
    throw new Error(
      `Gitleaks ignore must contain ${approvedHistoricalFingerprintCount} exact audited historical fingerprints`,
    );
  }
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function immutableCommit(candidate, cwd, label) {
  if (!/^[0-9a-f]{40}$/.test(candidate ?? "") || candidate === zeroSha) {
    throw new Error(`${label} is not an immutable non-zero commit SHA`);
  }
  try {
    return git(["rev-parse", "--verify", `${candidate}^{commit}`], cwd);
  } catch {
    throw new Error(`${label} is unavailable; full history fetch required`);
  }
}

function mergeBase(left, right, cwd) {
  try {
    const base = git(["merge-base", left, right], cwd);
    if (!base) throw new Error("empty merge base");
    return base;
  } catch {
    throw new Error(`Secret scan found no merge base for ${left} and ${right}`);
  }
}

function defaultBranchCommit(cwd, event, environment) {
  const branch =
    event?.repository?.default_branch ??
    environment.GITHUB_BASE_REF ??
    "develop";
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new Error(`Unsafe default branch: ${branch}`);
  }
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    try {
      return git(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
    } catch {
      // Try local branch after remote branch.
    }
  }
  throw new Error(
    `Secret scan default branch unavailable; full history fetch required: ${branch}`,
  );
}

function eventFromEnvironment(environment) {
  const eventPath = environment.GITHUB_EVENT_PATH;
  if (!eventPath) return undefined;
  if (!existsSync(eventPath)) {
    throw new Error(`GITHUB_EVENT_PATH is unavailable: ${eventPath}`);
  }
  return JSON.parse(readFileSync(eventPath, "utf8"));
}

function nonEmptyRange(base, head) {
  return base === head ? `${head}^!` : `${base}..${head}`;
}

export function resolveScanPlan(
  cwd = repositoryRoot,
  { event = eventFromEnvironment(process.env), environment = process.env } = {},
) {
  if (git(["rev-parse", "--is-shallow-repository"], cwd) !== "false") {
    throw new Error("Secret scan requires a full-history checkout");
  }
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"], cwd);
  let range;
  let eventKind;

  if (event?.pull_request) {
    const base = immutableCommit(
      event.pull_request.base?.sha,
      cwd,
      "Pull request base",
    );
    range = nonEmptyRange(mergeBase(base, head, cwd), head);
    eventKind = "pull_request";
  } else if (event && Object.hasOwn(event, "before")) {
    const before = event.before;
    const after = event.after;
    const deleted = event.deleted === true || after === zeroSha;
    const created = event.created === true || before === zeroSha;
    if (deleted && created) {
      throw new Error("Push event cannot be both created and deleted");
    }
    if (before === zeroSha && event.created !== true) {
      throw new Error("Zero push base requires created=true");
    }
    if (after === zeroSha && event.deleted !== true) {
      throw new Error("Zero push head requires deleted=true");
    }

    if (deleted) {
      const deletedTip = immutableCommit(before, cwd, "Deleted push tip");
      const base = defaultBranchCommit(cwd, event, environment);
      range = nonEmptyRange(mergeBase(base, deletedTip, cwd), deletedTip);
      eventKind = "delete";
    } else {
      const immutableAfter = immutableCommit(after, cwd, "Push head");
      if (immutableAfter !== head) {
        throw new Error(`Checked-out HEAD does not match push head ${after}`);
      }
      if (created) {
        const base = defaultBranchCommit(cwd, event, environment);
        range = nonEmptyRange(mergeBase(base, head, cwd), head);
        eventKind = "create";
      } else {
        const immutableBefore = immutableCommit(before, cwd, "Push base");
        range = nonEmptyRange(mergeBase(immutableBefore, head, cwd), head);
        eventKind = "push";
      }
    }
  } else {
    const base = defaultBranchCommit(cwd, event, environment);
    range = nonEmptyRange(mergeBase(base, head, cwd), head);
    eventKind = "manual";
  }

  return {
    eventKind,
    head,
    history: "--all --full-history",
    range,
  };
}

export function gitleaksCommands(plan) {
  const hardening = [
    "--ignore-gitleaks-allow",
    "--max-decode-depth=5",
    "--max-archive-depth=1",
  ];
  return [
    [
      "git",
      "--no-banner",
      "--redact",
      ...hardening,
      `--log-opts=${plan.history}`,
      ".",
    ],
    [
      "git",
      "--no-banner",
      "--redact",
      ...hardening,
      `--log-opts=${plan.range}`,
      ".",
    ],
    ["dir", "--no-banner", "--redact", ...hardening, "."],
  ];
}

function gitCandidateFiles(cwd) {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd, encoding: "buffer" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.toString() || "git ls-files failed");
  }
  return result.stdout.toString().split("\0").filter(Boolean).sort();
}

export function createCurrentTreeSnapshot(cwd = repositoryRoot) {
  const root = resolve(cwd);
  const tempRoot = mkdtempSync(join(tmpdir(), "zevium-gitleaks-tree-"));
  const snapshot = join(tempRoot, "candidate");
  mkdirSync(snapshot);
  for (const file of gitCandidateFiles(root)) {
    const source = resolve(root, file);
    if (
      source === root ||
      !source.startsWith(`${root}${sep}`) ||
      !existsSync(source)
    )
      continue;
    const destination = resolve(snapshot, file);
    if (!destination.startsWith(`${snapshot}${sep}`)) {
      throw new Error(`Unsafe candidate path: ${file}`);
    }
    const stat = lstatSync(source);
    mkdirSync(dirname(destination), { recursive: true });
    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), destination);
    } else if (stat.isFile()) {
      copyFileSync(source, destination);
    } else {
      throw new Error(`Unsupported candidate entry: ${relative(root, source)}`);
    }
  }
  return { snapshot, cleanup: () => rmSync(tempRoot, { recursive: true }) };
}

function runGitleaks(args, cwd) {
  const result = spawnSync(
    "mise",
    [
      "exec",
      "--",
      "gitleaks",
      "--config",
      resolve(repositoryRoot, ".gitleaks.toml"),
      "--gitleaks-ignore-path",
      resolve(repositoryRoot, ".gitleaksignore"),
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(
      result.stdout + result.stderr || `gitleaks ${args[0]} failed`,
    );
  }
  process.stdout.write(result.stdout + result.stderr);
}

if (process.argv[1] === import.meta.filename) {
  let candidate;
  try {
    validateGitleaksPolicy();
    const plan = resolveScanPlan();
    const [history, range, current] = gitleaksCommands(plan);
    runGitleaks(history, repositoryRoot);
    runGitleaks(range, repositoryRoot);
    candidate = createCurrentTreeSnapshot(repositoryRoot);
    runGitleaks([...current.slice(0, -1), candidate.snapshot], repositoryRoot);
    process.stdout.write(
      `Gitleaks passed full history, ${plan.eventKind} range ${plan.range}, and current tree\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    candidate?.cleanup();
  }
}
