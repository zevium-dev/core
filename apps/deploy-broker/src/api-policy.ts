import { BrokerError, invariant } from "./errors";
import {
  BROKER_SCRIPT_NAME,
  CLOUDFLARE_ACCOUNT_ID,
  type DeploymentManifest,
  type ManifestOperation,
  type TargetManifest,
} from "./manifest";
import { exactKeys, isRecord } from "./strict-json";

const SAFE_PATH_PATTERN = /^[\x21-\x7e]+$/;
const VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ASSET_HASH_PATTERN = /^[0-9a-f]{32}$/;

export type ApiRouteKind =
  | "asset-init"
  | "asset-upload-bulk"
  | "asset-upload-single"
  | "deployment-create"
  | "script-delete"
  | "script-list-synthetic"
  | "script-read"
  | "secret-put"
  | "subdomain-write"
  | "version-upload";

export interface ApiRoute {
  assetHash?: string;
  kind: ApiRouteKind;
  maximumBodyBytes: number;
  mutationKey?: string;
  target?: TargetManifest;
  versionId?: string;
}

export interface ValidatedAssetManifest {
  hashes: Record<string, number>;
  sha256ByHash: Record<string, string>;
  totalBytes: number;
}

export interface TargetScriptState {
  migrationTag?: string;
  scriptName: string;
}

function hasOperation(
  target: TargetManifest,
  operation: ManifestOperation,
): boolean {
  return target.operations.includes(operation);
}

function noBody(kind: ApiRouteKind, target?: TargetManifest): ApiRoute {
  return { kind, maximumBodyBytes: 0, ...(target ? { target } : {}) };
}

function targetFor(
  manifest: DeploymentManifest,
  scriptName: string,
): TargetManifest {
  invariant(
    scriptName !== BROKER_SCRIPT_NAME &&
      scriptName !== "zevium-deploy-broker-test",
    403,
    "self_target_rejected",
    "Deployment broker cannot target itself",
  );
  const target = manifest.targets.find(
    (candidate) => candidate.scriptName === scriptName,
  );
  invariant(
    target,
    403,
    "target_rejected",
    "Worker target is not declared in manifest",
  );
  return target;
}

function validatePath(pathname: string): void {
  invariant(
    pathname.startsWith("/") &&
      pathname.length <= 2_048 &&
      SAFE_PATH_PATTERN.test(pathname) &&
      !pathname.includes("%") &&
      !pathname.includes("\\") &&
      !pathname.includes("//"),
    400,
    "path_rejected",
    "Cloudflare API path is not canonical",
  );
  const segments = pathname.split("/");
  invariant(
    segments.every((segment) => segment !== "." && segment !== ".."),
    400,
    "path_rejected",
    "Cloudflare API path traversal was rejected",
  );
}

function requireQuery(actual: string, expected: string): void {
  invariant(
    actual === expected,
    400,
    "query_rejected",
    "Cloudflare API query is not declared in manifest",
  );
}

export function authorizeApiRoute(
  manifest: DeploymentManifest,
  method: string,
  pathname: string,
  search: string,
): ApiRoute {
  validatePath(pathname);
  invariant(
    ["DELETE", "GET", "POST", "PUT"].includes(method),
    405,
    "method_rejected",
    "HTTP method is not allowed",
  );
  const root = `/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers`;
  invariant(
    pathname.startsWith(`${root}/`),
    403,
    "account_rejected",
    "Cloudflare account is not authorized",
  );

  if (pathname === `${root}/scripts`) {
    invariant(
      method === "GET",
      405,
      "method_rejected",
      "Only script listing is allowed here",
    );
    requireQuery(search, "");
    invariant(
      manifest.targets.some((target) => hasOperation(target, "script:read")),
      403,
      "operation_rejected",
      "Script reads are not declared",
    );
    return noBody("script-list-synthetic");
  }

  if (pathname === `${root}/subdomain`) {
    invariant(
      method === "GET",
      405,
      "method_rejected",
      "Account subdomain is read-only",
    );
    requireQuery(search, "");
    invariant(
      manifest.targets.some((target) => hasOperation(target, "script:read")),
      403,
      "operation_rejected",
      "Script reads are not declared",
    );
    return noBody("script-read");
  }

  if (pathname === `${root}/assets/upload`) {
    const target = manifest.targets.find((candidate) => candidate.assets);
    invariant(
      target && hasOperation(target, "assets:upload"),
      403,
      "operation_rejected",
      "Asset upload is not declared",
    );
    invariant(
      method === "POST",
      405,
      "method_rejected",
      "Asset upload requires POST",
    );
    requireQuery(search, "?base64=true");
    return {
      kind: "asset-upload-bulk",
      maximumBodyBytes: 48 * 1024 * 1024,
      mutationKey: `asset-bulk:${target.scriptName}`,
      target,
    };
  }

  const singleAsset = new RegExp(`^${root}/assets/upload/([0-9a-f]{32})$`).exec(
    pathname,
  );
  if (singleAsset) {
    const target = manifest.targets.find((candidate) => candidate.assets);
    invariant(
      target && hasOperation(target, "assets:upload"),
      403,
      "operation_rejected",
      "Asset upload is not declared",
    );
    invariant(
      method === "POST",
      405,
      "method_rejected",
      "Asset upload requires POST",
    );
    requireQuery(search, "");
    const assetHash = singleAsset[1];
    invariant(
      assetHash && ASSET_HASH_PATTERN.test(assetHash),
      400,
      "asset_hash_rejected",
      "Asset hash is invalid",
    );
    return {
      assetHash,
      kind: "asset-upload-single",
      maximumBodyBytes: 25 * 1024 * 1024,
      mutationKey: `asset:${target.scriptName}:${assetHash}`,
      target,
    };
  }

  const service = new RegExp(
    `^${root}/services/([a-z0-9][a-z0-9-]{0,62})$`,
  ).exec(pathname);
  if (service) {
    const target = targetFor(manifest, service[1] ?? "");
    invariant(
      method === "GET" && hasOperation(target, "script:read"),
      403,
      "operation_rejected",
      "Service read is not declared",
    );
    requireQuery(search, "");
    return noBody("script-read", target);
  }

  const script = new RegExp(
    `^${root}/scripts/([a-z0-9][a-z0-9-]{0,62})(?:/(.*))?$`,
  ).exec(pathname);
  invariant(
    script,
    403,
    "endpoint_rejected",
    "Cloudflare API endpoint is not allowed",
  );
  const target = targetFor(manifest, script[1] ?? "");
  const suffix = script[2] ?? "";

  if (suffix === "") {
    requireQuery(search, "");
    if (method === "DELETE") {
      invariant(
        hasOperation(target, "script:delete"),
        403,
        "operation_rejected",
        "Script deletion is not declared",
      );
      return {
        kind: "script-delete",
        maximumBodyBytes: 0,
        mutationKey: `script-delete:${target.scriptName}`,
        target,
      };
    }
    throw new BrokerError(
      405,
      "method_rejected",
      "Script endpoint method is not allowed",
    );
  }

  if (
    ["settings", "secrets", "deployments", "subdomain"].includes(suffix) &&
    method === "GET"
  ) {
    invariant(
      hasOperation(target, "script:read"),
      403,
      "operation_rejected",
      "Script read is not declared",
    );
    requireQuery(search, "");
    return noBody("script-read", target);
  }

  if (suffix === "secrets" && method === "PUT") {
    invariant(
      hasOperation(target, "secret:put"),
      403,
      "operation_rejected",
      "Secret update is not declared",
    );
    requireQuery(search, "");
    return { kind: "secret-put", maximumBodyBytes: 128 * 1024, target };
  }

  if (suffix === "subdomain" && method === "POST") {
    invariant(
      hasOperation(target, "subdomain:write"),
      403,
      "operation_rejected",
      "Subdomain update is not declared",
    );
    requireQuery(search, "");
    return {
      kind: "subdomain-write",
      maximumBodyBytes: 1_024,
      mutationKey: `subdomain:${target.scriptName}`,
      target,
    };
  }

  if (suffix === "assets-upload-session" && method === "POST") {
    invariant(
      target.assets && hasOperation(target, "assets:upload"),
      403,
      "operation_rejected",
      "Asset session is not declared",
    );
    requireQuery(search, "");
    return {
      kind: "asset-init",
      maximumBodyBytes: 2 * 1024 * 1024,
      mutationKey: `asset-init:${target.scriptName}`,
      target,
    };
  }

  if (suffix === "versions" && method === "POST") {
    invariant(
      target.versionTag !== null && hasOperation(target, "script:upload"),
      403,
      "operation_rejected",
      "Version upload is not declared",
    );
    requireQuery(search, "?bindings_inherit=strict");
    return {
      kind: "version-upload",
      maximumBodyBytes: 32 * 1024 * 1024,
      mutationKey: `version-upload:${target.scriptName}`,
      target,
    };
  }

  if (suffix === "versions" && method === "GET") {
    invariant(
      hasOperation(target, "version:read"),
      403,
      "operation_rejected",
      "Version read is not declared",
    );
    requireQuery(search, "?deployable=true");
    return noBody("script-read", target);
  }

  const versionDetail = /^versions\/([0-9a-f-]+)$/.exec(suffix);
  if (versionDetail && method === "GET") {
    invariant(
      hasOperation(target, "version:read"),
      403,
      "operation_rejected",
      "Version read is not declared",
    );
    requireQuery(search, "");
    const versionId = versionDetail[1] ?? "";
    invariant(
      VERSION_ID_PATTERN.test(versionId),
      400,
      "version_rejected",
      "Version ID is invalid",
    );
    return { ...noBody("script-read", target), versionId };
  }

  if (suffix === "deployments" && method === "POST") {
    invariant(
      hasOperation(target, "deployment:create"),
      403,
      "operation_rejected",
      "Deployment is not declared",
    );
    requireQuery(search, "");
    return {
      kind: "deployment-create",
      maximumBodyBytes: 16 * 1024,
      mutationKey: `deployment:${target.scriptName}`,
      target,
    };
  }

  throw new BrokerError(
    403,
    "endpoint_rejected",
    "Cloudflare API endpoint is not allowed",
  );
}

function sameStringArray(
  actual: unknown,
  expected: readonly string[],
): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((entry, index) => entry === expected[index])
  );
}

interface ExplicitSecretBinding {
  name: string;
  text: string;
}

function validateBindings(
  value: unknown,
  target: TargetManifest,
): ExplicitSecretBinding[] {
  invariant(
    Array.isArray(value),
    400,
    "metadata_rejected",
    "Worker bindings must be an array",
  );
  const normalized: string[] = [];
  const explicitSecrets: ExplicitSecretBinding[] = [];
  for (const binding of value) {
    invariant(
      isRecord(binding),
      400,
      "metadata_rejected",
      "Worker binding is invalid",
    );
    if (binding.type === "plain_text") {
      invariant(
        exactKeys(binding, ["name", "text", "type"]) &&
          typeof binding.name === "string" &&
          typeof binding.text === "string",
        400,
        "metadata_rejected",
        "Plain-text binding is invalid",
      );
      normalized.push(`plain_text:${binding.name}:${binding.text}`);
      continue;
    }
    if (binding.type === "durable_object_namespace") {
      invariant(
        exactKeys(binding, ["class_name", "name", "type"]) &&
          typeof binding.name === "string" &&
          typeof binding.class_name === "string",
        400,
        "metadata_rejected",
        "Durable Object binding is invalid",
      );
      normalized.push(
        `durable_object_namespace:${binding.name}:${binding.class_name}`,
      );
      continue;
    }
    if (binding.type === "secret_text") {
      invariant(
        exactKeys(binding, ["name", "text", "type"]) &&
          typeof binding.name === "string" &&
          typeof binding.text === "string" &&
          target.allowedSecrets.some((secret) => secret.name === binding.name),
        400,
        "metadata_rejected",
        "Secret binding is invalid",
      );
      normalized.push(`secret_text:${binding.name}`);
      explicitSecrets.push({ name: binding.name, text: binding.text });
      continue;
    }
    throw new BrokerError(
      400,
      "binding_type_rejected",
      "Worker binding type is not declared in manifest",
    );
  }
  const expected = [
    ...target.plainTextBindings.map(
      (binding) => `plain_text:${binding.name}:${binding.text}`,
    ),
    ...target.durableObjectBindings.map(
      (binding) =>
        `durable_object_namespace:${binding.name}:${binding.className}`,
    ),
    ...(target.inheritedBindingTypes.length === 0
      ? target.allowedSecrets.map((binding) => `secret_text:${binding.name}`)
      : []),
  ];
  invariant(
    normalized.sort().join("\n") === expected.sort().join("\n"),
    400,
    "bindings_rejected",
    "Worker bindings do not match manifest",
  );
  return explicitSecrets;
}

function validateMigration(value: unknown, target: TargetManifest): void {
  if (target.migration === null) {
    invariant(
      value === undefined,
      400,
      "migration_rejected",
      "Worker migration is not declared",
    );
    return;
  }
  if (value === undefined) return;
  invariant(
    isRecord(value),
    400,
    "migration_rejected",
    "Worker migration is missing",
  );
  invariant(
    exactKeys(value, ["new_tag", "steps"]) &&
      value.new_tag === target.migration.tag &&
      Array.isArray(value.steps) &&
      value.steps.length === 1,
    400,
    "migration_rejected",
    "Worker migration does not match manifest",
  );
  const step = value.steps[0];
  invariant(
    isRecord(step) &&
      exactKeys(step, ["new_sqlite_classes"]) &&
      sameStringArray(
        step.new_sqlite_classes,
        target.migration.newSqliteClasses,
      ),
    400,
    "migration_rejected",
    "Durable Object lifecycle does not match manifest",
  );
}

function validatePackageDependencies(value: unknown): void {
  if (value === undefined) return;
  invariant(
    Array.isArray(value) && value.length <= 128,
    400,
    "metadata_rejected",
    "Package dependency metadata is invalid",
  );
  for (const dependency of value) {
    invariant(
      isRecord(dependency) &&
        exactKeys(dependency, [
          "installedVersion",
          "name",
          "packageJsonVersion",
        ]) &&
        typeof dependency.name === "string" &&
        /^[A-Za-z0-9@][A-Za-z0-9@/._-]{0,199}$/.test(dependency.name) &&
        typeof dependency.packageJsonVersion === "string" &&
        dependency.packageJsonVersion.length <= 100 &&
        typeof dependency.installedVersion === "string" &&
        dependency.installedVersion.length <= 100,
      400,
      "metadata_rejected",
      "Package dependency metadata is invalid",
    );
  }
}

function validateAssets(
  value: unknown,
  target: TargetManifest,
): string | undefined {
  if (!target.assets) {
    invariant(
      value === undefined,
      400,
      "assets_rejected",
      "Static assets are not declared",
    );
    return undefined;
  }
  invariant(
    isRecord(value) &&
      exactKeys(value, ["config", "jwt"]) &&
      typeof value.jwt === "string" &&
      value.jwt.length >= 20 &&
      value.jwt.length <= 16_384 &&
      /^[A-Za-z0-9._-]+$/.test(value.jwt) &&
      isRecord(value.config) &&
      exactKeys(value.config, []),
    400,
    "assets_rejected",
    "Static asset attachment does not match manifest",
  );
  return value.jwt;
}

export function validateWorkerMetadata(
  value: unknown,
  target: TargetManifest,
  mode: "version",
): {
  assetsJwt?: string;
  mainModule: string;
  migrationMode: "initial" | "none";
  secretBindings?: ExplicitSecretBinding[];
} {
  invariant(
    isRecord(value),
    400,
    "metadata_rejected",
    "Worker metadata must be an object",
  );
  const allowedKeys = new Set([
    "annotations",
    "assets",
    "bindings",
    "compatibility_date",
    "compatibility_flags",
    "keep_bindings",
    "main_module",
    "migrations",
    "observability",
    "package_dependencies",
  ]);
  invariant(
    Object.keys(value).every((key) => allowedKeys.has(key)),
    400,
    "metadata_field_rejected",
    "Worker metadata contains an undeclared field",
  );
  invariant(
    typeof value.main_module === "string" &&
      value.main_module === target.mainModule &&
      isSafeModuleName(value.main_module),
    400,
    "metadata_rejected",
    "Worker main module is invalid",
  );
  invariant(
    value.compatibility_date === target.compatibilityDate &&
      sameStringArray(value.compatibility_flags, target.compatibilityFlags),
    400,
    "compatibility_rejected",
    "Worker compatibility settings do not match manifest",
  );
  const secretBindings = validateBindings(value.bindings, target);
  validateMigration(value.migrations, target);
  const assetsJwt = validateAssets(value.assets, target);
  validatePackageDependencies(value.package_dependencies);

  invariant(
    target.inheritedBindingTypes.length === 0
      ? value.keep_bindings === undefined
      : sameStringArray(value.keep_bindings, target.inheritedBindingTypes),
    400,
    "keep_bindings_rejected",
    "Version upload inheritance does not match signed manifest",
  );
  invariant(
    isRecord(value.annotations) &&
      exactKeys(value.annotations, ["workers/tag"]) &&
      value.annotations["workers/tag"] === target.versionTag,
    400,
    "version_tag_rejected",
    "Worker version tag does not match manifest",
  );
  invariant(
    value.observability === undefined,
    400,
    "metadata_rejected",
    "Version upload cannot change observability",
  );
  return {
    mainModule: value.main_module,
    migrationMode: value.migrations === undefined ? "none" : "initial",
    ...(assetsJwt === undefined ? {} : { assetsJwt }),
    ...(secretBindings.length === 0 ? {} : { secretBindings }),
  };
}

export function isSafeModuleName(value: string): boolean {
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

export function validateSecretBody(
  value: unknown,
  target: TargetManifest,
): {
  expectedSha256: string;
  mutationKey: string;
} {
  const secret =
    isRecord(value) && typeof value.name === "string"
      ? target.allowedSecrets.find((candidate) => candidate.name === value.name)
      : undefined;
  invariant(
    isRecord(value) &&
      exactKeys(value, ["name", "text", "type"]) &&
      value.type === "secret_text" &&
      typeof value.name === "string" &&
      secret !== undefined &&
      typeof value.text === "string" &&
      value.text.length >= 1 &&
      value.text.length <= 65_536,
    400,
    "secret_rejected",
    "Secret mutation is not declared in manifest",
  );
  return {
    expectedSha256: secret.sha256,
    mutationKey: `secret:${target.scriptName}:${value.name}`,
  };
}

export function validateSubdomainBody(
  value: unknown,
  target: TargetManifest,
): void {
  invariant(
    target.workersDev !== null &&
      isRecord(value) &&
      exactKeys(value, ["enabled", "previews_enabled"]) &&
      value.enabled === target.workersDev.enabled &&
      value.previews_enabled === target.workersDev.previewsEnabled,
    400,
    "subdomain_rejected",
    "workers.dev settings do not match manifest",
  );
}

export function validateDeploymentBody(
  value: unknown,
  target: TargetManifest,
): {
  versionId: string;
} {
  invariant(
    isRecord(value) &&
      exactKeys(value, ["annotations", "strategy", "versions"]) &&
      value.strategy === "percentage" &&
      isRecord(value.annotations) &&
      Object.keys(value.annotations).every(
        (key) => key === "workers/message",
      ) &&
      (value.annotations["workers/message"] === undefined ||
        (typeof value.annotations["workers/message"] === "string" &&
          value.annotations["workers/message"].length <= 256)) &&
      Array.isArray(value.versions) &&
      value.versions.length === 1,
    400,
    "deployment_rejected",
    "Deployment strategy does not match manifest",
  );
  const version = value.versions[0];
  invariant(
    isRecord(version) &&
      exactKeys(version, ["percentage", "version_id"]) &&
      version.percentage === 100 &&
      typeof version.version_id === "string" &&
      VERSION_ID_PATTERN.test(version.version_id) &&
      target.versionTag !== null,
    400,
    "deployment_rejected",
    "Deployment version/traffic does not match manifest",
  );
  return { versionId: version.version_id };
}

export function validateAssetInitBody(
  value: unknown,
  target: TargetManifest,
): ValidatedAssetManifest {
  invariant(
    isRecord(value) &&
      exactKeys(value, ["manifest"]) &&
      isRecord(value.manifest),
    400,
    "asset_manifest_rejected",
    "Asset manifest is invalid",
  );
  const entries = Object.entries(value.manifest);
  invariant(
    entries.length === target.staticAssets.length && entries.length <= 1_500,
    400,
    "asset_manifest_rejected",
    "Asset manifest count is invalid",
  );
  const hashes: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >;
  const sha256ByHash: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const expectedByPath = new Map(
    target.staticAssets.map((asset) => [asset.path, asset]),
  );
  let totalBytes = 0;
  for (const [path, metadata] of entries) {
    invariant(
      path.startsWith("/") &&
        path.length <= 1_024 &&
        !path.includes("\\") &&
        !path.includes("%") &&
        !path.includes("//") &&
        path
          .split("/")
          .every((segment) => segment !== "." && segment !== "..") &&
        isRecord(metadata) &&
        exactKeys(metadata, ["hash", "size"]) &&
        typeof metadata.hash === "string" &&
        ASSET_HASH_PATTERN.test(metadata.hash) &&
        typeof metadata.size === "number" &&
        Number.isSafeInteger(metadata.size) &&
        metadata.size >= 0 &&
        metadata.size <= 25 * 1024 * 1024 &&
        expectedByPath.get(path)?.cloudflareHash === metadata.hash &&
        expectedByPath.get(path)?.size === metadata.size,
      400,
      "asset_manifest_rejected",
      "Asset manifest entry is invalid",
    );
    const existingSize = hashes[metadata.hash];
    const expectedSha256 = expectedByPath.get(path)?.sha256;
    invariant(
      expectedSha256 !== undefined &&
        (sha256ByHash[metadata.hash] === undefined ||
          sha256ByHash[metadata.hash] === expectedSha256),
      400,
      "asset_manifest_rejected",
      "Repeated asset hashes must bind one artifact digest",
    );
    invariant(
      existingSize === undefined || existingSize === metadata.size,
      400,
      "asset_manifest_rejected",
      "Repeated asset hashes must have one size",
    );
    if (existingSize === undefined) {
      hashes[metadata.hash] = metadata.size;
      sha256ByHash[metadata.hash] = expectedSha256;
      totalBytes += metadata.size;
    }
    invariant(
      totalBytes <= 96 * 1024 * 1024,
      400,
      "asset_manifest_rejected",
      "Asset manifest is too large",
    );
  }
  return { hashes, sha256ByHash, totalBytes };
}

export function syntheticScriptsResponse(
  states: TargetScriptState[],
): Response {
  const result = states.map((state) => ({
    id: state.scriptName,
    ...(state.migrationTag === undefined
      ? {}
      : { migration_tag: state.migrationTag }),
  }));
  return new Response(
    JSON.stringify({
      errors: [],
      messages: [],
      result,
      result_info: {
        count: result.length,
        page: 1,
        per_page: 100,
        total_count: result.length,
        total_pages: 1,
      },
      success: true,
    }),
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
    },
  );
}

export { ASSET_HASH_PATTERN, VERSION_ID_PATTERN };
