import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  buildFromEnvironment,
  isRecord,
  readResponseBounded,
  requiredEnvironment,
} from "./register.ts";
import type { DeploymentProfile, TargetManifest } from "../src/manifest.ts";

const PROFILE_VALUES: DeploymentProfile[] = [
  "preview-gateway",
  "preview-web",
  "production-gateway",
  "production-web",
];
const VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail(message: string): never {
  throw new Error(`Exact Cloudflare publication failed: ${message}`);
}

function profileArgument(argv: string[]): DeploymentProfile {
  if (argv.length !== 2 || argv[0] !== "--profile") {
    fail("usage: publish.ts --profile <deployment-profile>");
  }
  const profile = argv[1];
  if (!profile || !PROFILE_VALUES.includes(profile as DeploymentProfile)) {
    fail("profile is invalid");
  }
  return profile as DeploymentProfile;
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

async function apiRequest(
  configuration: ReturnType<typeof apiConfiguration>,
  path: string,
  init: RequestInit = {},
  authorization = configuration.oidcToken,
): Promise<{ response: Response; value: unknown }> {
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
  if (response.status < 200 || response.status >= 300) {
    const code =
      isRecord(value) &&
      isRecord(value.error) &&
      typeof value.error.code === "string"
        ? value.error.code
        : `http_${response.status}`;
    fail(`broker rejected request (${code})`);
  }
  return { response, value };
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
  ];
}

async function existingMigrationTag(
  configuration: ReturnType<typeof apiConfiguration>,
  accountId: string,
  target: TargetManifest,
): Promise<string | undefined> {
  if (target.migration === null) return undefined;
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
  const requestedCount = (result.buckets as unknown[][]).reduce(
    (total, bucket) => total + bucket.length,
    0,
  );
  let completionJwt: string | undefined =
    requestedCount === 0 ? initialJwt : undefined;
  const byHash = new Map(
    target.staticAssets.map((asset) => [asset.cloudflareHash, asset]),
  );
  const requested = new Set<string>();
  for (const bucket of result.buckets as unknown[][]) {
    const form = new FormData();
    for (const value of bucket) {
      if (typeof value !== "string" || requested.has(value)) {
        fail("asset bucket contains invalid or duplicate hash");
      }
      const asset = byHash.get(value);
      if (!asset) fail("asset bucket requested undeclared hash");
      requested.add(value);
      const bytes = await readFile(
        artifactPath(assetRoot, asset.path.slice(1)),
      );
      form.append(
        value,
        new Blob([Buffer.from(bytes).toString("base64")], {
          type: asset.contentType,
        }),
        value,
      );
    }
    if (bucket.length === 0) continue;
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
  const metadata = {
    annotations: { "workers/tag": target.versionTag },
    ...(assetsJwt === undefined
      ? {}
      : { assets: { config: {}, jwt: assetsJwt } }),
    bindings: metadataBindings(target),
    compatibility_date: target.compatibilityDate,
    compatibility_flags: target.compatibilityFlags,
    main_module: target.mainModule,
    ...(target.migration !== null && migrationTag === undefined
      ? {
          migrations: {
            new_tag: target.migration.tag,
            steps: [{ new_sqlite_classes: target.migration.newSqliteClasses }],
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
): Promise<void> {
  await apiRequest(
    configuration,
    `/accounts/${accountId}/workers/scripts/${target.scriptName}/deployments`,
    {
      body: JSON.stringify({
        annotations: {
          "workers/message": `Zevium exact release ${target.versionTag}`,
        },
        strategy: "percentage",
        versions: [{ percentage: 100, version_id: versionId }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
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
}

export async function publishProfile(
  profile: DeploymentProfile,
): Promise<void> {
  const manifest = await buildFromEnvironment(profile);
  const target = manifest.targets[0];
  if (!target || target.operations.includes("script:delete")) {
    fail("profile does not authorize publication");
  }
  const configuration = apiConfiguration();
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
  await deployVersion(configuration, manifest.accountId, target, versionId);
  process.stdout.write(
    `Published sealed ${target.component} version ${versionId} as ${target.versionTag}\n`,
  );
}

if (import.meta.main) {
  await publishProfile(profileArgument(process.argv.slice(2)));
}
