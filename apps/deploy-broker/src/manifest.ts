import { BrokerError } from "./errors.ts";

export const MANIFEST_SCHEMA = "zevium.cloudflare-deploy/v2" as const;
export const AUDIENCE_PREFIX = "urn:zevium:cloudflare-deploy:v2:";
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
  | "service:read"
  | "script:upload"
  | "subdomain:write";

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

export interface ModuleArtifactManifest {
  contentType: string;
  name: string;
  sha256: string;
  size: number;
}

export interface StaticAssetArtifactManifest {
  cloudflareHash: string;
  contentType: string;
  path: string;
  sha256: string;
  size: number;
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
  mainModule: null | string;
  modules: ModuleArtifactManifest[];
  operations: ManifestOperation[];
  plainTextBindings: PlainTextBindingManifest[];
  scriptName: string;
  staticAssets: StaticAssetArtifactManifest[];
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
  mainModule?: string;
  modules?: ModuleArtifactManifest[];
  oidcSha: string;
  prNumber?: number;
  profile: DeploymentProfile;
  ref: string;
  runAttempt: number;
  runId: string;
  secretDigests?: SecretBindingManifest[];
  sourceRunId?: string;
  staticAssets?: StaticAssetArtifactManifest[];
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const CONVEX_DEPLOYMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ASSET_HASH_PATTERN = /^[0-9a-f]{32}$/;
const MODULE_CONTENT_TYPES = new Set([
  "application/javascript",
  "application/javascript+module",
  "application/octet-stream",
  "application/python",
  "application/wasm",
  "text/plain",
]);
const MAX_MANIFEST_BYTES = 96 * 1024;

const STATIC_ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  apng: "image/apng",
  avif: "image/avif",
  css: "text/css; charset=utf-8",
  gif: "image/gif",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  mjs: "text/javascript; charset=utf-8",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  otf: "font/otf",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  webm: "video/webm",
  webmanifest: "application/manifest+json",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml",
};

export function staticAssetContentType(path: string): string {
  const filename = path.split("/").at(-1) ?? "";
  const extension = filename.includes(".")
    ? (filename.split(".").at(-1) ?? "").toLowerCase()
    : "";
  return STATIC_ASSET_CONTENT_TYPES[extension] ?? "application/octet-stream";
}

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

function safeModuleName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 512 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("%") &&
    value
      .split("/")
      .every(
        (segment) =>
          segment !== "" &&
          segment !== "." &&
          segment !== ".." &&
          /^[A-Za-z0-9@+_.-]+$/.test(segment),
      )
  );
}

function validateModules(
  values: ModuleArtifactManifest[] | undefined,
  mainModule: string | undefined,
  required: boolean,
): { mainModule: string | null; modules: ModuleArtifactManifest[] } {
  const modules = values ?? [];
  if (!required) {
    if (modules.length !== 0 || mainModule !== undefined) {
      fail("cleanup cannot declare executable modules");
    }
    return { mainModule: null, modules: [] };
  }
  if (
    !mainModule ||
    !safeModuleName(mainModule) ||
    modules.length < 1 ||
    modules.length > 1_000
  ) {
    fail("module inventory is missing or invalid");
  }
  const names = new Set<string>();
  let totalBytes = 0;
  const canonical = modules.map((module) => {
    if (
      !safeModuleName(module.name) ||
      !MODULE_CONTENT_TYPES.has(module.contentType) ||
      !DIGEST_PATTERN.test(module.sha256) ||
      !Number.isSafeInteger(module.size) ||
      module.size < 0 ||
      module.size > 32 * 1024 * 1024 ||
      names.has(module.name)
    ) {
      fail("module inventory entry is invalid");
    }
    names.add(module.name);
    totalBytes += module.size;
    if (totalBytes > 32 * 1024 * 1024) fail("module inventory is too large");
    return {
      contentType: module.contentType,
      name: module.name,
      sha256: module.sha256,
      size: module.size,
    };
  });
  if (!names.has(mainModule)) fail("main module is not in module inventory");
  return {
    mainModule,
    modules: canonical.sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  };
}

function validateStaticAssets(
  values: StaticAssetArtifactManifest[] | undefined,
  required: boolean,
): StaticAssetArtifactManifest[] {
  const assets = values ?? [];
  if (!required) {
    if (assets.length !== 0) fail("profile cannot declare static assets");
    return [];
  }
  if (assets.length > 1_500) {
    fail("static asset inventory count is invalid");
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  const canonical = assets.map((asset) => {
    if (
      !asset.path.startsWith("/") ||
      asset.path.length > 1_024 ||
      asset.path.includes("\\") ||
      asset.path.includes("%") ||
      asset.path.includes("//") ||
      asset.path
        .split("/")
        .some((segment) => segment === "." || segment === "..") ||
      paths.has(asset.path) ||
      !ASSET_HASH_PATTERN.test(asset.cloudflareHash) ||
      asset.contentType !== staticAssetContentType(asset.path) ||
      !DIGEST_PATTERN.test(asset.sha256) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0 ||
      asset.size > 25 * 1024 * 1024
    ) {
      fail("static asset inventory entry is invalid");
    }
    paths.add(asset.path);
    totalBytes += asset.size;
    if (totalBytes > 96 * 1024 * 1024) {
      fail("static asset inventory is too large");
    }
    return {
      cloudflareHash: asset.cloudflareHash,
      contentType: asset.contentType,
      path: asset.path,
      sha256: asset.sha256,
      size: asset.size,
    };
  });
  return canonical.sort((left, right) => left.path.localeCompare(right.path));
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
  artifacts: ReturnType<typeof validateModules>,
): TargetManifest {
  return {
    allowedSecrets,
    assets: false,
    compatibilityDate: "2025-04-01",
    compatibilityFlags: ["global_fetch_strictly_public"],
    component: "gateway",
    durableObjectBindings: [{ className: "WalletDO", name: "WALLET" }],
    migration: { newSqliteClasses: ["WalletDO"], tag: "v1" },
    mainModule: artifacts.mainModule,
    modules: artifacts.modules,
    operations:
      mode === "preview"
        ? [
            "deployment:create",
            "service:read",
            "script:upload",
            "subdomain:write",
          ]
        : ["deployment:create", "service:read", "script:upload"],
    plainTextBindings: [
      { name: "CONVEX_SITE_URL", text: convexSiteUrl },
      { name: "CONVEX_URL", text: convexUrl },
    ],
    scriptName,
    staticAssets: [],
    versionTag,
    workersDev:
      mode === "preview" ? { enabled: true, previewsEnabled: true } : null,
  };
}

function webTarget(
  scriptName: string,
  mode: "preview" | "production",
  versionTag: string | null,
  artifacts: ReturnType<typeof validateModules>,
  staticAssets: StaticAssetArtifactManifest[],
  declaredSecret: SecretBindingManifest | null,
): TargetManifest {
  return {
    allowedSecrets: declaredSecret === null ? [] : [declaredSecret],
    assets: true,
    compatibilityDate: "2026-07-18",
    compatibilityFlags: ["nodejs_compat"],
    component: "web",
    durableObjectBindings: [],
    migration: null,
    mainModule: artifacts.mainModule,
    modules: artifacts.modules,
    operations:
      mode === "preview"
        ? [
            "assets:upload",
            "deployment:create",
            "script:upload",
            "subdomain:write",
          ]
        : ["assets:upload", "deployment:create", "script:upload"],
    plainTextBindings: [],
    scriptName,
    staticAssets,
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
  const cleanup = input.profile === "preview-cleanup";
  const artifacts = validateModules(input.modules, input.mainModule, !cleanup);
  const staticAssets = validateStaticAssets(
    input.staticAssets,
    !cleanup && input.profile.endsWith("-web"),
  );
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
              validateSecretDigests(input.secretDigests, [
                "CLERK_SECRET_KEY",
                "GATEWAY_INTERNAL_SECRET",
              ]),
              artifacts,
            ),
          ]
        : [
            webTarget(
              "zevium-dev",
              "production",
              versionTag,
              artifacts,
              staticAssets,
              validateSecretDigests(input.secretDigests, [
                "CLERK_SECRET_KEY",
              ])[0] ?? fail("production web secret digest is missing"),
            ),
          ];
  } else {
    prNumber = assertPreviewNumber(input.prNumber);
    const versionTag = `preview-${input.runId}-${input.runAttempt}`;
    if (input.profile === "preview-cleanup") {
      targets = [
        {
          ...webTarget(
            `zevium-web-pr-${prNumber}`,
            "preview",
            null,
            { mainModule: null, modules: [] },
            [],
            null,
          ),
          allowedSecrets: [],
          assets: false,
          operations: ["script:delete"],
          workersDev: null,
          mainModule: null,
          modules: [],
          staticAssets: [],
        },
        {
          ...gatewayTarget(
            `zevium-gateway-pr-${prNumber}`,
            "preview",
            "https://unused.invalid",
            "https://unused.invalid",
            null,
            [],
            { mainModule: null, modules: [] },
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
          artifacts,
        ),
      ];
    } else {
      targets = [
        webTarget(
          `zevium-web-pr-${prNumber}`,
          "preview",
          versionTag,
          artifacts,
          staticAssets,
          validateSecretDigests(input.secretDigests, ["CLERK_SECRET_KEY"])[0] ??
            fail("preview web secret digest is missing"),
        ),
      ];
    }
  }

  if (targets.some((target) => target.scriptName === BROKER_SCRIPT_NAME)) {
    fail("broker cannot target itself");
  }

  const manifest: DeploymentManifest = {
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
  if (
    new TextEncoder().encode(canonicalJson(manifest)).byteLength >
    MAX_MANIFEST_BYTES
  ) {
    fail("serialized manifest is too large");
  }
  return manifest;
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
  const modules =
    isRecord(firstTarget) && Array.isArray(firstTarget.modules)
      ? (firstTarget.modules as ModuleArtifactManifest[])
      : [];
  const mainModule =
    isRecord(firstTarget) && typeof firstTarget.mainModule === "string"
      ? firstTarget.mainModule
      : undefined;
  const staticAssets =
    isRecord(firstTarget) && Array.isArray(firstTarget.staticAssets)
      ? (firstTarget.staticAssets as StaticAssetArtifactManifest[])
      : [];
  const rebuilt = buildManifest({
    ...(convexSiteUrl === undefined ? {} : { convexSiteUrl }),
    ...(convexUrl === undefined ? {} : { convexUrl }),
    eventName: value.eventName as DeploymentManifest["eventName"],
    headSha: String(value.headSha),
    ...(mainModule === undefined ? {} : { mainModule }),
    ...(modules.length === 0 ? {} : { modules }),
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
    ...(staticAssets.length === 0 ? {} : { staticAssets }),
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
