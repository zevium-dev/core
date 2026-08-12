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
  | "service-read"
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
  contentTypeByHash: Record<string, string>;
  hashes: Record<string, number>;
  sha256ByHash: Record<string, string>;
  totalBytes: number;
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
      method === "GET" && hasOperation(target, "service:read"),
      403,
      "operation_rejected",
      "Service read is not declared",
    );
    requireQuery(search, "");
    return noBody("service-read", target);
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
    requireQuery(search, "");
    return {
      kind: "version-upload",
      maximumBodyBytes: 40 * 1024 * 1024,
      mutationKey: `version-upload:${target.scriptName}`,
      target,
    };
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
    ...target.allowedSecrets.map((binding) => `secret_text:${binding.name}`),
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

/** Proves an immutable Cloudflare deployment points 100% at one sealed version. */
export function validateDeploymentDetail(
  value: unknown,
  deploymentId: string,
  versionId: string,
): void {
  const versions = isRecord(value) ? value.versions : undefined;
  const version = Array.isArray(versions) ? versions[0] : undefined;
  invariant(
    isRecord(value) &&
      value.id === deploymentId &&
      VERSION_ID_PATTERN.test(deploymentId) &&
      value.strategy === "percentage" &&
      Array.isArray(versions) &&
      versions.length === 1 &&
      isRecord(version) &&
      version.version_id === versionId &&
      version.percentage === 100,
    502,
    "deployment_verification_failed",
    "Cloudflare deployment differs from sealed version",
  );
}

/**
 * Proves Cloudflare persisted an exact closed binding set before that immutable
 * version can receive traffic. Secret values are write-only, so their values
 * are proved by the signed upload bytes and their names/types by this readback.
 */
export function validateVersionDetail(
  value: unknown,
  target: TargetManifest,
  versionId: string,
): void {
  invariant(
    isRecord(value) &&
      value.id === versionId &&
      isRecord(value.resources) &&
      Array.isArray(value.resources.bindings) &&
      isRecord(value.resources.script) &&
      typeof value.resources.script.etag === "string" &&
      /^[0-9a-f]{64}$/.test(value.resources.script.etag) &&
      isRecord(value.resources.script_runtime) &&
      value.resources.script_runtime.compatibility_date ===
        target.compatibilityDate &&
      sameStringArray(
        value.resources.script_runtime.compatibility_flags,
        target.compatibilityFlags,
      ) &&
      (target.migration === null
        ? value.resources.script_runtime.migration_tag === undefined
        : value.resources.script_runtime.migration_tag ===
          target.migration.tag),
    502,
    "version_verification_failed",
    "Cloudflare version state does not match signed manifest",
  );

  const actual: string[] = [];
  const names = new Set<string>();
  for (const binding of value.resources.bindings) {
    invariant(
      isRecord(binding) &&
        typeof binding.name === "string" &&
        !names.has(binding.name),
      502,
      "version_verification_failed",
      "Cloudflare returned invalid or duplicate bindings",
    );
    names.add(binding.name);
    if (binding.type === "plain_text" && typeof binding.text === "string") {
      actual.push(`plain_text:${binding.name}:${binding.text}`);
      continue;
    }
    if (
      binding.type === "durable_object_namespace" &&
      typeof binding.class_name === "string" &&
      (binding.script_name === undefined ||
        binding.script_name === target.scriptName) &&
      binding.environment === undefined &&
      binding.dispatch_namespace === undefined
    ) {
      actual.push(
        `durable_object_namespace:${binding.name}:${binding.class_name}`,
      );
      continue;
    }
    if (binding.type === "secret_text") {
      actual.push(`secret_text:${binding.name}`);
      continue;
    }
    throw new BrokerError(
      502,
      "version_binding_rejected",
      "Cloudflare version contains an undeclared binding",
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
    ...target.allowedSecrets.map((binding) => `secret_text:${binding.name}`),
  ];
  invariant(
    actual.sort().join("\n") === expected.sort().join("\n"),
    502,
    "version_binding_rejected",
    "Cloudflare version binding set is not closed over signed manifest",
  );
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
  const contentTypeByHash: Record<string, string> = Object.create(
    null,
  ) as Record<string, string>;
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
    const expectedAsset = expectedByPath.get(path);
    const expectedSha256 = expectedAsset?.sha256;
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
    invariant(
      expectedAsset !== undefined &&
        (contentTypeByHash[metadata.hash] === undefined ||
          contentTypeByHash[metadata.hash] === expectedAsset.contentType),
      400,
      "asset_manifest_rejected",
      "Repeated asset hashes must have one content type",
    );
    if (existingSize === undefined) {
      hashes[metadata.hash] = metadata.size;
      sha256ByHash[metadata.hash] = expectedSha256;
      contentTypeByHash[metadata.hash] = expectedAsset.contentType;
      totalBytes += metadata.size;
    }
    invariant(
      totalBytes <= 96 * 1024 * 1024,
      400,
      "asset_manifest_rejected",
      "Asset manifest is too large",
    );
  }
  return { contentTypeByHash, hashes, sha256ByHash, totalBytes };
}

export { ASSET_HASH_PATTERN, VERSION_ID_PATTERN };
