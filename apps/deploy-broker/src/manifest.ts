import { BrokerError } from "./errors.ts";

export const MANIFEST_SCHEMA = "zevium.cloudflare-deploy/v1" as const;
export const AUDIENCE_PREFIX = "urn:zevium:cloudflare-deploy:v1:";
export const CLOUDFLARE_ACCOUNT_ID = "1ea9299555b026a6a7484c8323c5a953";
export const GITHUB_REPOSITORY = "zevium-dev/core";
export const GITHUB_REPOSITORY_ID = "1044451612";
export const GITHUB_REPOSITORY_OWNER_ID = "228443220";
export const GITHUB_ACTOR = "tnfssc";
export const GITHUB_ACTOR_ID = "29162020";
export const BROKER_SCRIPT_NAME = "zevium-deploy-broker";
export const PRODUCTION_CONVEX_URL = "https://polite-ermine-809.convex.cloud";
export const PRODUCTION_CONVEX_SITE_URL =
  "https://polite-ermine-809.convex.site";

export type DeploymentProfile =
  | "preview-gateway"
  | "preview-web"
  | "preview-cleanup"
  | "production-gateway"
  | "production-web";

export type ManifestOperation =
  | "assets:upload"
  | "deployment:create"
  | "script:delete"
  | "script:read"
  | "script:upload"
  | "secret:put"
  | "subdomain:write"
  | "version:read";

export interface PlainTextBindingManifest {
  name: string;
  text: string;
}

export interface DurableObjectBindingManifest {
  className: string;
  name: string;
}

export interface SecretBindingManifest {
  name: string;
  sha256: string;
}

export interface TargetManifest {
  allowedSecrets: SecretBindingManifest[];
  assets: boolean;
  compatibilityDate: string;
  compatibilityFlags: string[];
  component: "gateway" | "web";
  durableObjectBindings: DurableObjectBindingManifest[];
  migration: null | {
    newSqliteClasses: string[];
    tag: string;
  };
  operations: ManifestOperation[];
  plainTextBindings: PlainTextBindingManifest[];
  scriptName: string;
  versionTag: null | string;
  workersDev: null | {
    enabled: boolean;
    previewsEnabled: boolean;
  };
}

export interface DeploymentManifest {
  accountId: string;
  environment: "preview" | "production";
  eventName: "pull_request" | "workflow_dispatch" | "workflow_run";
  headSha: string;
  oidcSha: string;
  prNumber: null | number;
  profile: DeploymentProfile;
  ref: string;
  repository: string;
  repositoryId: string;
  repositoryOwnerId: string;
  runAttempt: number;
  runId: string;
  schema: typeof MANIFEST_SCHEMA;
  sourceRunId: null | string;
  targets: TargetManifest[];
}

export interface ManifestInput {
  convexSiteUrl?: string;
  convexUrl?: string;
  eventName: DeploymentManifest["eventName"];
  headSha: string;
  oidcSha: string;
  prNumber?: number;
  profile: DeploymentProfile;
  ref: string;
  runAttempt: number;
  runId: string;
  secretDigests?: SecretBindingManifest[];
  sourceRunId?: string;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const CONVEX_DEPLOYMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message: string): never {
  throw new BrokerError(
    400,
    "manifest_rejected",
    `Invalid deployment manifest: ${message}`,
  );
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} keys differ`);
  }
}

function assertSha(value: string, name: string): void {
  if (!SHA_PATTERN.test(value)) fail(`${name} must be a lowercase commit SHA`);
}

function assertRunId(value: string, name: string): void {
  if (!RUN_ID_PATTERN.test(value))
    fail(`${name} must be a positive integer string`);
}

function assertPreviewNumber(value: number | undefined): number {
  if (
    !Number.isSafeInteger(value) ||
    value === undefined ||
    value < 1 ||
    value > 9_999_999
  ) {
    fail("prNumber is out of range");
  }
  return value;
}

function validateConvexUrls(
  convexUrl: string | undefined,
  convexSiteUrl: string | undefined,
): {
  cloud: string;
  site: string;
} {
  if (!convexUrl || !convexSiteUrl)
    fail("preview gateway requires Convex URLs");

  const cloud = new URL(convexUrl);
  const site = new URL(convexSiteUrl);
  if (
    cloud.protocol !== "https:" ||
    site.protocol !== "https:" ||
    cloud.username ||
    cloud.password ||
    site.username ||
    site.password ||
    cloud.port ||
    site.port ||
    cloud.pathname !== "/" ||
    site.pathname !== "/" ||
    cloud.search ||
    site.search ||
    cloud.hash ||
    site.hash
  ) {
    fail("Convex URLs must be bare HTTPS origins");
  }

  const cloudSuffix = ".convex.cloud";
  const siteSuffix = ".convex.site";
  if (
    !cloud.hostname.endsWith(cloudSuffix) ||
    !site.hostname.endsWith(siteSuffix)
  ) {
    fail("Convex URL hosts are invalid");
  }
  const cloudDeployment = cloud.hostname.slice(0, -cloudSuffix.length);
  const siteDeployment = site.hostname.slice(0, -siteSuffix.length);
  if (
    cloudDeployment !== siteDeployment ||
    !CONVEX_DEPLOYMENT_PATTERN.test(cloudDeployment)
  ) {
    fail("Convex URL deployments differ");
  }

  return { cloud: cloud.origin, site: site.origin };
}

function validateSecretDigests(
  values: SecretBindingManifest[] | undefined,
  expectedNames: readonly string[],
): SecretBindingManifest[] {
  const secrets = values ?? [];
  if (secrets.length !== expectedNames.length) {
    fail("secret digest count does not match profile");
  }
  const byName = new Map<string, string>();
  for (const secret of secrets) {
    if (
      typeof secret.name !== "string" ||
      !expectedNames.includes(secret.name) ||
      typeof secret.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(secret.sha256) ||
      byName.has(secret.name)
    ) {
      fail("secret digest is invalid");
    }
    byName.set(secret.name, secret.sha256);
  }
  return [...expectedNames].sort().map((name) => ({
    name,
    sha256: byName.get(name) ?? fail("secret digest is missing"),
  }));
}

function gatewayTarget(
  scriptName: string,
  mode: "preview" | "production",
  convexUrl: string,
  convexSiteUrl: string,
  versionTag: string | null,
  allowedSecrets: SecretBindingManifest[],
): TargetManifest {
  return {
    allowedSecrets,
    assets: false,
    compatibilityDate: "2025-04-01",
    compatibilityFlags: ["global_fetch_strictly_public"],
    component: "gateway",
    durableObjectBindings: [{ className: "WalletDO", name: "WALLET" }],
    migration: { newSqliteClasses: ["WalletDO"], tag: "v1" },
    operations:
      mode === "preview"
        ? [
            "deployment:create",
            "script:read",
            "script:upload",
            "secret:put",
            "subdomain:write",
            "version:read",
          ]
        : ["deployment:create", "script:read", "script:upload", "version:read"],
    plainTextBindings: [
      { name: "CONVEX_SITE_URL", text: convexSiteUrl },
      { name: "CONVEX_URL", text: convexUrl },
    ],
    scriptName,
    versionTag,
    workersDev:
      mode === "preview" ? { enabled: true, previewsEnabled: true } : null,
  };
}

function webTarget(
  scriptName: string,
  mode: "preview" | "production",
  versionTag: string | null,
  allowedSecrets: SecretBindingManifest[],
): TargetManifest {
  return {
    allowedSecrets,
    assets: true,
    compatibilityDate: "2026-07-18",
    compatibilityFlags: ["nodejs_compat"],
    component: "web",
    durableObjectBindings: [],
    migration: null,
    operations:
      mode === "preview"
        ? [
            "assets:upload",
            "deployment:create",
            "script:read",
            "script:upload",
            "secret:put",
            "subdomain:write",
            "version:read",
          ]
        : [
            "assets:upload",
            "deployment:create",
            "script:read",
            "script:upload",
            "version:read",
          ],
    plainTextBindings: [],
    scriptName,
    versionTag,
    workersDev:
      mode === "preview" ? { enabled: true, previewsEnabled: true } : null,
  };
}

export function buildManifest(input: ManifestInput): DeploymentManifest {
  assertSha(input.headSha, "headSha");
  assertSha(input.oidcSha, "oidcSha");
  assertRunId(input.runId, "runId");
  if (
    !Number.isSafeInteger(input.runAttempt) ||
    input.runAttempt < 1 ||
    input.runAttempt > 1_000
  ) {
    fail("runAttempt is out of range");
  }
  if (!input.ref.startsWith("refs/") || input.ref.length > 256)
    fail("ref is invalid");

  const isProduction = input.profile.startsWith("production-");
  const environment = isProduction ? "production" : "preview";
  if (isProduction && input.eventName !== "workflow_run") {
    fail("production requires workflow_run");
  }
  if (!isProduction && input.eventName === "workflow_run") {
    fail("preview cannot use workflow_run");
  }

  let prNumber: number | null = null;
  let sourceRunId: string | null = null;
  let targets: TargetManifest[];
  if (isProduction) {
    if (!input.sourceRunId) fail("production requires sourceRunId");
    assertRunId(input.sourceRunId, "sourceRunId");
    sourceRunId = input.sourceRunId;
    const versionTag = `ci-${input.runId}-${input.runAttempt}`;
    targets =
      input.profile === "production-gateway"
        ? [
            gatewayTarget(
              "zevium-gateway",
              "production",
              PRODUCTION_CONVEX_URL,
              PRODUCTION_CONVEX_SITE_URL,
              versionTag,
              [],
            ),
          ]
        : [webTarget("zevium-dev", "production", versionTag, [])];
  } else {
    prNumber = assertPreviewNumber(input.prNumber);
    const versionTag = `preview-${input.runId}-${input.runAttempt}`;
    if (input.profile === "preview-cleanup") {
      targets = [
        {
          ...webTarget(`zevium-web-pr-${prNumber}`, "preview", null, []),
          allowedSecrets: [],
          assets: false,
          operations: ["script:delete"],
          workersDev: null,
        },
        {
          ...gatewayTarget(
            `zevium-gateway-pr-${prNumber}`,
            "preview",
            "https://unused.invalid",
            "https://unused.invalid",
            null,
            [],
          ),
          allowedSecrets: [],
          operations: ["script:delete"],
          plainTextBindings: [],
          workersDev: null,
        },
      ];
    } else if (input.profile === "preview-gateway") {
      const convex = validateConvexUrls(input.convexUrl, input.convexSiteUrl);
      targets = [
        gatewayTarget(
          `zevium-gateway-pr-${prNumber}`,
          "preview",
          convex.cloud,
          convex.site,
          versionTag,
          validateSecretDigests(input.secretDigests, [
            "CLERK_SECRET_KEY",
            "GATEWAY_INTERNAL_SECRET",
          ]),
        ),
      ];
    } else {
      targets = [
        webTarget(
          `zevium-web-pr-${prNumber}`,
          "preview",
          versionTag,
          validateSecretDigests(input.secretDigests, ["CLERK_SECRET_KEY"]),
        ),
      ];
    }
  }

  if (targets.some((target) => target.scriptName === BROKER_SCRIPT_NAME)) {
    fail("broker cannot target itself");
  }

  return {
    accountId: CLOUDFLARE_ACCOUNT_ID,
    environment,
    eventName: input.eventName,
    headSha: input.headSha,
    oidcSha: input.oidcSha,
    prNumber,
    profile: input.profile,
    ref: input.ref,
    repository: GITHUB_REPOSITORY,
    repositoryId: GITHUB_REPOSITORY_ID,
    repositoryOwnerId: GITHUB_REPOSITORY_OWNER_ID,
    runAttempt: input.runAttempt,
    runId: input.runId,
    schema: MANIFEST_SCHEMA,
    sourceRunId,
    targets,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseManifest(value: unknown): DeploymentManifest {
  if (!isRecord(value)) fail("body must be an object");
  assertExactKeys(
    value,
    [
      "accountId",
      "environment",
      "eventName",
      "headSha",
      "oidcSha",
      "prNumber",
      "profile",
      "ref",
      "repository",
      "repositoryId",
      "repositoryOwnerId",
      "runAttempt",
      "runId",
      "schema",
      "sourceRunId",
      "targets",
    ],
    "top-level",
  );

  const profiles: DeploymentProfile[] = [
    "preview-gateway",
    "preview-web",
    "preview-cleanup",
    "production-gateway",
    "production-web",
  ];
  if (
    typeof value.profile !== "string" ||
    !profiles.includes(value.profile as DeploymentProfile)
  ) {
    fail("profile is invalid");
  }
  if (
    typeof value.eventName !== "string" ||
    !["pull_request", "workflow_dispatch", "workflow_run"].includes(
      value.eventName,
    )
  ) {
    fail("eventName is invalid");
  }

  const firstTarget = Array.isArray(value.targets)
    ? value.targets[0]
    : undefined;
  const plainBindings =
    isRecord(firstTarget) && Array.isArray(firstTarget.plainTextBindings)
      ? firstTarget.plainTextBindings
      : [];
  const bindingMap = new Map<string, string>();
  for (const binding of plainBindings) {
    if (
      !isRecord(binding) ||
      typeof binding.name !== "string" ||
      typeof binding.text !== "string"
    ) {
      fail("plainTextBindings are invalid");
    }
    bindingMap.set(binding.name, binding.text);
  }

  const secretDigests: SecretBindingManifest[] = [];
  if (isRecord(firstTarget) && Array.isArray(firstTarget.allowedSecrets)) {
    for (const secret of firstTarget.allowedSecrets) {
      if (
        !isRecord(secret) ||
        typeof secret.name !== "string" ||
        typeof secret.sha256 !== "string"
      ) {
        fail("allowedSecrets are invalid");
      }
      secretDigests.push({ name: secret.name, sha256: secret.sha256 });
    }
  }

  const convexSiteUrl = bindingMap.get("CONVEX_SITE_URL");
  const convexUrl = bindingMap.get("CONVEX_URL");
  const rebuilt = buildManifest({
    ...(convexSiteUrl === undefined ? {} : { convexSiteUrl }),
    ...(convexUrl === undefined ? {} : { convexUrl }),
    eventName: value.eventName as DeploymentManifest["eventName"],
    headSha: String(value.headSha),
    oidcSha: String(value.oidcSha),
    ...(typeof value.prNumber === "number" ? { prNumber: value.prNumber } : {}),
    profile: value.profile as DeploymentProfile,
    ref: String(value.ref),
    runAttempt: Number(value.runAttempt),
    runId: String(value.runId),
    ...(secretDigests.length === 0 ? {} : { secretDigests }),
    ...(typeof value.sourceRunId === "string"
      ? { sourceRunId: value.sourceRunId }
      : {}),
  });

  if (canonicalJson(value) !== canonicalJson(rebuilt)) {
    fail("body does not match canonical policy");
  }
  return rebuilt;
}

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  fail("unsupported JSON value");
}

export async function manifestDigest(
  manifest: DeploymentManifest,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(manifest));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
