import { BrokerError, invariant } from "./errors.ts";
import type { DeploymentProfile } from "./manifest.ts";
import { exactKeys, isRecord } from "./strict-json.ts";

export const DEPLOYMENT_RECEIPT_SCHEMA =
  "zevium.cloudflare-deploy-receipt/v1" as const;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function targetMatchesProfile(
  profile: DeploymentProfile,
  target: string,
): boolean {
  switch (profile) {
    case "preview-gateway":
      return /^zevium-gateway-pr-[1-9][0-9]{0,9}$/.test(target);
    case "preview-web":
      return /^zevium-web-pr-[1-9][0-9]{0,9}$/.test(target);
    case "staging-gateway":
      return target === "zevium-gateway-staging";
    case "staging-web":
      return target === "zevium-web-staging";
    case "production-gateway":
      return target === "zevium-gateway";
    case "production-web":
      return target === "zevium-dev";
    case "preview-cleanup":
      return false;
  }
}

export type DeploymentReceiptPhase =
  | "activated"
  | "prepared"
  | "recovered"
  | "recovery_prepared"
  | "version_uploaded";

export interface DeploymentReceipt {
  artifactDigests: {
    modules: Array<{ name: string; sha256: string }>;
    staticAssets: Array<{ path: string; sha256: string }>;
  };
  createdAt: string;
  deploymentId: string | null;
  gitSha: string;
  manifestDigest: string;
  phase: DeploymentReceiptPhase;
  priorDeploymentId: string | null;
  priorVersionId: string | null;
  profile: DeploymentProfile;
  recovery: null | {
    failedDeploymentId: string | null;
    failedGitSha: string;
    failedVersionId: string | null;
    mode: "already_active" | "redeployed_prior" | null;
    sourceReceiptDigest: string;
  };
  schema: typeof DEPLOYMENT_RECEIPT_SCHEMA;
  target: string;
  versionId: string | null;
}

function receiptRejected(message: string): never {
  throw new BrokerError(400, "receipt_rejected", message);
}

function nullableUuid(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    receiptRejected(`${name} is invalid`);
  }
  return value;
}

function parseDigests(
  value: unknown,
  kind: "modules",
): Array<{ name: string; sha256: string }>;
function parseDigests(
  value: unknown,
  kind: "staticAssets",
): Array<{ path: string; sha256: string }>;
function parseDigests(
  value: unknown,
  kind: "modules" | "staticAssets",
): Array<Record<string, string>> {
  invariant(
    Array.isArray(value) && value.length <= 2_000,
    400,
    "receipt_rejected",
    `Receipt ${kind} digests are invalid`,
  );
  const names = new Set<string>();
  return value.map((entry) => {
    const key = kind === "modules" ? "name" : "path";
    invariant(
      isRecord(entry) &&
        exactKeys(entry, [key, "sha256"]) &&
        typeof entry[key] === "string" &&
        entry[key].length > 0 &&
        entry[key].length <= 1_024 &&
        !names.has(entry[key]) &&
        typeof entry.sha256 === "string" &&
        DIGEST_PATTERN.test(entry.sha256),
      400,
      "receipt_rejected",
      `Receipt ${kind} digest is invalid`,
    );
    names.add(entry[key]);
    return { [key]: entry[key], sha256: entry.sha256 };
  });
}

export function parseDeploymentReceipt(value: unknown): DeploymentReceipt {
  invariant(
    isRecord(value) &&
      exactKeys(value, [
        "artifactDigests",
        "createdAt",
        "deploymentId",
        "gitSha",
        "manifestDigest",
        "phase",
        "priorDeploymentId",
        "priorVersionId",
        "profile",
        "recovery",
        "schema",
        "target",
        "versionId",
      ]) &&
      value.schema === DEPLOYMENT_RECEIPT_SCHEMA &&
      typeof value.createdAt === "string" &&
      !Number.isNaN(Date.parse(value.createdAt)) &&
      new Date(value.createdAt).toISOString() === value.createdAt &&
      typeof value.gitSha === "string" &&
      SHA_PATTERN.test(value.gitSha) &&
      typeof value.manifestDigest === "string" &&
      DIGEST_PATTERN.test(value.manifestDigest) &&
      typeof value.target === "string" &&
      typeof value.profile === "string" &&
      [
        "preview-gateway",
        "preview-web",
        "staging-gateway",
        "staging-web",
        "production-gateway",
        "production-web",
      ].includes(value.profile) &&
      typeof value.phase === "string" &&
      [
        "activated",
        "prepared",
        "recovered",
        "recovery_prepared",
        "version_uploaded",
      ].includes(value.phase) &&
      isRecord(value.artifactDigests) &&
      exactKeys(value.artifactDigests, ["modules", "staticAssets"]),
    400,
    "receipt_rejected",
    "Deployment receipt is invalid",
  );
  const deploymentId = nullableUuid(value.deploymentId, "deploymentId");
  const priorDeploymentId = nullableUuid(
    value.priorDeploymentId,
    "priorDeploymentId",
  );
  const priorVersionId = nullableUuid(value.priorVersionId, "priorVersionId");
  const versionId = nullableUuid(value.versionId, "versionId");
  const recovery = value.recovery;
  let parsedRecovery: DeploymentReceipt["recovery"] = null;
  if (recovery !== null) {
    invariant(
      isRecord(recovery) &&
        exactKeys(recovery, [
          "failedDeploymentId",
          "failedGitSha",
          "failedVersionId",
          "mode",
          "sourceReceiptDigest",
        ]) &&
        (recovery.mode === null ||
          recovery.mode === "already_active" ||
          recovery.mode === "redeployed_prior") &&
        typeof recovery.failedGitSha === "string" &&
        SHA_PATTERN.test(recovery.failedGitSha) &&
        typeof recovery.sourceReceiptDigest === "string" &&
        DIGEST_PATTERN.test(recovery.sourceReceiptDigest),
      400,
      "receipt_rejected",
      "Deployment recovery receipt is invalid",
    );
    parsedRecovery = {
      failedDeploymentId: nullableUuid(
        recovery.failedDeploymentId,
        "failedDeploymentId",
      ),
      failedGitSha: recovery.failedGitSha,
      failedVersionId: nullableUuid(
        recovery.failedVersionId,
        "failedVersionId",
      ),
      mode: recovery.mode,
      sourceReceiptDigest: recovery.sourceReceiptDigest,
    };
  }
  const modules = parseDigests(value.artifactDigests.modules, "modules");
  const staticAssets = parseDigests(
    value.artifactDigests.staticAssets,
    "staticAssets",
  );
  const profile = value.profile as DeploymentProfile;
  const phase = value.phase as DeploymentReceiptPhase;
  invariant(
    targetMatchesProfile(profile, value.target),
    400,
    "receipt_rejected",
    "Deployment receipt target does not match profile",
  );
  invariant(
    (priorDeploymentId === null) === (priorVersionId === null),
    400,
    "receipt_rejected",
    "Deployment receipt prior selectors are incomplete",
  );

  const phaseIsValid =
    (phase === "prepared" &&
      deploymentId === null &&
      versionId === null &&
      parsedRecovery === null) ||
    (phase === "version_uploaded" &&
      deploymentId === null &&
      versionId !== null &&
      parsedRecovery === null) ||
    (phase === "activated" &&
      deploymentId !== null &&
      versionId !== null &&
      parsedRecovery === null) ||
    (phase === "recovery_prepared" &&
      deploymentId === null &&
      versionId !== null &&
      priorVersionId === versionId &&
      parsedRecovery !== null &&
      parsedRecovery.mode === null) ||
    (phase === "recovered" &&
      deploymentId !== null &&
      versionId !== null &&
      priorVersionId === versionId &&
      parsedRecovery !== null &&
      parsedRecovery.mode !== null);
  invariant(
    phaseIsValid,
    400,
    "receipt_rejected",
    "Deployment receipt phase state is impossible",
  );
  if (parsedRecovery !== null) {
    invariant(
      priorDeploymentId !== null &&
        priorVersionId !== null &&
        (parsedRecovery.failedDeploymentId === null ||
          (parsedRecovery.failedVersionId !== null &&
            parsedRecovery.failedDeploymentId !== priorDeploymentId)) &&
        (parsedRecovery.failedVersionId === null ||
          parsedRecovery.failedVersionId !== priorVersionId),
      400,
      "receipt_rejected",
      "Deployment recovery selectors are inconsistent",
    );
  }
  return {
    artifactDigests: { modules, staticAssets },
    createdAt: value.createdAt,
    deploymentId,
    gitSha: value.gitSha,
    manifestDigest: value.manifestDigest,
    phase,
    priorDeploymentId,
    priorVersionId,
    profile,
    recovery: parsedRecovery,
    schema: DEPLOYMENT_RECEIPT_SCHEMA,
    target: value.target,
    versionId,
  };
}
