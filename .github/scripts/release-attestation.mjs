import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  classifyLifecycleChange,
  lifecycleDigest,
  parseJsonc,
} from "./release-lifecycle.mjs";
import { classifyConvexContract } from "./release-convex-contract.mjs";

const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const ATTESTATION_TYPE =
  "https://zevium.dev/attestations/production-release/v1";
const DEFINITIONS = {
  policy: {
    workflowPath: ".github/workflows/release-policy.yml",
    environment: "production-policy",
  },
  lifecycle: {
    workflowPath: ".github/workflows/gateway-do-lifecycle.yml",
    environment: "production-lifecycle",
  },
  contract: {
    workflowPath: ".github/workflows/contract-production.yml",
    environment: "production-contract",
  },
};
const LIFECYCLE_RECOVERY_DEFINITION = {
  workflowPath: ".github/workflows/recover-production.yml",
  environment: "production-recovery",
};
const POLICY_PATHS = [
  ".github/release-policy.json",
  ".github/scripts/",
  ".github/workflows/",
  "e2e/",
  "package.json",
  "pnpm-lock.yaml",
];
const EVALUATOR_PATH = ".github/scripts/release-attestation.mjs";
const POLICY_CHECK = "Immutable Release Policy Review / evaluate";

function definitionForAttestation(attestation) {
  if (
    attestation?.kind === "lifecycle" &&
    attestation.sourceRunId !== undefined
  ) {
    return LIFECYCLE_RECOVERY_DEFINITION;
  }
  return DEFINITIONS[attestation?.kind];
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.quiet ? "ignore" : "pipe"],
  }).trim();
}

function validateSha(value, name) {
  if (!SHA_RE.test(value ?? ""))
    throw new Error(`${name} must be full lowercase SHA`);
  return value;
}

function gitObject(sha, path) {
  try {
    return git(["rev-parse", `${sha}:${path}`], { quiet: true });
  } catch {
    return null;
  }
}

function isPolicyPath(path) {
  return POLICY_PATHS.some((entry) =>
    entry.endsWith("/") ? path.startsWith(entry) : path === entry,
  );
}

function changedPaths(base, target, pathspec = []) {
  return git([
    "diff",
    "--name-only",
    "--diff-filter=ACDMRTUXB",
    base,
    target,
    ...(pathspec.length === 0 ? [] : ["--", ...pathspec]),
  ])
    .split("\n")
    .filter(Boolean)
    .sort();
}

function assertLinearRange(base, target) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", base, target], {
      stdio: "ignore",
    });
  } catch {
    throw new Error("Protected release base is not an ancestor of target");
  }
  let expectedParent = base;
  for (const row of git([
    "rev-list",
    "--reverse",
    "--parents",
    `${base}..${target}`,
  ])
    .split("\n")
    .filter(Boolean)) {
    const [commit, ...parents] = row.split(" ");
    if (parents.length !== 1 || parents[0] !== expectedParent) {
      throw new Error(
        "Protected release range must have linear single-parent history",
      );
    }
    expectedParent = commit;
  }
}

export function policyTreeDigest(sha) {
  validateSha(sha, "policy tree SHA");
  const paths = git(["ls-tree", "-r", "--name-only", sha])
    .split("\n")
    .filter((path) => path && isPolicyPath(path))
    .sort();
  if (!paths.includes(EVALUATOR_PATH)) {
    throw new Error("Trusted release evaluator is missing");
  }
  return sha256(
    JSON.stringify(
      paths.map((path) => ({ path, object: gitObject(sha, path) })),
    ),
  );
}

export function policyChangeDigest(base, target) {
  validateSha(base, "policy base");
  validateSha(target, "policy target");
  assertLinearRange(base, target);
  const paths = changedPaths(base, target).filter(isPolicyPath);
  if (paths.length === 0) {
    throw new Error("Policy digest requires referee or workflow changes");
  }
  return sha256(
    JSON.stringify(
      paths.map((path) => ({
        path,
        before: gitObject(base, path),
        after: gitObject(target, path),
      })),
    ),
  );
}

export function verifyImmutableReferee({
  refereeRef,
  target,
  evaluatorDigest,
  treeDigest,
  repository,
  targetBranch,
}) {
  validateSha(refereeRef, "immutable referee ref");
  validateSha(target, "release target");
  if (!DIGEST_RE.test(evaluatorDigest ?? "")) {
    throw new Error("immutable evaluator digest is invalid");
  }
  if (!DIGEST_RE.test(treeDigest ?? "")) {
    throw new Error("immutable policy tree digest is invalid");
  }
  if (repository !== "zevium-dev/core" || targetBranch !== "develop") {
    throw new Error("release repository or protected target branch is invalid");
  }
  assertLinearRange(refereeRef, target);
  const source = git(["show", `${refereeRef}:${EVALUATOR_PATH}`]);
  if (sha256(source) !== evaluatorDigest) {
    throw new Error("immutable evaluator digest mismatch");
  }
  const runtimeSource = readFileSync(
    fileURLToPath(import.meta.url),
    "utf8",
  ).trim();
  if (sha256(runtimeSource) !== evaluatorDigest || runtimeSource !== source) {
    throw new Error("runtime evaluator is not immutable referee blob");
  }
  if (policyTreeDigest(refereeRef) !== treeDigest) {
    throw new Error("immutable policy tree digest mismatch");
  }
  const policy = JSON.parse(
    git(["show", `${refereeRef}:.github/release-policy.json`]),
  );
  if (
    policy?.schemaVersion !== 1 ||
    policy.repository !== repository ||
    policy.targetBranch !== targetBranch ||
    policy.evaluator !== EVALUATOR_PATH ||
    policy.requiredWorkflow !== DEFINITIONS.policy.workflowPath ||
    policy.requiredCheck !== POLICY_CHECK ||
    policy.requiredEnvironment !== DEFINITIONS.policy.environment ||
    policy.refereeRefVariable !== "RELEASE_REFEREE_REF" ||
    policy.evaluatorDigestVariable !== "RELEASE_REFEREE_SHA256" ||
    policy.policyTreeDigestVariable !== "RELEASE_POLICY_TREE_SHA256" ||
    policy.preventSelfReview !== true ||
    policy.adminBypass !== false ||
    policy.mergeTopology !== "linear-single-parent" ||
    !equal(policy.refereePaths, POLICY_PATHS)
  ) {
    throw new Error("immutable release policy content is invalid");
  }
  return canonical({
    evaluatorDigest,
    refereeRef,
    repository,
    target,
    targetBranch,
    treeDigest,
  });
}

export function contractDigest(base, target) {
  validateSha(base, "contract base");
  validateSha(target, "contract target");
  assertLinearRange(base, target);
  const paths = changedPaths(base, target, ["convex"]);
  if (paths.length === 0)
    throw new Error("Contract digest requires convex changes");
  return sha256(
    JSON.stringify(
      paths.map((path) => ({
        path,
        before: gitObject(base, path),
        after: gitObject(target, path),
      })),
    ),
  );
}

function configAt(sha) {
  try {
    return parseJsonc(
      git(["show", `${sha}:apps/gateway/wrangler.jsonc`], { quiet: true }),
    );
  } catch {
    return {};
  }
}

export function findProtectedRequirements(base, target, environment) {
  validateSha(base, "active base");
  validateSha(target, "release target");
  assertLinearRange(base, target);
  const commits = git(["rev-list", "--reverse", `${base}..${target}`])
    .split("\n")
    .filter(Boolean);
  const requirements = [];
  for (const commit of commits) {
    const parents = git(["rev-list", "--parents", "-n", "1", commit])
      .split(" ")
      .slice(1);
    if (parents.length === 0)
      throw new Error(`Protected commit ${commit} has no parent`);
    const parent = parents[0];
    const policyPaths = changedPaths(parent, commit).filter(isPolicyPath);
    if (policyPaths.length > 0) {
      const evaluatorRef = validateSha(
        process.env.RELEASE_REFEREE_REF,
        "immutable referee ref",
      );
      const evaluatorDigest = process.env.RELEASE_REFEREE_SHA256;
      const trustedTreeDigest = process.env.RELEASE_POLICY_TREE_SHA256;
      if (
        !DIGEST_RE.test(evaluatorDigest ?? "") ||
        !DIGEST_RE.test(trustedTreeDigest ?? "")
      ) {
        throw new Error(
          "immutable referee and protected policy-tree digests are required for policy changes",
        );
      }
      assertLinearRange(evaluatorRef, parent);
      if (
        sha256(git(["show", `${evaluatorRef}:${EVALUATOR_PATH}`])) !==
          evaluatorDigest ||
        policyTreeDigest(evaluatorRef) !== trustedTreeDigest
      ) {
        throw new Error(
          "immutable referee configuration does not match git objects",
        );
      }
      requirements.push({
        kind: "policy",
        targetSha: commit,
        activeBase: parent,
        protectedBase: parent,
        phase: "review",
        digest: policyChangeDigest(parent, commit),
        evaluatorRef,
        evaluatorDigest,
        policyTreeDigest: trustedTreeDigest,
      });
    }
    const convex = classifyConvexContract(parent, commit);
    if (convex.hasContraction) {
      requirements.push({
        kind: "contract",
        targetSha: commit,
        activeBase: base,
        protectedBase: parent,
        phase: "contract",
        digest: contractDigest(parent, commit),
      });
    }
    const lifecycle = classifyLifecycleChange(
      configAt(parent),
      configAt(commit),
      environment,
    );
    if (lifecycle.hasChange) {
      if (
        lifecycle.invalid ||
        lifecycle.manualInspectionRequired ||
        lifecycle.phase === "mixed" ||
        lifecycle.phase === "none"
      ) {
        throw new Error(
          `Commit ${commit} contains invalid, unprovable, or mixed DO lifecycle change`,
        );
      }
      requirements.push({
        kind: "lifecycle",
        targetSha: commit,
        activeBase: base,
        protectedBase: parent,
        phase: lifecycle.phase,
        digest: lifecycle.digest,
      });
    }
  }
  return requirements;
}

export function createProtectedAttestation(input) {
  const hasSourceRun = input.sourceRunId !== undefined;
  const hasSourceAttempt = input.sourceRunAttempt !== undefined;
  const lifecycleRecovery =
    input.kind === "lifecycle" && hasSourceRun && hasSourceAttempt;
  const definition = lifecycleRecovery
    ? LIFECYCLE_RECOVERY_DEFINITION
    : DEFINITIONS[input.kind];
  if (!definition) throw new Error("Unknown protected attestation kind");
  for (const [name, value] of [
    ["target SHA", input.targetSha],
    ["run head SHA", input.runHeadSha],
    ["active base", input.activeBase],
    ["protected base", input.protectedBase],
  ])
    validateSha(value, name);
  if (!DIGEST_RE.test(input.digest ?? ""))
    throw new Error("attestation digest is invalid");
  if (!Number.isSafeInteger(input.workflowId) || input.workflowId <= 0) {
    throw new Error("workflow id is invalid");
  }
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0)
    throw new Error("run id is invalid");
  if (!Number.isSafeInteger(input.runAttempt) || input.runAttempt <= 0) {
    throw new Error("run attempt is invalid");
  }
  if (hasSourceRun !== hasSourceAttempt) {
    throw new Error("source run identity is incomplete");
  }
  if (
    hasSourceRun &&
    (!lifecycleRecovery ||
      !Number.isSafeInteger(input.sourceRunId) ||
      input.sourceRunId <= 0 ||
      !Number.isSafeInteger(input.sourceRunAttempt) ||
      input.sourceRunAttempt <= 0)
  ) {
    throw new Error("source run identity is invalid");
  }
  if (input.workflowPath !== definition.workflowPath)
    throw new Error("workflow path is invalid");
  if (input.environment !== definition.environment)
    throw new Error("environment is invalid");
  if (!["expand", "contract", "review"].includes(input.phase))
    throw new Error("phase is invalid");
  if (input.kind === "policy") {
    validateSha(input.evaluatorRef, "evaluator ref");
    if (
      input.phase !== "review" ||
      !DIGEST_RE.test(input.evaluatorDigest ?? "") ||
      !DIGEST_RE.test(input.policyTreeDigest ?? "") ||
      input.runHeadSha !== input.protectedBase ||
      input.activeBase !== input.protectedBase ||
      input.recoveryOf !== undefined ||
      hasSourceRun
    ) {
      throw new Error("policy attestation trust boundary is invalid");
    }
  } else if (
    input.phase === "review" ||
    input.evaluatorRef !== undefined ||
    input.evaluatorDigest !== undefined ||
    input.policyTreeDigest !== undefined
  ) {
    throw new Error("non-policy attestation contains policy trust fields");
  }
  if (input.recoveryOf !== undefined) {
    validateSha(input.recoveryOf, "recovery target");
    if (input.kind !== "contract" || input.targetSha !== input.recoveryOf) {
      throw new Error("only contract recovery may attest an earlier target");
    }
  }
  return canonical({
    schemaVersion: 2,
    kind: input.kind,
    targetSha: input.targetSha,
    runHeadSha: input.runHeadSha,
    activeBase: input.activeBase,
    protectedBase: input.protectedBase,
    phase: input.phase,
    digest: input.digest,
    workflowPath: input.workflowPath,
    workflowId: input.workflowId,
    runId: input.runId,
    runAttempt: input.runAttempt,
    environment: input.environment,
    event: "workflow_dispatch",
    ...(input.kind === "policy"
      ? {
          evaluatorRef: input.evaluatorRef,
          evaluatorDigest: input.evaluatorDigest,
          policyTreeDigest: input.policyTreeDigest,
          event: "pull_request_target",
        }
      : {}),
    ...(input.recoveryOf ? { recoveryOf: input.recoveryOf } : {}),
    ...(lifecycleRecovery
      ? {
          sourceRunId: input.sourceRunId,
          sourceRunAttempt: input.sourceRunAttempt,
        }
      : {}),
  });
}

export function verifyProtectedAttestation({
  attestation,
  requirement,
  workflow,
  run,
  deployments,
  statusesByDeployment,
  sourceRun,
  targetIsAncestor = attestation?.targetSha === attestation?.runHeadSha,
  sourceTargetIsAncestor = attestation?.targetSha === sourceRun?.head_sha,
  targetParentSha,
  baseIsAncestorOfTarget = false,
  evaluatorIsAncestorOfBase = false,
  linearPolicyRange = false,
}) {
  const definition = definitionForAttestation(attestation);
  if (!definition) throw new Error("Unknown requirement kind");
  const normalized = createProtectedAttestation({
    kind: attestation?.kind,
    targetSha: attestation?.targetSha,
    runHeadSha: attestation?.runHeadSha,
    activeBase: attestation?.activeBase,
    protectedBase: attestation?.protectedBase,
    phase: attestation?.phase,
    digest: attestation?.digest,
    workflowPath: attestation?.workflowPath,
    workflowId: attestation?.workflowId,
    runId: attestation?.runId,
    runAttempt: attestation?.runAttempt,
    environment: attestation?.environment,
    ...(attestation?.recoveryOf ? { recoveryOf: attestation.recoveryOf } : {}),
    ...(attestation?.sourceRunId
      ? {
          sourceRunId: attestation.sourceRunId,
          sourceRunAttempt: attestation.sourceRunAttempt,
        }
      : {}),
    ...(attestation?.kind === "policy"
      ? {
          evaluatorRef: attestation.evaluatorRef,
          evaluatorDigest: attestation.evaluatorDigest,
          policyTreeDigest: attestation.policyTreeDigest,
        }
      : {}),
  });
  if (!equal(normalized, attestation))
    throw new Error("attestation shape is not canonical");
  const expected = {
    kind: requirement.kind,
    targetSha: requirement.targetSha,
    activeBase: requirement.activeBase,
    protectedBase: requirement.protectedBase,
    phase: requirement.phase,
    digest: requirement.digest,
    workflowPath: definition.workflowPath,
    environment: definition.environment,
    ...(requirement.kind === "policy"
      ? {
          evaluatorRef: requirement.evaluatorRef,
          evaluatorDigest: requirement.evaluatorDigest,
          policyTreeDigest: requirement.policyTreeDigest,
        }
      : {}),
  };
  for (const [field, value] of Object.entries(expected)) {
    if (attestation?.[field] !== value)
      throw new Error(`attestation ${field} mismatch`);
  }
  if (
    workflow?.id !== attestation.workflowId ||
    workflow?.path !== definition.workflowPath ||
    run?.id !== attestation.runId ||
    run?.workflow_id !== attestation.workflowId ||
    run?.path !== definition.workflowPath ||
    run?.head_sha !== attestation.runHeadSha ||
    run?.event !== attestation.event ||
    run?.head_branch !== "develop" ||
    run?.status !== "completed" ||
    run?.conclusion !== "success" ||
    run?.run_attempt !== attestation.runAttempt
  ) {
    throw new Error("workflow run provenance mismatch");
  }
  if (requirement.kind === "policy") {
    if (
      run.head_sha !== requirement.protectedBase ||
      !baseIsAncestorOfTarget ||
      !evaluatorIsAncestorOfBase ||
      !linearPolicyRange
    ) {
      throw new Error("policy attestation did not run from immutable base");
    }
  } else {
    if (!targetIsAncestor)
      throw new Error("protected target is not ancestor of workflow run head");
    if (targetParentSha !== requirement.protectedBase) {
      throw new Error("protected target parent does not match canonical base");
    }
  }
  if (
    attestation.sourceRunId !== undefined &&
    (sourceRun?.id !== attestation.sourceRunId ||
      sourceRun?.run_attempt !== attestation.sourceRunAttempt ||
      sourceRun?.path !== DEFINITIONS.lifecycle.workflowPath ||
      !sourceTargetIsAncestor ||
      sourceRun?.status !== "completed" ||
      !["failure", "cancelled", "timed_out"].includes(sourceRun?.conclusion))
  ) {
    throw new Error("recovery source run provenance mismatch");
  }
  const matchingDeployments = (deployments ?? []).filter(
    (deployment) =>
      deployment?.sha === run.head_sha &&
      deployment?.environment === definition.environment &&
      deployment?.creator?.login === "github-actions[bot]",
  );
  const successful = matchingDeployments.filter((deployment) => {
    const statuses = statusesByDeployment?.[deployment.id] ?? [];
    const latest = [...statuses].sort((left, right) => right.id - left.id)[0];
    return (
      latest?.state === "success" &&
      latest?.environment === definition.environment &&
      typeof latest?.log_url === "string" &&
      latest.log_url.includes(`/actions/runs/${run.id}`)
    );
  });
  if (successful.length !== 1)
    throw new Error(
      "protected environment deployment proof is ambiguous or absent",
    );
  return true;
}

async function github(path, token, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`GitHub API ${path} returned ${response.status}`);
  return await response.json();
}

function verifiedPredicate(output) {
  const parsed = JSON.parse(output);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const predicates = rows
    .map((row) => row?.verificationResult?.statement?.predicate)
    .filter(Boolean);
  if (predicates.length !== 1)
    throw new Error("attestation verification predicate is ambiguous");
  return predicates[0];
}

async function verifyRemoteRequirement(
  requirement,
  { repository, token, fetchImpl = fetch },
) {
  const artifactName = `release-attestation-${requirement.kind}-${requirement.targetSha}`;
  const query = new URLSearchParams({ name: artifactName, per_page: "100" });
  const artifactPayload = await github(
    `/repos/${repository}/actions/artifacts?${query}`,
    token,
    fetchImpl,
  );
  const artifacts = (artifactPayload.artifacts ?? []).filter(
    (artifact) => artifact.name === artifactName && !artifact.expired,
  );
  if (artifacts.length === 0)
    throw new Error(
      `protected attestation missing for ${requirement.targetSha}`,
    );
  const valid = [];
  for (const artifact of artifacts) {
    const run = await github(
      `/repos/${repository}/actions/runs/${artifact.workflow_run?.id}`,
      token,
      fetchImpl,
    );
    if (run.conclusion !== "success") continue;
    const directory = mkdtempSync(join(tmpdir(), "zevium-attestation-"));
    try {
      execFileSync(
        "gh",
        [
          "run",
          "download",
          String(run.id),
          "--repo",
          repository,
          "--name",
          artifactName,
          "--dir",
          directory,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, GH_TOKEN: token },
        },
      );
      const files = readdirSync(directory);
      if (!files.includes("release-attestation.json"))
        throw new Error("attestation artifact subject missing");
      const subjectPath = join(directory, "release-attestation.json");
      const attestation = JSON.parse(readFileSync(subjectPath, "utf8"));
      const definition = definitionForAttestation(attestation);
      if (!definition || attestation.kind !== requirement.kind)
        throw new Error("attestation workflow kind is invalid");
      const workflow = await github(
        `/repos/${repository}/actions/workflows/${encodeURIComponent(definition.workflowPath)}`,
        token,
        fetchImpl,
      );
      const verifyOutput = execFileSync(
        "gh",
        [
          "attestation",
          "verify",
          subjectPath,
          "--repo",
          repository,
          "--signer-workflow",
          `${repository}/${definition.workflowPath}`,
          "--source-digest",
          run.head_sha,
          "--source-ref",
          "refs/heads/develop",
          "--predicate-type",
          ATTESTATION_TYPE,
          "--format",
          "json",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, GH_TOKEN: token },
        },
      );
      const predicate = verifiedPredicate(verifyOutput);
      if (!equal(predicate?.attestation, attestation))
        throw new Error("signed predicate and subject disagree");
      const deploymentQuery = new URLSearchParams({
        sha: run.head_sha,
        environment: definition.environment,
        per_page: "100",
      });
      const deployments = await github(
        `/repos/${repository}/deployments?${deploymentQuery}`,
        token,
        fetchImpl,
      );
      const statusesByDeployment = {};
      for (const deployment of deployments) {
        statusesByDeployment[deployment.id] = await github(
          `/repos/${repository}/deployments/${deployment.id}/statuses?per_page=100`,
          token,
          fetchImpl,
        );
      }
      const sourceRun = attestation.sourceRunId
        ? await github(
            `/repos/${repository}/actions/runs/${attestation.sourceRunId}`,
            token,
            fetchImpl,
          )
        : undefined;
      const targetCommit = await github(
        `/repos/${repository}/commits/${attestation.targetSha}`,
        token,
        fetchImpl,
      );
      const targetParentSha =
        Array.isArray(targetCommit.parents) && targetCommit.parents.length === 1
          ? targetCommit.parents[0]?.sha
          : undefined;
      const policyComparison =
        requirement.kind === "policy"
          ? await github(
              `/repos/${repository}/compare/${requirement.protectedBase}...${requirement.targetSha}`,
              token,
              fetchImpl,
            )
          : undefined;
      const evaluatorComparison =
        requirement.kind === "policy" &&
        requirement.evaluatorRef !== requirement.protectedBase
          ? await github(
              `/repos/${repository}/compare/${requirement.evaluatorRef}...${requirement.protectedBase}`,
              token,
              fetchImpl,
            )
          : undefined;
      const policyCommits = policyComparison?.commits ?? [];
      let policyParent = requirement.protectedBase;
      const linearPolicyRange =
        requirement.kind !== "policy" ||
        (policyComparison?.status === "ahead" &&
          policyCommits.length > 0 &&
          policyCommits.every((commit) => {
            const valid =
              commit?.parents?.length === 1 &&
              commit.parents[0]?.sha === policyParent;
            policyParent = commit?.sha;
            return valid;
          }) &&
          policyParent === requirement.targetSha);
      const targetIsAncestor =
        attestation.targetSha === run.head_sha ||
        (
          await github(
            `/repos/${repository}/compare/${attestation.targetSha}...${run.head_sha}`,
            token,
            fetchImpl,
          )
        ).status === "ahead";
      const sourceTargetIsAncestor =
        sourceRun === undefined ||
        attestation.targetSha === sourceRun.head_sha ||
        (
          await github(
            `/repos/${repository}/compare/${attestation.targetSha}...${sourceRun.head_sha}`,
            token,
            fetchImpl,
          )
        ).status === "ahead";
      verifyProtectedAttestation({
        attestation,
        requirement,
        workflow,
        run,
        deployments,
        statusesByDeployment,
        sourceRun,
        targetIsAncestor,
        sourceTargetIsAncestor,
        targetParentSha,
        baseIsAncestorOfTarget:
          policyComparison?.status === "ahead" ||
          policyComparison?.status === "identical",
        evaluatorIsAncestorOfBase:
          requirement.kind !== "policy" ||
          requirement.evaluatorRef === requirement.protectedBase ||
          evaluatorComparison?.status === "ahead",
        linearPolicyRange,
      });
      valid.push(attestation);
    } catch {
      // Try every immutable artifact. A failed/partial retry cannot mask one
      // later valid protected run.
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  if (valid.length === 0)
    throw new Error(
      `no verifiable protected attestation for ${requirement.targetSha}`,
    );
  return canonical(
    [...valid].sort((left, right) => right.runId - left.runId)[0],
  );
}

function parseArgs(argv) {
  const [command, ...raw] = argv;
  const args = {};
  for (const entry of raw) {
    if (!entry.startsWith("--") || !entry.includes("="))
      throw new Error(`Invalid argument: ${entry}`);
    const [name, ...value] = entry.slice(2).split("=");
    if (Object.hasOwn(args, name))
      throw new Error(`Duplicate argument: ${name}`);
    args[name] = value.join("=");
  }
  return { command, args };
}

export async function run(argv = process.argv.slice(2)) {
  const { command, args } = parseArgs(argv);
  if (command === "requirements") {
    const requirements = findProtectedRequirements(
      args.base,
      args.target,
      args.environment || undefined,
    );
    process.stdout.write(`${JSON.stringify(requirements)}\n`);
    return requirements;
  }
  if (command === "contract-digest") {
    const digest = contractDigest(args.base, args.target);
    process.stdout.write(`${digest}\n`);
    return digest;
  }
  if (command === "policy-digest") {
    const value = policyChangeDigest(args.base, args.target);
    process.stdout.write(`${value}\n`);
    return value;
  }
  if (command === "policy-tree-digest") {
    const value = policyTreeDigest(args.sha);
    process.stdout.write(`${value}\n`);
    return value;
  }
  if (command === "verify-referee") {
    const value = verifyImmutableReferee({
      refereeRef: args.ref,
      target: args.target,
      evaluatorDigest: args["evaluator-digest"],
      treeDigest: args["tree-digest"],
      repository: args.repository,
      targetBranch: args["target-branch"],
    });
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return value;
  }
  if (command === "lifecycle-digest") {
    const digest = lifecycleDigest(
      parseJsonc(readFileSync(args.config, "utf8")),
      args.environment || undefined,
    );
    process.stdout.write(`${digest}\n`);
    return digest;
  }
  if (command === "create") {
    const attestation = createProtectedAttestation({
      kind: args.kind,
      targetSha: args.target,
      runHeadSha: args["run-head"],
      activeBase: args["active-base"],
      protectedBase: args["protected-base"],
      phase: args.phase,
      digest: args.digest,
      workflowPath: args["workflow-path"],
      workflowId: Number(args["workflow-id"]),
      runId: Number(args["run-id"]),
      runAttempt: Number(args["run-attempt"]),
      environment: args.environment,
      ...(args["recovery-of"] ? { recoveryOf: args["recovery-of"] } : {}),
      ...(args["source-run-id"]
        ? { sourceRunId: Number(args["source-run-id"]) }
        : {}),
      ...(args["source-run-attempt"]
        ? { sourceRunAttempt: Number(args["source-run-attempt"]) }
        : {}),
      ...(args["evaluator-ref"]
        ? {
            evaluatorRef: args["evaluator-ref"],
            evaluatorDigest: args["evaluator-digest"],
            policyTreeDigest: args["policy-tree-digest"],
          }
        : {}),
    });
    writeFileSync(args.output, `${JSON.stringify(attestation, null, 2)}\n`, {
      mode: 0o600,
    });
    writeFileSync(
      args.predicate,
      `${JSON.stringify({ attestation }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return attestation;
  }
  if (command === "verify-remote") {
    const allRequirements = findProtectedRequirements(
      args.base,
      args.target,
      args.environment || undefined,
    );
    const excludeKind = args["exclude-kind"];
    const excludeTarget = args["exclude-target"];
    if ((excludeKind === undefined) !== (excludeTarget === undefined)) {
      throw new Error("protected requirement exclusion is incomplete");
    }
    let requirements = allRequirements;
    if (excludeKind !== undefined) {
      if (!new Set(["contract", "lifecycle"]).has(excludeKind)) {
        throw new Error("only current protected mutation may be excluded");
      }
      validateSha(excludeTarget, "excluded protected target");
      const excluded = allRequirements.filter(
        (row) => row.kind === excludeKind && row.targetSha === excludeTarget,
      );
      if (excluded.length !== 1 || excludeTarget !== args.target) {
        throw new Error("excluded protected requirement is not exact target");
      }
      const order = new Map([
        ["policy", -1],
        ["contract", 0],
        ["lifecycle", 1],
      ]);
      requirements = allRequirements.filter(
        (row) =>
          row !== excluded[0] &&
          !(
            row.targetSha === excludeTarget &&
            order.get(row.kind) > order.get(excludeKind)
          ),
      );
    }
    const token = process.env.GH_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY;
    if (!token || !repository)
      throw new Error("GitHub provenance environment is missing");
    for (const requirement of requirements) {
      await verifyRemoteRequirement(requirement, { repository, token });
    }
    process.stdout.write(
      `${JSON.stringify({ verified: requirements.length })}\n`,
    );
    return requirements;
  }
  throw new Error(
    "Usage: release-attestation.mjs requirements|contract-digest|policy-digest|policy-tree-digest|verify-referee|lifecycle-digest|create|verify-remote",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "release attestation failed",
    );
    process.exitCode = 1;
  });
}

export { ATTESTATION_TYPE };
