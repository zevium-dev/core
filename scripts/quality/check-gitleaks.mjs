import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function eventBase() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) return undefined;
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  return event.pull_request?.base?.sha ?? event.before;
}

export function resolveScanRange(cwd = repositoryRoot, candidateOverride) {
  const explicit = process.env.QUALITY_BASE_SHA;
  const event = eventBase();
  const branch = process.env.GITHUB_BASE_REF;
  if (branch && !/^[A-Za-z0-9._/-]+$/.test(branch))
    throw new Error(`Unsafe GITHUB_BASE_REF: ${branch}`);
  const candidate =
    candidateOverride ??
    explicit ??
    event ??
    (branch ? `refs/remotes/origin/${branch}` : "refs/remotes/origin/develop");
  let base;
  try {
    base = git(["rev-parse", "--verify", `${candidate}^{commit}`], cwd);
  } catch {
    throw new Error(
      `Secret scan base is unavailable; full history fetch required: ${candidate}`,
    );
  }
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"], cwd);
  const mergeBase = git(["merge-base", base, head], cwd);
  if (!mergeBase)
    throw new Error(`Secret scan found no merge base for ${base} and ${head}`);
  return `${mergeBase}..${head}`;
}

function runGitleaks(args, cwd) {
  const result = spawnSync("mise", ["exec", "--", "gitleaks", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0)
    throw new Error(
      result.stdout + result.stderr || `gitleaks ${args[0]} failed`,
    );
  process.stdout.write(result.stdout + result.stderr);
}

if (process.argv[1] === import.meta.filename) {
  try {
    const range = resolveScanRange();
    runGitleaks(
      ["git", "--no-banner", "--redact", `--log-opts=${range}`, "."],
      repositoryRoot,
    );
    runGitleaks(["dir", "--no-banner", "--redact", "."], repositoryRoot);
    process.stdout.write(
      `Gitleaks passed commit range ${range} and current tree\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
