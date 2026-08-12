import { BrokerError, invariant } from "./errors";
import type { GitHubOidcClaims } from "./jwt";
import {
  GITHUB_ACTOR,
  GITHUB_ACTOR_ID,
  GITHUB_REPOSITORY,
  GITHUB_REPOSITORY_ID,
  GITHUB_REPOSITORY_OWNER_ID,
  type DeploymentManifest,
} from "./manifest";
import { isRecord, parseStrictJson } from "./strict-json";

const GITHUB_API_ORIGIN = "https://api.github.com";
const MAX_GITHUB_RESPONSE_BYTES = 512 * 1024;
const REPOSITORY_OWNER = "zevium-dev";

export interface ProvenanceOptions {
  fetcher?: typeof fetch;
}

function workflowPaths(manifest: DeploymentManifest): {
  caller: string;
  reusable: string;
} {
  if (manifest.profile.startsWith("production-")) {
    return {
      caller: ".github/workflows/deploy-production.yml",
      reusable: ".github/workflows/cloudflare-production.yml",
    };
  }
  if (manifest.profile === "preview-cleanup") {
    return {
      caller: ".github/workflows/preview-cleanup.yml",
      reusable: ".github/workflows/cloudflare-cleanup.yml",
    };
  }
  return {
    caller: ".github/workflows/preview.yml",
    reusable: ".github/workflows/cloudflare-preview.yml",
  };
}

export function validateIdentityClaims(
  manifest: DeploymentManifest,
  claims: GitHubOidcClaims,
): void {
  invariant(
    claims.repository === GITHUB_REPOSITORY &&
      claims.repository_id === GITHUB_REPOSITORY_ID &&
      claims.repository_owner === REPOSITORY_OWNER &&
      claims.repository_owner_id === GITHUB_REPOSITORY_OWNER_ID &&
      claims.repository_visibility === "public",
    403,
    "repository_rejected",
    "OIDC repository identity is not authorized",
  );
  invariant(
    claims.actor === GITHUB_ACTOR && claims.actor_id === GITHUB_ACTOR_ID,
    403,
    "actor_rejected",
    "OIDC actor is not authorized",
  );
  invariant(
    claims.sub ===
      `repo:${GITHUB_REPOSITORY}:environment:${manifest.environment}`,
    403,
    "subject_rejected",
    "OIDC subject is not authorized",
  );
  invariant(
    claims.environment === manifest.environment,
    403,
    "environment_rejected",
    "OIDC environment does not match manifest",
  );
  invariant(
    claims.event_name === manifest.eventName,
    403,
    "event_rejected",
    "OIDC event does not match manifest",
  );
  invariant(
    claims.ref === manifest.ref && claims.sha === manifest.oidcSha,
    403,
    "revision_rejected",
    "OIDC ref/SHA does not match manifest",
  );
  invariant(
    claims.run_id === manifest.runId &&
      Number(claims.run_attempt) === manifest.runAttempt,
    403,
    "run_rejected",
    "OIDC run identity does not match manifest",
  );

  const paths = workflowPaths(manifest);
  const expectedCaller = `${GITHUB_REPOSITORY}/${paths.caller}@${claims.ref}`;
  const expectedReusable = `${GITHUB_REPOSITORY}/${paths.reusable}@${claims.ref}`;
  invariant(
    claims.workflow_ref === expectedCaller,
    403,
    "caller_workflow_rejected",
    "OIDC caller workflow is not authorized",
  );
  invariant(
    claims.job_workflow_ref === expectedReusable,
    403,
    "reusable_workflow_rejected",
    "OIDC reusable workflow is not authorized",
  );
  invariant(
    claims.workflow_sha === claims.sha &&
      claims.job_workflow_sha === claims.sha,
    403,
    "workflow_revision_rejected",
    "OIDC workflow revision is ambiguous",
  );
}

async function readResponseJson(response: Response): Promise<unknown> {
  invariant(
    response.status < 300 || response.status >= 400,
    403,
    "github_redirect_rejected",
    "GitHub provenance redirect was rejected",
  );
  invariant(
    response.status === 200,
    403,
    "github_provenance_unavailable",
    "GitHub provenance could not be verified",
  );
  invariant(
    response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json"),
    403,
    "github_provenance_unavailable",
    "GitHub provenance response type is invalid",
  );
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > MAX_GITHUB_RESPONSE_BYTES) {
    throw new BrokerError(
      403,
      "github_provenance_unavailable",
      "GitHub provenance response is too large",
    );
  }
  invariant(
    response.body,
    403,
    "github_provenance_unavailable",
    "GitHub provenance response is empty",
  );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_GITHUB_RESPONSE_BYTES) {
      await reader.cancel("response limit exceeded");
      throw new BrokerError(
        403,
        "github_provenance_unavailable",
        "GitHub provenance response is too large",
      );
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BrokerError(
      403,
      "github_provenance_unavailable",
      "GitHub provenance response is invalid",
    );
  }
  return parseStrictJson(source);
}

async function githubGet(
  path: string,
  fetcher: typeof fetch,
): Promise<unknown> {
  const response = await fetcher(`${GITHUB_API_ORIGIN}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "zevium-deploy-broker/1",
      "x-github-api-version": "2026-03-10",
    },
    redirect: "manual",
  });
  return readResponseJson(response);
}

function recordAt(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  invariant(
    isRecord(value),
    403,
    "github_provenance_rejected",
    `GitHub ${key} field is invalid`,
  );
  return value;
}

function stringAt(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  invariant(
    typeof value === "string",
    403,
    "github_provenance_rejected",
    `GitHub ${key} field is invalid`,
  );
  return value;
}

function numericIdAt(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  invariant(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    403,
    "github_provenance_rejected",
    `GitHub ${key} field is invalid`,
  );
  return String(value);
}

async function verifyPullRequest(
  manifest: DeploymentManifest,
  claims: GitHubOidcClaims,
  fetcher: typeof fetch,
): Promise<void> {
  invariant(
    manifest.prNumber !== null,
    403,
    "pr_rejected",
    "PR number is required",
  );
  const value = await githubGet(
    `/repos/${GITHUB_REPOSITORY}/pulls/${manifest.prNumber}`,
    fetcher,
  );
  invariant(
    isRecord(value),
    403,
    "pr_rejected",
    "GitHub PR response is invalid",
  );
  invariant(
    value.number === manifest.prNumber,
    403,
    "pr_rejected",
    "GitHub PR number does not match",
  );
  const head = recordAt(value, "head");
  const base = recordAt(value, "base");
  const headRepository = recordAt(head, "repo");
  const baseRepository = recordAt(base, "repo");
  invariant(
    stringAt(head, "sha") === manifest.headSha &&
      numericIdAt(headRepository, "id") === GITHUB_REPOSITORY_ID &&
      stringAt(headRepository, "full_name") === GITHUB_REPOSITORY &&
      numericIdAt(baseRepository, "id") === GITHUB_REPOSITORY_ID &&
      stringAt(baseRepository, "full_name") === GITHUB_REPOSITORY,
    403,
    "fork_rejected",
    "Fork or cross-repository PR is not authorized",
  );
  invariant(
    stringAt(base, "ref") === "develop",
    403,
    "base_ref_rejected",
    "PR base branch is not authorized",
  );

  const cleanup = manifest.profile === "preview-cleanup";
  const state = stringAt(value, "state");
  invariant(
    cleanup ? state === "closed" : state === "open",
    403,
    "pr_state_rejected",
    "PR lifecycle does not match operation",
  );

  if (claims.event_name === "pull_request") {
    invariant(
      claims.head_ref === stringAt(head, "ref") &&
        claims.base_ref === "develop",
      403,
      "pr_claims_rejected",
      "OIDC PR branch claims are ambiguous",
    );
    const merged = value.merged === true;
    const expectedRef =
      cleanup && merged
        ? "refs/heads/develop"
        : `refs/pull/${manifest.prNumber}/merge`;
    invariant(
      claims.ref === expectedRef,
      403,
      "pr_ref_rejected",
      "OIDC PR ref is ambiguous",
    );
    const mergeSha = value.merge_commit_sha;
    invariant(
      typeof mergeSha === "string" && claims.sha === mergeSha,
      403,
      "pr_merge_sha_rejected",
      "OIDC PR merge SHA is ambiguous",
    );
  } else {
    invariant(
      claims.event_name === "workflow_dispatch" &&
        claims.ref === "refs/heads/develop" &&
        (claims.base_ref === undefined || claims.base_ref === "") &&
        (claims.head_ref === undefined || claims.head_ref === ""),
      403,
      "dispatch_ref_rejected",
      "Manual preview must run from develop",
    );
  }
}

async function verifyWorkflowRun(
  manifest: DeploymentManifest,
  fetcher: typeof fetch,
): Promise<void> {
  invariant(
    manifest.sourceRunId !== null,
    403,
    "source_run_rejected",
    "Source run is required",
  );
  const value = await githubGet(
    `/repos/${GITHUB_REPOSITORY}/actions/runs/${manifest.sourceRunId}`,
    fetcher,
  );
  invariant(
    isRecord(value),
    403,
    "source_run_rejected",
    "GitHub workflow run response is invalid",
  );
  const repository = recordAt(value, "repository");
  const headRepository = recordAt(value, "head_repository");
  invariant(
    numericIdAt(value, "id") === manifest.sourceRunId &&
      numericIdAt(repository, "id") === GITHUB_REPOSITORY_ID &&
      numericIdAt(headRepository, "id") === GITHUB_REPOSITORY_ID &&
      stringAt(value, "head_sha") === manifest.headSha &&
      stringAt(value, "head_branch") === "develop" &&
      stringAt(value, "event") === "push" &&
      stringAt(value, "status") === "completed" &&
      stringAt(value, "conclusion") === "success" &&
      stringAt(value, "name") === "Continuous Integration" &&
      stringAt(value, "path") === ".github/workflows/ci.yml",
    403,
    "source_run_rejected",
    "Source CI run is not an authorized successful develop run",
  );
}

export async function verifyProvenance(
  manifest: DeploymentManifest,
  claims: GitHubOidcClaims,
  options: ProvenanceOptions = {},
): Promise<void> {
  validateIdentityClaims(manifest, claims);
  const fetcher = options.fetcher ?? fetch;
  if (manifest.profile.startsWith("production-")) {
    invariant(
      claims.event_name === "workflow_run" &&
        claims.ref === "refs/heads/develop" &&
        (claims.base_ref === undefined || claims.base_ref === "") &&
        (claims.head_ref === undefined || claims.head_ref === ""),
      403,
      "production_ref_rejected",
      "Production must run from develop workflow_run",
    );
    await verifyWorkflowRun(manifest, fetcher);
    return;
  }
  await verifyPullRequest(manifest, claims, fetcher);
}
