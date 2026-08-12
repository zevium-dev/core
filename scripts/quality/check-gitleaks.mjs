import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const zeroSha = "0".repeat(40);
const approvedGitleaksConfig = `[extend]
useDefault = true

# Historical false positives use exact finding fingerprints in .gitleaksignore.
# Never suppress an entire commit or source path.

[[allowlists]]
description = "Generated production bundles are untracked derivatives of scanned source."
paths = ['''^apps/web/dist/''']

[[allowlists]]
description = "Exact public documentation and deterministic test placeholders, never credentials."
regexTarget = "match"
regexes = [
  '''ak_your_api_key''',
  '''sk_live_abcdefghijklmnop''',
  '''whsec_dGVzdC13ZWJob29rLXNlY3JldA==''',
  '''pk_test_ZmFrZS5jbGVyay5hY2NvdW50JA''',
  '''sk_test_ZmFrZS5jbGVyay5hY2NvdW50JA''',
  '''\\$STRIPE_SECRET_KEY''',
]
`;
const approvedHistoricalFindings = new Set([
  "6624eb6da0647d83547732b3930b036c43cafb88:packages/shared/src/registry-sync.test.ts:generic-api-key:23",
  "6624eb6da0647d83547732b3930b036c43cafb88:convex/registrySync.test.ts:generic-api-key:30",
  "f638df59039a5c208402d1e6e87fa219c2e854b1:docs/production-deploy.md:generic-api-key:309",
  "0893c6e4869c4e53c8b848301e064ba91caa4299:convex/auth.config.ts:generic-api-key:4",
  "0a031dc6117255327afd6060fc11a5ceea2cb278:.env.example:generic-api-key:20",
  "712ee030f775618d192314ee88cce528afa3a800:src/routes/settings/keys/$.tsx:curl-auth-header:178",
  "d0b3736ed96f60503bb05a9de5bfb92f5afa0ca5:src/routes/settings/keys/$.lazy.tsx:generic-api-key:50",
  "d0b3736ed96f60503bb05a9de5bfb92f5afa0ca5:src/routes/settings/keys/$.lazy.tsx:generic-api-key:59",
  "d0b3736ed96f60503bb05a9de5bfb92f5afa0ca5:src/routes/settings/keys/$.lazy.tsx:generic-api-key:68",
  "d0b3736ed96f60503bb05a9de5bfb92f5afa0ca5:src/routes/settings/keys/$.lazy.tsx:generic-api-key:77",
  "d0b3736ed96f60503bb05a9de5bfb92f5afa0ca5:src/routes/settings/keys/$.lazy.tsx:generic-api-key:86",
  "d0b3736ed96f60503bb05a9de5bfb92f5afa0ca5:src/routes/settings/keys/$.lazy.tsx:curl-auth-header:166",
]);

export function validateGitleaksPolicy({
  configPath = resolve(repositoryRoot, ".gitleaks.toml"),
  ignorePath = resolve(repositoryRoot, ".gitleaksignore"),
} = {}) {
  if (readFileSync(configPath, "utf8") !== approvedGitleaksConfig) {
    throw new Error("Gitleaks config differs from fail-closed approved policy");
  }
  const findings = readFileSync(ignorePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  const actual = new Set(findings);
  if (
    actual.size !== findings.length ||
    actual.size !== approvedHistoricalFindings.size ||
    [...actual].some((finding) => !approvedHistoricalFindings.has(finding))
  ) {
    throw new Error(
      "Gitleaks ignore must contain only exact audited historical fingerprints",
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
  return [
    ["git", "--no-banner", "--redact", `--log-opts=${plan.history}`, "."],
    ["git", "--no-banner", "--redact", `--log-opts=${plan.range}`, "."],
    ["dir", "--no-banner", "--redact", "."],
  ];
}

function runGitleaks(args, cwd) {
  const result = spawnSync("mise", ["exec", "--", "gitleaks", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      result.stdout + result.stderr || `gitleaks ${args[0]} failed`,
    );
  }
  process.stdout.write(result.stdout + result.stderr);
}

if (process.argv[1] === import.meta.filename) {
  try {
    validateGitleaksPolicy();
    const plan = resolveScanPlan();
    for (const command of gitleaksCommands(plan))
      runGitleaks(command, repositoryRoot);
    process.stdout.write(
      `Gitleaks passed full history, ${plan.eventKind} range ${plan.range}, and current tree\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
