import { chmod, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildFromEnvironment,
  isRecord,
  readResponseBounded,
  readRecoveryReceipt,
  requiredEnvironment,
} from "./register.ts";
import type { DeploymentProfile, TargetManifest } from "../src/manifest.ts";
import { manifestDigest } from "../src/manifest.ts";
import {
  DEPLOYMENT_RECEIPT_SCHEMA,
  type DeploymentReceipt,
} from "../src/receipt.ts";

const PROFILE_VALUES: DeploymentProfile[] = [
  "preview-gateway",
  "preview-web",
  "staging-gateway",
  "staging-web",
  "production-gateway",
  "production-web",
];
const VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERIFICATION_RETRY_DELAYS_MS = [100, 250, 500, 1_000] as const;
const DEPLOYMENT_ID_PATTERN = VERSION_ID_PATTERN;

function fail(message: string): never {
  throw new Error(`Exact Cloudflare publication failed: ${message}`);
}

function safeReceiptPath(input: string): string {
  const path = resolve(input);
  if (path === resolve("/") || path === resolve(process.cwd())) {
    fail("receipt path is unsafe");
  }
  return path;
}

async function writeReceipt(pathInput: string, receipt: DeploymentReceipt) {
  const path = safeReceiptPath(pathInput);
  const parent = dirname(path);
  const parentState = await lstat(parent).catch(() => null);
  const currentState = await lstat(path).catch(() => null);
  if (
    !parentState?.isDirectory() ||
    parentState.isSymbolicLink() ||
    (parentState.mode & 0o022) !== 0 ||
    currentState?.isSymbolicLink() ||
    (currentState !== null && !currentState.isFile())
  ) {
    fail("receipt path is not a protected regular-file location");
  }
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "wx", 0o600);
  let durable = false;
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await handle.sync();
    durable = true;
  } finally {
    await handle.close();
    if (!durable) await rm(temporary, { force: true });
  }
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  const directory = await open(parent, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  const state = await lstat(path);
  if (!state.isFile() || state.isSymbolicLink() || (state.mode & 0o077) !== 0) {
    fail("receipt permissions are unsafe");
  }
}

function artifactDigests(target: TargetManifest) {
  return {
    modules: target.modules.map(({ name, sha256 }) => ({ name, sha256 })),
    staticAssets: target.staticAssets.map(({ path, sha256 }) => ({
      path,
      sha256,
    })),
  };
}

interface PublishArguments {
  profile: DeploymentProfile;
  recoveryReceiptPath?: string;
  receiptPath?: string;
}

function publishArguments(argv: string[]): PublishArguments {
  let profile: string | undefined;
  let recoveryReceiptPath: string | undefined;
  let receiptPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profile" && profile === undefined) {
      profile = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--receipt" && receiptPath === undefined) {
      receiptPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--recover" && recoveryReceiptPath === undefined) {
      recoveryReceiptPath = argv[index + 1];
      index += 1;
      continue;
    }
    fail(
      "usage: publish.ts --profile <deployment-profile> [--receipt <path>] [--recover <failed-receipt>]",
    );
  }
  if (!profile || !PROFILE_VALUES.includes(profile as DeploymentProfile)) {
    fail("profile is invalid");
  }
  if (receiptPath === "") fail("receipt path is invalid");
  if (recoveryReceiptPath === "") fail("recovery receipt path is invalid");
  if (profile.startsWith("staging-") && !receiptPath) {
    fail("staging publication requires a receipt path");
  }
  if (
    recoveryReceiptPath &&
    (!profile.startsWith("staging-") || !receiptPath)
  ) {
    fail("recovery is staging-only and requires a new receipt path");
  }
  if (
    recoveryReceiptPath &&
    receiptPath &&
    resolve(recoveryReceiptPath) === resolve(receiptPath)
  ) {
    fail("recovery output cannot overwrite source receipt");
  }
  return {
    profile: profile as DeploymentProfile,
    ...(recoveryReceiptPath === undefined ? {} : { recoveryReceiptPath }),
    ...(receiptPath === undefined ? {} : { receiptPath }),
  };
}

function apiConfiguration(): { base: string; oidcToken: string } {
  const base = new URL(requiredEnvironment("CLOUDFLARE_API_BASE_URL"));
  if (
    base.origin !== "https://deploy-broker.zevium.dev" ||
    !/^\/sessions\/[0-9a-f]{64}\/client\/v4$/.test(base.pathname) ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  ) {
    fail("broker API base URL is invalid");
  }
  return {
    base: base.toString().replace(/\/$/, ""),
    oidcToken: requiredEnvironment("CLOUDFLARE_API_TOKEN"),
  };
}

function envelopeResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || value.success !== true || !isRecord(value.result)) {
    fail("Cloudflare API response envelope is invalid");
  }
  return value.result;
}

function usesSingleAssetUpload(jwt: string): boolean {
  const payload = jwt.split(".")[1];
  if (!payload || payload.length > 8_192 || !/^[A-Za-z0-9_-]+$/.test(payload)) {
    return false;
  }
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.byteLength > 6_144) return false;
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    return isRecord(value) && value.wrangler_single_asset_uploads === true;
  } catch {
    return false;
  }
}

async function apiRequest(
  configuration: ReturnType<typeof apiConfiguration>,
  path: string,
  init: RequestInit = {},
  authorization = configuration.oidcToken,
): Promise<{ response: Response; value: unknown }> {
  for (let attempt = 0; ; attempt += 1) {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("authorization", `Bearer ${authorization}`);
    const response = await fetch(`${configuration.base}${path}`, {
      ...init,
      headers,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      fail("redirect was rejected");
    }
    const value = await readResponseBounded(response, 2 * 1024 * 1024);
    if (response.status >= 200 && response.status < 300) {
      return { response, value };
    }
    const code =
      isRecord(value) &&
      isRecord(value.error) &&
      typeof value.error.code === "string"
        ? value.error.code
        : `http_${response.status}`;
    const retryDelay = VERIFICATION_RETRY_DELAYS_MS[attempt];
    if (
      retryDelay !== undefined &&
      (code === "version_verification_pending" ||
        code === "deployment_verification_pending" ||
        code === "recovery_verification_pending")
    ) {
      await delay(retryDelay);
      continue;
    }
    fail(`broker rejected request (${code})`);
  }
}

function artifactPath(rootInput: string, name: string): string {
  const root = resolve(rootInput);
  const path = resolve(root, ...name.split("/"));
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    fail("artifact path escaped inventory root");
  }
  return path;
}

function metadataBindings(
  target: TargetManifest,
): Array<Record<string, string>> {
  return [
    ...target.plainTextBindings.map((binding) => ({
      name: binding.name,
      text: binding.text,
      type: "plain_text",
    })),
    ...target.durableObjectBindings.map((binding) => ({
      class_name: binding.className,
      name: binding.name,
      type: "durable_object_namespace",
    })),
    ...target.allowedSecrets.map((binding) => ({
      name: binding.name,
      text: requiredEnvironment(binding.name),
      type: "secret_text",
    })),
    { name: target.versionMetadataBinding, type: "version_metadata" },
  ];
}

async function existingMigrationTag(
  configuration: ReturnType<typeof apiConfiguration>,
  accountId: string,
  target: TargetManifest,
): Promise<string | undefined> {
  if (target.migrations.length === 0) return undefined;
  const response = await fetch(
    `${configuration.base}/accounts/${accountId}/workers/services/${target.scriptName}`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${configuration.oidcToken}`,
      },
      redirect: "manual",
    },
  );
  if (response.status === 404) {
    await response.body?.cancel("target does not exist");
    return undefined;
  }
  if (response.status >= 300 && response.status < 400)
    fail("redirect rejected");
  const value = await readResponseBounded(response, 512 * 1024);
  if (response.status !== 200) fail("target lifecycle read failed");
  const result = envelopeResult(value);
  const environment = result.default_environment;
  const script = isRecord(environment) ? environment.script : undefined;
  const tag = isRecord(script) ? script.migration_tag : undefined;
  if (tag !== undefined && typeof tag !== "string") {
    fail("target migration tag is invalid");
  }
  return tag;
}

async function activeDeployment(
  configuration: ReturnType<typeof apiConfiguration>,
  accountId: string,
  target: TargetManifest,
): Promise<{ deploymentId: string | null; versionId: string | null }> {
  const read = await apiRequest(
    configuration,
    `/accounts/${accountId}/workers/scripts/${target.scriptName}/deployments`,
  );
  const deployments = envelopeResult(read.value).deployments;
  if (!Array.isArray(deployments) || deployments.length === 0) {
    return { deploymentId: null, versionId: null };
  }
  const latest = deployments[0];
  const version =
    isRecord(latest) && Array.isArray(latest.versions)
      ? latest.versions[0]
      : undefined;
  if (
    !isRecord(latest) ||
    typeof latest.id !== "string" ||
    !DEPLOYMENT_ID_PATTERN.test(latest.id) ||
    latest.strategy !== "percentage" ||
    !Array.isArray(latest.versions) ||
    latest.versions.length !== 1 ||
    !isRecord(version) ||
    typeof version.version_id !== "string" ||
    !VERSION_ID_PATTERN.test(version.version_id) ||
    version.percentage !== 100
  ) {
    fail("active deployment state is not one immutable version at 100%");
  }
  return { deploymentId: latest.id, versionId: version.version_id };
}

async function uploadAssets(
  configuration: ReturnType<typeof apiConfiguration>,
  accountId: string,
  target: TargetManifest,
): Promise<string | undefined> {
  if (!target.assets) return undefined;
  const assetRoot = requiredEnvironment("DEPLOY_ASSET_ROOT");
  const manifest = Object.fromEntries(
    target.staticAssets.map((asset) => [
      asset.path,
      { hash: asset.cloudflareHash, size: asset.size },
    ]),
  );
  const initialization = await apiRequest(
    configuration,
    `/accounts/${accountId}/workers/scripts/${target.scriptName}/assets-upload-session`,
    {
      body: JSON.stringify({ manifest }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  const result = envelopeResult(initialization.value);
  if (
    typeof result.jwt !== "string" ||
    !Array.isArray(result.buckets) ||
    !result.buckets.every((bucket) => Array.isArray(bucket))
  ) {
    fail("asset upload session is invalid");
  }
  const initialJwt = result.jwt;
  const byHash = new Map(
    target.staticAssets.map((asset) => [asset.cloudflareHash, asset]),
  );
  const requested = new Set<string>();
  const buckets = (result.buckets as unknown[][]).map((bucket) =>
    bucket.map((value) => {
      if (typeof value !== "string" || requested.has(value)) {
        fail("asset bucket contains invalid or duplicate hash");
      }
      const asset = byHash.get(value);
      if (!asset) fail("asset bucket requested undeclared hash");
      requested.add(value);
      return asset;
    }),
  );
  let completionJwt: string | undefined =
    requested.size === 0 ? initialJwt : undefined;
  const singleAssetUpload = usesSingleAssetUpload(initialJwt);
  const uploadBuckets = singleAssetUpload
    ? buckets.flat().map((asset) => [asset])
    : buckets;
  for (const bucket of uploadBuckets) {
    if (bucket.length === 0) continue;
    if (singleAssetUpload) {
      const asset = bucket[0];
      if (!asset) fail("single asset bucket is empty");
      const bytes = await readFile(
        artifactPath(assetRoot, asset.path.slice(1)),
      );
      const upload = await apiRequest(
        configuration,
        `/accounts/${accountId}/workers/assets/upload/${asset.cloudflareHash}`,
        {
          body: Uint8Array.from(bytes).buffer,
          headers: {
            "content-length": String(bytes.byteLength),
            "content-type": asset.contentType,
          },
          method: "POST",
        },
        initialJwt,
      );
      const uploadResult = envelopeResult(upload.value);
      if (uploadResult.jwt !== undefined) {
        if (typeof uploadResult.jwt !== "string") {
          fail("asset completion token is invalid");
        }
        completionJwt = uploadResult.jwt;
      }
      continue;
    }

    const form = new FormData();
    for (const asset of bucket) {
      const bytes = await readFile(
        artifactPath(assetRoot, asset.path.slice(1)),
      );
      form.append(
        asset.cloudflareHash,
        new Blob([Buffer.from(bytes).toString("base64")], {
          type: asset.contentType,
        }),
        asset.cloudflareHash,
      );
    }
    const upload = await apiRequest(
      configuration,
      `/accounts/${accountId}/workers/assets/upload?base64=true`,
      { body: form, method: "POST" },
      initialJwt,
    );
    const uploadResult = envelopeResult(upload.value);
    if (uploadResult.jwt !== undefined) {
      if (typeof uploadResult.jwt !== "string") {
        fail("asset completion token is invalid");
      }
      completionJwt = uploadResult.jwt;
    }
  }
  if (!completionJwt) fail("asset upload did not return completion token");
  return completionJwt;
}

async function uploadVersion(
  configuration: ReturnType<typeof apiConfiguration>,
  accountId: string,
  target: TargetManifest,
  assetsJwt: string | undefined,
): Promise<string> {
  if (!target.mainModule || !target.versionTag)
    fail("target is not publishable");
  const migrationTag = await existingMigrationTag(
    configuration,
    accountId,
    target,
  );
  const migrationStart =
    migrationTag === undefined
      ? 0
      : target.migrations.findIndex(
          (migration) => migration.tag === migrationTag,
        ) + 1;
  if (migrationTag !== undefined && migrationStart === 0) {
    fail("target migration tag is outside signed lifecycle");
  }
  const pendingMigrations = target.migrations.slice(migrationStart);
  const finalMigration = target.migrations.at(-1);
  const metadata = {
    annotations: { "workers/tag": target.versionTag },
    ...(assetsJwt === undefined
      ? {}
      : { assets: { config: {}, jwt: assetsJwt } }),
    bindings: metadataBindings(target),
    compatibility_date: target.compatibilityDate,
    compatibility_flags: target.compatibilityFlags,
    main_module: target.mainModule,
    ...(pendingMigrations.length > 0 && finalMigration
      ? {
          migrations: {
            ...(migrationTag === undefined ? {} : { old_tag: migrationTag }),
            new_tag: finalMigration.tag,
            steps: pendingMigrations.map((migration) => ({
              new_sqlite_classes: migration.newSqliteClasses,
            })),
          },
        }
      : {}),
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  const moduleRoot = requiredEnvironment("DEPLOY_MODULE_ROOT");
  for (const module of target.modules) {
    const bytes = await readFile(artifactPath(moduleRoot, module.name));
    form.append(
      module.name,
      new Blob([bytes], { type: module.contentType }),
      module.name,
    );
  }
  const upload = await apiRequest(
    configuration,
    `/accounts/${accountId}/workers/scripts/${target.scriptName}/versions`,
    { body: form, method: "POST" },
  );
  const versionId = envelopeResult(upload.value).id;
  if (typeof versionId !== "string" || !VERSION_ID_PATTERN.test(versionId)) {
    fail("version upload returned invalid ID");
  }
  return versionId;
}

async function deployVersion(
  configuration: ReturnType<typeof apiConfiguration>,
  accountId: string,
  target: TargetManifest,
  versionId: string,
  recovery = false,
): Promise<{
  deploymentId: string;
  recoveryMode?: "already_active" | "redeployed_prior";
  recoveryReleaseSha?: string;
}> {
  const deployment = await apiRequest(
    configuration,
    `/accounts/${accountId}/workers/scripts/${target.scriptName}/deployments`,
    {
      body: JSON.stringify({
        annotations: {
          "workers/message": recovery
            ? `Zevium compatible prior recovery ${versionId}`
            : `Zevium exact release ${target.versionTag}`,
        },
        strategy: "percentage",
        versions: [{ percentage: 100, version_id: versionId }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  const deploymentId = envelopeResult(deployment.value).id;
  const recoveryMode = envelopeResult(deployment.value).recovery_mode;
  const recoveryReleaseSha = envelopeResult(
    deployment.value,
  ).recovery_release_sha;
  if (
    typeof deploymentId !== "string" ||
    !DEPLOYMENT_ID_PATTERN.test(deploymentId)
  ) {
    fail("deployment returned invalid ID");
  }
  if (
    recoveryReleaseSha !== undefined &&
    (typeof recoveryReleaseSha !== "string" ||
      !/^[0-9a-f]{40}$/.test(recoveryReleaseSha))
  ) {
    fail("deployment returned invalid recovery release SHA");
  }
  if (
    recoveryMode !== undefined &&
    recoveryMode !== "already_active" &&
    recoveryMode !== "redeployed_prior"
  ) {
    fail("deployment returned invalid recovery mode");
  }
  if (target.workersDev) {
    await apiRequest(
      configuration,
      `/accounts/${accountId}/workers/scripts/${target.scriptName}/subdomain`,
      {
        body: JSON.stringify({
          enabled: target.workersDev.enabled,
          previews_enabled: target.workersDev.previewsEnabled,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
  }
  return {
    deploymentId,
    ...(recoveryMode === undefined ? {} : { recoveryMode }),
    ...(recoveryReleaseSha === undefined ? {} : { recoveryReleaseSha }),
  };
}

export async function publishProfile(
  profile: DeploymentProfile,
  options: { receiptPath?: string; recoveryReceiptPath?: string } = {},
): Promise<void> {
  if (profile.startsWith("staging-") && !options.receiptPath) {
    fail("staging publication requires a receipt path");
  }
  const recoveryReceipt = options.recoveryReceiptPath
    ? await readRecoveryReceipt(options.recoveryReceiptPath)
    : undefined;
  if (recoveryReceipt && !options.receiptPath) {
    fail("recovery requires a new receipt path");
  }
  if (
    recoveryReceipt &&
    options.receiptPath &&
    resolve(options.recoveryReceiptPath!) === resolve(options.receiptPath)
  ) {
    fail("recovery output cannot overwrite source receipt");
  }
  const manifest = await buildFromEnvironment(
    profile,
    recoveryReceipt === undefined ? {} : { recoveryReceipt },
  );
  const digest = await manifestDigest(manifest);
  if (requiredEnvironment("CLOUDFLARE_DEPLOY_MANIFEST_DIGEST") !== digest) {
    fail("broker session is not bound to rebuilt deployment manifest");
  }
  const target = manifest.targets[0];
  if (!target || target.operations.includes("script:delete")) {
    fail("profile does not authorize publication");
  }
  const configuration = apiConfiguration();
  const prior = recoveryReceipt
    ? {
        deploymentId: recoveryReceipt.receipt.priorDeploymentId,
        versionId: recoveryReceipt.receipt.priorVersionId,
      }
    : await activeDeployment(configuration, manifest.accountId, target);
  const receiptPath = options.receiptPath;
  const receipt: DeploymentReceipt = {
    artifactDigests: artifactDigests(target),
    createdAt: new Date().toISOString(),
    deploymentId: null,
    gitSha: manifest.headSha,
    manifestDigest: digest,
    phase: recoveryReceipt ? "recovery_prepared" : "prepared",
    priorDeploymentId: prior.deploymentId,
    priorVersionId: prior.versionId,
    profile,
    recovery: recoveryReceipt
      ? {
          failedDeploymentId: recoveryReceipt.receipt.deploymentId,
          failedGitSha: recoveryReceipt.receipt.gitSha,
          failedVersionId: recoveryReceipt.receipt.versionId,
          mode: null,
          sourceReceiptDigest: recoveryReceipt.digest,
        }
      : null,
    schema: DEPLOYMENT_RECEIPT_SCHEMA,
    target: target.scriptName,
    versionId: recoveryReceipt?.receipt.priorVersionId ?? null,
  };
  if (receiptPath) await writeReceipt(receiptPath, receipt);
  if (recoveryReceipt) {
    const priorVersionId = recoveryReceipt.receipt.priorVersionId;
    if (!priorVersionId) fail("recovery receipt has no prior version");
    const recovered = await deployVersion(
      configuration,
      manifest.accountId,
      target,
      priorVersionId,
      true,
    );
    receipt.deploymentId = recovered.deploymentId;
    receipt.phase = "recovered";
    if (
      !receipt.recovery ||
      !recovered.recoveryMode ||
      !recovered.recoveryReleaseSha
    ) {
      fail("broker omitted recovery outcome");
    }
    receipt.recovery.mode = recovered.recoveryMode;
    receipt.gitSha = recovered.recoveryReleaseSha;
    await writeReceipt(receiptPath!, receipt);
    process.stdout.write(
      `Recovered ${target.component} to compatible prior version ${priorVersionId} (${recovered.recoveryMode})\n`,
    );
    return;
  }
  const assetsJwt = await uploadAssets(
    configuration,
    manifest.accountId,
    target,
  );
  const versionId = await uploadVersion(
    configuration,
    manifest.accountId,
    target,
    assetsJwt,
  );
  receipt.phase = "version_uploaded";
  receipt.versionId = versionId;
  if (receiptPath) await writeReceipt(receiptPath, receipt);
  const deployment = await deployVersion(
    configuration,
    manifest.accountId,
    target,
    versionId,
  );
  receipt.deploymentId = deployment.deploymentId;
  receipt.phase = "activated";
  if (receiptPath) await writeReceipt(receiptPath, receipt);
  process.stdout.write(
    `Published sealed ${target.component} version ${versionId} as ${target.versionTag}\n`,
  );
}

if (import.meta.main) {
  const arguments_ = publishArguments(process.argv.slice(2));
  await publishProfile(arguments_.profile, {
    ...(arguments_.recoveryReceiptPath === undefined
      ? {}
      : { recoveryReceiptPath: arguments_.recoveryReceiptPath }),
    ...(arguments_.receiptPath === undefined
      ? {}
      : { receiptPath: arguments_.receiptPath }),
  });
}
