import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateAuditBootstrap } from "./audit-preflight.mjs";

let bootstrapError;
let semver;
let parseDocument;
try {
  validateAuditBootstrap({ requireInstalled: true });
  [{ default: semver }, { parseDocument }] = await Promise.all([
    import("semver"),
    import("yaml"),
  ]);
} catch (error) {
  bootstrapError = error;
}

export const severities = ["info", "low", "moderate", "high", "critical"];
export const CANONICAL_REGISTRY = "https://registry.npmjs.org/";
export const BULK_ADVISORY_URL = new URL(
  "-/npm/v1/security/advisories/bulk",
  CANONICAL_REGISTRY,
);

const PROJECT_ROOT = realpathSync(
  fileURLToPath(new URL("../", import.meta.url)),
);
const EXPECTED_NODE_VERSION = "24.15.0";
const EXPECTED_PNPM_VERSION = "11.8.0";
const EXPECTED_LOCKFILE_VERSION = "9.0";
const EXPECTED_PACKAGE_MANAGER =
  "pnpm@11.8.0+sha512.c1f5e7c4cb241c8f174b743851d82f42b802324afc8b0f116b96adb15aa06664948dde36960a3ba1079ba5b4b29dd0140135b94b5b5f5263592249d68e555f26";
const EXPECTED_WORKSPACE_PATTERNS = ["apps/*", "packages/*"];
const EXPECTED_LOCKFILE_SETTINGS = Object.freeze({
  autoInstallPeers: true,
  excludeLinksFromLockfile: false,
});
const EXPECTED_OVERRIDES = Object.freeze({
  "concurrently>shell-quote": "1.10.0",
  "jayson>uuid": "11.1.1",
  postcss: "8.5.25",
  sharp: "0.35.0",
  undici: "7.29.0",
});
const EXPECTED_ALLOW_BUILDS = Object.freeze({
  "agent-browser": true,
  "@tailwindcss/oxide": false,
  bufferutil: true,
  esbuild: true,
  fsevents: false,
  sharp: false,
  "utf-8-validate": true,
  workerd: true,
});
const EXPECTED_LIFECYCLE_PACKAGES = Object.freeze({
  "@tailwindcss/oxide@4.3.2": Object.freeze({
    allowed: false,
    gypfile: false,
    scripts: Object.freeze({}),
  }),
  "agent-browser@0.27.1": Object.freeze({
    allowed: true,
    gypfile: false,
    scripts: Object.freeze({ postinstall: "node scripts/postinstall.js" }),
  }),
  "bufferutil@4.1.0": Object.freeze({
    allowed: true,
    gypfile: false,
    scripts: Object.freeze({ install: "node-gyp-build" }),
  }),
  "esbuild@0.27.0": Object.freeze({
    allowed: true,
    gypfile: false,
    scripts: Object.freeze({ postinstall: "node install.js" }),
  }),
  "esbuild@0.28.1": Object.freeze({
    allowed: true,
    gypfile: false,
    scripts: Object.freeze({ postinstall: "node install.js" }),
  }),
  "fsevents@2.3.3": Object.freeze({
    allowed: false,
    gypfile: true,
    scripts: Object.freeze({ install: "node-gyp rebuild" }),
  }),
  "sharp@0.35.0": Object.freeze({
    allowed: false,
    gypfile: false,
    scripts: Object.freeze({}),
  }),
  "utf-8-validate@5.0.10": Object.freeze({
    allowed: true,
    gypfile: false,
    scripts: Object.freeze({ install: "node-gyp-build" }),
  }),
  "utf-8-validate@6.0.6": Object.freeze({
    allowed: true,
    gypfile: false,
    scripts: Object.freeze({ install: "node-gyp-build" }),
  }),
  "workerd@1.20260708.1": Object.freeze({
    allowed: true,
    gypfile: false,
    scripts: Object.freeze({ postinstall: "node install.js" }),
  }),
  "workerd@1.20260804.1": Object.freeze({
    allowed: true,
    gypfile: false,
    scripts: Object.freeze({ postinstall: "node install.js" }),
  }),
});
const EXPECTED_MINIMUM_RELEASE_AGE = 720;
const EXPECTED_MINIMUM_RELEASE_AGE_EXCLUDE = [
  "@cloudflare/workers-types",
  "@clerk/*",
];
const EXPECTED_SETUP_NODE_ACTION =
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const PREFLIGHT_COMMAND = "node scripts/audit-preflight.mjs";
const COREPACK_COMMAND = "corepack enable pnpm";
const BOOTSTRAP_INSTALL_COMMAND =
  "pnpm --filter . install --frozen-lockfile --ignore-pnpmfile --ignore-scripts --registry=https://registry.npmjs.org/ --config.trust-lockfile=false --config.verify-store-integrity=true";
const FULL_INSTALL_COMMAND =
  "pnpm install --frozen-lockfile --ignore-pnpmfile --ignore-scripts --registry=https://registry.npmjs.org/ --config.trust-lockfile=false --config.verify-store-integrity=true";
const AUDIT_COMMAND = "node scripts/audit.mjs";
const EXPECTED_MISE_ACTION =
  "jdx/mise-action@7e36c90d9ab29c415a2384db3006f3ec8a8cc654";
const MISE_VERIFY_COMMAND = [
  'test "$(node --version)" = "v24.15.0"',
  'test "$(pnpm --version)" = "11.8.0"',
].join("\n");
const PLAIN_INSTALL_COMMAND = "pnpm install --frozen-lockfile";
const REFEREE_INSTALL_COMMAND =
  'pnpm --dir "$REFEREE_ROOT" install --frozen-lockfile --ignore-pnpmfile --ignore-scripts --registry=https://registry.npmjs.org/ --config.trust-lockfile=false --config.verify-store-integrity=true';
const REBUILD_COMMAND = "pnpm rebuild";
const BROWSER_INSTALL_COMMAND = "pnpm exec agent-browser install --with-deps";
const ALLOWED_ACTIONS = new Map([
  ["actions/attest", "1e69f48acb82d1966a394da916b4c1698aa569d6"],
  ["actions/checkout", "d23441a48e516b6c34aea4fa41551a30e30af803"],
  ["actions/cache", "caa296126883cff596d87d8935842f9db880ef25"],
  ["actions/upload-artifact", "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"],
  ["actions/download-artifact", "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"],
  ["actions/github-script", "ed597411d8f924073f98dfc5c65a23a2325f34cd"],
  ["actions/setup-node", EXPECTED_SETUP_NODE_ACTION.split("@")[1]],
  ["jdx/mise-action", "7e36c90d9ab29c415a2384db3006f3ec8a8cc654"],
]);
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);
const CAPTURED_SEVERITIES = new Set(severities);
const DEPENDENCY_TYPES = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];
const LIFECYCLE_SCRIPT_NAMES = new Set([
  "install",
  "postinstall",
  "postpack",
  "postprepare",
  "postpublish",
  "preinstall",
  "prepack",
  "prepare",
  "preprepare",
  "prepublish",
  "prepublishOnly",
  "publish",
]);
const WORKSPACE_KEYS = new Set([
  "allowBuilds",
  "minimumReleaseAge",
  "minimumReleaseAgeExclude",
  "minimumReleaseAgeStrict",
  "overrides",
  "packages",
  "registry",
  "strictDepBuilds",
  "trustLockfile",
  "verifyStoreIntegrity",
]);
const LOCKFILE_KEYS = new Set([
  "importers",
  "lockfileVersion",
  "overrides",
  "packages",
  "settings",
  "snapshots",
]);
const PACKAGE_SNAPSHOT_KEYS = new Set([
  "bundledDependencies",
  "cpu",
  "engines",
  "hasBin",
  "libc",
  "os",
  "peerDependencies",
  "peerDependenciesMeta",
  "resolution",
]);
const DEPENDENCY_SNAPSHOT_KEYS = new Set([
  "dependencies",
  "optional",
  "optionalDependencies",
  "transitivePeerDependencies",
]);
const IMPORTER_KEYS = new Set(DEPENDENCY_TYPES);
const IMPORTER_DEPENDENCY_KEYS = new Set(["specifier", "version"]);
const MANIFEST_KEYS = new Set([
  ...DEPENDENCY_TYPES,
  "engines",
  "exports",
  "imports",
  "name",
  "packageManager",
  "private",
  "scripts",
  "sideEffects",
  "type",
]);
const PLATFORM_VALUES = Object.freeze({
  cpu: new Set([
    "arm",
    "arm64",
    "ia32",
    "loong64",
    "mips64el",
    "ppc64",
    "riscv64",
    "s390x",
    "wasm32",
    "x64",
  ]),
  libc: new Set(["glibc", "musl"]),
  os: new Set([
    "aix",
    "android",
    "darwin",
    "freebsd",
    "linux",
    "netbsd",
    "openbsd",
    "openharmony",
    "sunos",
    "win32",
  ]),
});
const RAW_ADVISORY_KEYS = new Set([
  "cwe",
  "cvss",
  "id",
  "name",
  "severity",
  "title",
  "url",
  "vulnerable_versions",
]);
const AUDIT_CONFIG_KEYS = new Set([
  "ignoreGhsas",
  "ignoreCves",
  "ignore",
  "ignoreUnfixable",
  "ignoreRegistryErrors",
]);
const SUPPRESSION_CONFIG_KEYS = new Set([
  "auditconfigignoreghsas",
  "auditconfigignorecves",
  "auditconfigignore",
  "auditconfigignoreunfixable",
  "auditconfigignoreregistryerrors",
  "auditignore",
  "ignore",
  "ignoreghsas",
  "ignorecves",
  "ignoreunfixable",
  "ignoreregistryerrors",
]);
const TARGET_OVERRIDE_KEYS = new Set([
  "auditlevel",
  "dev",
  "dir",
  "filter",
  "filterprod",
  "fix",
  "global",
  "include",
  "includeworkspaceroot",
  "interactive",
  "lockfile",
  "lockfiledir",
  "omit",
  "only",
  "optional",
  "prefix",
  "prod",
  "production",
  "recursive",
  "sharedworkspacelockfile",
  "shrinkwrap",
  "userconfig",
  "globalconfig",
  "workspace",
  "workspaceroot",
]);
const DIRECT_ENV_OVERRIDE_KEYS = new Set([
  "COREPACK_HOME",
  "COREPACK_INTEGRITY_KEYS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PNPM_DEV",
  "PNPM_DIR",
  "PNPM_FILTER",
  "PNPM_FILTER_PROD",
  "PNPM_INCLUDE",
  "PNPM_LOCKFILE_DIR",
  "PNPM_OMIT",
  "PNPM_ONLY",
  "PNPM_OPTIONAL",
  "PNPM_PROD",
  "PNPM_PRODUCTION",
  "PNPM_PACKAGE_IMPORT_METHOD",
  "PNPM_REGISTRY",
  "PNPM_WORKSPACE",
  "PNPM_WORKSPACE_ROOT",
]);
const SUPPLY_CONFIG_KEYS = new Set([
  "allowbuilds",
  "catalog",
  "catalogs",
  "dangerouslyallowallbuilds",
  "ignoredbuiltdependencies",
  "ignorescripts",
  "minimumreleaseage",
  "minimumreleaseageexclude",
  "minimumreleaseagestrict",
  "neverbuiltdependencies",
  "onlybuiltdependencies",
  "overrides",
  "packageextensions",
  "packages",
  "patcheddependencies",
  "pnpmfile",
  "strictdepbuilds",
  "trustlockfile",
  "verifystoreintegrity",
]);
const BUILTIN_SCOPED_REGISTRIES = new Map([
  ["@jsr:registry", "https://npm.jsr.io/"],
]);
const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_VERSIONS = 50_000;
const MAX_GRAPH_WALKS = 2_000_000;
const MAX_PATHS_PER_PACKAGE_VERSION = 10_000;
const CHILD_TIMEOUT_MS = 5_000;
const CHILD_KILL_GRACE_MS = 250;
const CONNECT_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 20_000;
const METADATA_CONCURRENCY = 24;
const FORBIDDEN_AUTOMATION_COMMANDS = [
  {
    pattern:
      /\b(?:npm|pnpm|yarn|bun)\b[^\n]*\s(?:add|i|install|update|up|dlx|create|import|link|patch)\b/u,
    reason: "mutable package-manager install",
  },
  {
    pattern: /\b(?:npx|bunx)\b/u,
    reason: "unlocked package executor",
  },
  {
    pattern: /\bcorepack\s+(?:install|prepare|use)\b/u,
    reason: "mutable package-manager bootstrap",
  },
  {
    pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba)?sh\b/u,
    reason: "remote shell execution",
  },
  {
    pattern: /\b(?:git|hg)\s+clone\b/u,
    reason: "unlocked source checkout",
  },
];

export class AuditValidationError extends Error {}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) {
    throw new AuditValidationError(`${label} must be an object.`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new AuditValidationError(`${label} must be an array.`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new AuditValidationError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AuditValidationError(`${label} must be a positive integer.`);
  }
  return value;
}

function requireExactKeys(value, allowedKeys, label, requiredKeys = []) {
  const record = requireRecord(value, label);
  const unknownKeys = Object.keys(record).filter(
    (key) => !allowedKeys.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new AuditValidationError(
      `${label} contains unsupported fields: ${sortedStrings(unknownKeys).join(", ")}.`,
    );
  }
  const missingKeys = requiredKeys.filter((key) => !Object.hasOwn(record, key));
  if (missingKeys.length > 0) {
    throw new AuditValidationError(
      `${label} is missing required fields: ${sortedStrings(missingKeys).join(", ")}.`,
    );
  }
  return record;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    sortedStrings(Object.keys(value)).map((key) => [
      key,
      canonicalJson(value[key]),
    ]),
  );
}

function requireExactValue(actual, expected, label) {
  if (
    JSON.stringify(canonicalJson(actual)) !==
    JSON.stringify(canonicalJson(expected))
  ) {
    throw new AuditValidationError(
      `${label} does not exactly match pinned dependency policy.`,
    );
  }
  return actual;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new AuditValidationError(`${label} must be a boolean.`);
  }
  return value;
}

function validatePackageName(value, label) {
  const name = requireString(value, label);
  const segment = "[a-z0-9](?:[a-z0-9._~-]*[a-z0-9._~-])?";
  const pattern = new RegExp(`^(?:${segment}|@${segment}/${segment})$`);
  if (
    name.length > 214 ||
    !pattern.test(name) ||
    name.startsWith(".") ||
    name.startsWith("_") ||
    name.includes("..")
  ) {
    throw new AuditValidationError(
      `${label} is not a canonical npm package name: ${JSON.stringify(name)}.`,
    );
  }
  return name;
}

function validateExactVersion(value, label) {
  const version = requireString(value, label);
  if (semver.valid(version, { loose: false }) !== version) {
    throw new AuditValidationError(
      `${label} is not a canonical exact semver version: ${JSON.stringify(version)}.`,
    );
  }
  return version;
}

function validateStrongIntegrity(value, label) {
  const integrity = requireString(value, label);
  const match = integrity.match(/^sha512-([A-Za-z0-9+/]{86}==)$/);
  if (!match) {
    throw new AuditValidationError(
      `${label} must contain exactly one complete sha512 SRI digest.`,
    );
  }
  const digest = Buffer.from(match[1], "base64");
  if (digest.length !== 64 || digest.toString("base64") !== match[1]) {
    throw new AuditValidationError(
      `${label} must contain a canonical 64-byte sha512 digest.`,
    );
  }
  return integrity;
}

function normalizeConfigKey(key) {
  return key.replaceAll(/[-_.:@/]/g, "").toLowerCase();
}

function parseJson(stdout, label) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AuditValidationError(`${label} returned invalid JSON: ${detail}`);
  }
  const document = parseDocument(stdout, {
    merge: false,
    prettyErrors: false,
    schema: "json",
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    const issue = document.errors[0] ?? document.warnings[0];
    throw new AuditValidationError(
      `${label} returned non-deterministic JSON: ${issue.message}`,
    );
  }
  try {
    document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AuditValidationError(
      `${label} returned non-deterministic JSON: ${detail}`,
    );
  }
  return value;
}

function parseJsonObject(stdout, label) {
  return requireRecord(parseJson(stdout, label), label);
}

function parseYamlObject(source, label) {
  const document = parseDocument(source, {
    merge: false,
    prettyErrors: false,
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    const issue = document.errors[0] ?? document.warnings[0];
    throw new AuditValidationError(
      `${label} is invalid or non-deterministic YAML: ${issue.message}`,
    );
  }
  let value;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AuditValidationError(`${label} is invalid YAML: ${detail}`);
  }
  return requireRecord(value, label);
}

function readBoundedFile(filePath, label, maxBytes = MAX_LOCKFILE_BYTES) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new AuditValidationError(
      `${label} must be a regular, non-symlink file.`,
    );
  }
  if (stat.size > maxBytes) {
    throw new AuditValidationError(
      `${label} exceeds ${String(maxBytes)} byte limit.`,
    );
  }
  return readFileSync(filePath, "utf8");
}

function sortedStrings(values) {
  return [...values].sort();
}

function sameStrings(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isEmptySuppression(value) {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    (Array.isArray(value) && value.length === 0) ||
    (isRecord(value) && Object.keys(value).length === 0)
  );
}

export function validateAuditConfig(config) {
  const root = requireRecord(config, "pnpm config");
  const auditConfig = root.auditConfig;

  if (auditConfig !== undefined) {
    for (const [key, value] of Object.entries(
      requireRecord(auditConfig, "auditConfig"),
    )) {
      if (!AUDIT_CONFIG_KEYS.has(key)) {
        throw new AuditValidationError(
          `Unsupported auditConfig.${key} is configured; audit policy permits no audit overrides.`,
        );
      }
      if (!isEmptySuppression(value)) {
        throw new AuditValidationError(
          `auditConfig.${key} suppresses audit results; audit policy permits no suppressions.`,
        );
      }
    }
  }

  requireExactValue(root.allowBuilds, EXPECTED_ALLOW_BUILDS, "allowBuilds");
  requireExactValue(root.overrides, EXPECTED_OVERRIDES, "overrides");
  requireExactValue(root.packages, EXPECTED_WORKSPACE_PATTERNS, "packages");
  if (root.minimumReleaseAge !== EXPECTED_MINIMUM_RELEASE_AGE) {
    throw new AuditValidationError(
      `minimumReleaseAge must be exactly ${String(EXPECTED_MINIMUM_RELEASE_AGE)}.`,
    );
  }
  requireExactValue(
    root.minimumReleaseAgeExclude,
    EXPECTED_MINIMUM_RELEASE_AGE_EXCLUDE,
    "minimumReleaseAgeExclude",
  );
  for (const [key, expected] of [
    ["minimumReleaseAgeStrict", true],
    ["strictDepBuilds", true],
    ["trustLockfile", false],
    ["verifyStoreIntegrity", true],
  ]) {
    if (root[key] !== expected) {
      throw new AuditValidationError(
        `${key} must be exactly ${String(expected)}.`,
      );
    }
  }
  if (root.registry !== CANONICAL_REGISTRY) {
    throw new AuditValidationError(
      `registry overrides canonical ${CANONICAL_REGISTRY}.`,
    );
  }

  for (const [key, value] of Object.entries(root)) {
    if (key === "auditConfig") continue;
    const normalized = normalizeConfigKey(key);
    if (SUPPRESSION_CONFIG_KEYS.has(normalized)) {
      if (!isEmptySuppression(value)) {
        throw new AuditValidationError(
          `${key} suppresses audit results; audit policy permits no suppressions.`,
        );
      }
      continue;
    }
    if (
      new Set([
        "allowBuilds",
        "minimumReleaseAge",
        "minimumReleaseAgeExclude",
        "minimumReleaseAgeStrict",
        "overrides",
        "packages",
        "registry",
        "strictDepBuilds",
        "trustLockfile",
        "verifyStoreIntegrity",
      ]).has(key)
    ) {
      continue;
    }
    if (BUILTIN_SCOPED_REGISTRIES.has(key)) {
      if (value !== BUILTIN_SCOPED_REGISTRIES.get(key)) {
        throw new AuditValidationError(
          `${key} overrides pinned built-in scoped registry.`,
        );
      }
      continue;
    }
    if (key.endsWith(":registry") || normalized.endsWith("registry")) {
      throw new AuditValidationError(
        `${key} is a registry override; audit target is canonical and fixed.`,
      );
    }
    if (key.startsWith("//")) {
      if (key !== "//registry.npmjs.org/:_authToken") {
        throw new AuditValidationError(
          `${key} configures credentials or TLS material for a non-allowlisted registry surface.`,
        );
      }
      if (typeof value !== "string" || value.length === 0) {
        throw new AuditValidationError(
          "Canonical registry credential marker must be a non-empty string.",
        );
      }
      continue;
    }
    if (SUPPLY_CONFIG_KEYS.has(normalized)) {
      throw new AuditValidationError(
        `${key} changes dependency source, integrity, or lifecycle policy.`,
      );
    }
    if (TARGET_OVERRIDE_KEYS.has(normalized)) {
      throw new AuditValidationError(
        `${key} overrides audit scope or workspace selection; audit target is fixed.`,
      );
    }
  }

  return [];
}

export function validateAuditEnvironment(environment = process.env) {
  for (const [key, value] of Object.entries(environment)) {
    const upperKey = key.toUpperCase();
    if (upperKey === "NODE_ENV" && value?.toLowerCase() === "production") {
      throw new AuditValidationError(
        "NODE_ENV=production overrides dependency scope; audit requires every dependency type.",
      );
    }
    if (DIRECT_ENV_OVERRIDE_KEYS.has(upperKey)) {
      const miseToolNodePath =
        upperKey === "NODE_PATH" &&
        typeof value === "string" &&
        value.length > 0 &&
        value.split(path.delimiter).every((entry) => {
          if (entry.length === 0 || entry.includes("\0")) return false;
          return /[/\\]mise[/\\]installs[/\\]/u.test(path.resolve(entry));
        });
      if (!miseToolNodePath) {
        throw new AuditValidationError(
          `${key} overrides audit scope, registry, lockfile, or filtering policy.`,
        );
      }
    }
    if (upperKey.startsWith("COREPACK_") && upperKey !== "COREPACK_ROOT") {
      throw new AuditValidationError(
        `${key} changes package-manager identity, source, or integrity policy.`,
      );
    }
    const prefix = ["NPM_CONFIG_", "PNPM_CONFIG_"].find((candidate) =>
      upperKey.startsWith(candidate),
    );
    if (!prefix) continue;
    const suffix = key.slice(prefix.length);
    const normalized = normalizeConfigKey(suffix);
    if (
      TARGET_OVERRIDE_KEYS.has(normalized) ||
      SUPPRESSION_CONFIG_KEYS.has(normalized) ||
      SUPPLY_CONFIG_KEYS.has(normalized) ||
      normalized.endsWith("registry")
    ) {
      throw new AuditValidationError(
        `${key} overrides audit scope, registry, lockfile, filtering, or suppression policy.`,
      );
    }
  }
}

export function validateAuditArguments(args) {
  if (!Array.isArray(args)) {
    throw new AuditValidationError("Audit CLI arguments must be an array.");
  }
  if (args.length > 0) {
    throw new AuditValidationError(
      `Audit CLI overrides are forbidden: ${args.map((arg) => JSON.stringify(arg)).join(" ")}.`,
    );
  }
}

export function validateWorkspaceRoot(cwd, initCwd) {
  let resolvedCwd;
  try {
    resolvedCwd = realpathSync(cwd);
  } catch {
    throw new AuditValidationError(
      "Audit working directory cannot be resolved.",
    );
  }
  if (resolvedCwd !== PROJECT_ROOT) {
    throw new AuditValidationError(
      `Audit must run from exact repository workspace root ${PROJECT_ROOT}.`,
    );
  }
  if (initCwd !== undefined) {
    let resolvedInitCwd;
    try {
      resolvedInitCwd = realpathSync(initCwd);
    } catch {
      throw new AuditValidationError("INIT_CWD cannot be resolved.");
    }
    if (resolvedInitCwd !== PROJECT_ROOT) {
      throw new AuditValidationError(
        "INIT_CWD selects an alternate workspace; audit target is fixed.",
      );
    }
  }
}

function requireRegularRepositoryFile(filePath, label) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new AuditValidationError(`${label} is missing.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new AuditValidationError(
      `${label} must be a regular, non-symlink file.`,
    );
  }
  if (realpathSync(filePath) !== path.resolve(filePath)) {
    throw new AuditValidationError(
      `${label} resolves outside its exact repository path.`,
    );
  }
}

function repositoryFileExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function validateWorkspacePolicy(workspaceManifest) {
  const workspace = requireExactKeys(
    workspaceManifest,
    WORKSPACE_KEYS,
    "pnpm-workspace.yaml",
    [...WORKSPACE_KEYS],
  );
  requireExactValue(
    requireArray(workspace.packages, "workspace.packages"),
    EXPECTED_WORKSPACE_PATTERNS,
    "workspace.packages",
  );
  requireExactValue(
    requireRecord(workspace.allowBuilds, "workspace.allowBuilds"),
    EXPECTED_ALLOW_BUILDS,
    "workspace.allowBuilds",
  );
  requireExactValue(
    requireRecord(workspace.overrides, "workspace.overrides"),
    EXPECTED_OVERRIDES,
    "workspace.overrides",
  );
  if (workspace.minimumReleaseAge !== EXPECTED_MINIMUM_RELEASE_AGE) {
    throw new AuditValidationError(
      `workspace.minimumReleaseAge must be exactly ${String(EXPECTED_MINIMUM_RELEASE_AGE)} minutes.`,
    );
  }
  requireExactValue(
    requireArray(
      workspace.minimumReleaseAgeExclude,
      "workspace.minimumReleaseAgeExclude",
    ),
    EXPECTED_MINIMUM_RELEASE_AGE_EXCLUDE,
    "workspace.minimumReleaseAgeExclude",
  );
  for (const [key, expected] of [
    ["minimumReleaseAgeStrict", true],
    ["strictDepBuilds", true],
    ["trustLockfile", false],
    ["verifyStoreIntegrity", true],
  ]) {
    if (requireBoolean(workspace[key], `workspace.${key}`) !== expected) {
      throw new AuditValidationError(
        `workspace.${key} must be ${String(expected)}.`,
      );
    }
  }
  if (workspace.registry !== CANONICAL_REGISTRY) {
    throw new AuditValidationError(
      `workspace.registry must be canonical ${CANONICAL_REGISTRY}.`,
    );
  }
  return workspace;
}

function validateManifestPolicy(manifest, importerId) {
  requireExactKeys(manifest, MANIFEST_KEYS, `${importerId}/package.json`, [
    "name",
    "private",
  ]);
  if (manifest.private !== true) {
    throw new AuditValidationError(
      `${importerId}/package.json must be private.`,
    );
  }
  validatePackageName(manifest.name, `${importerId}.manifest.name`);
  if (importerId === ".") {
    if (manifest.packageManager !== EXPECTED_PACKAGE_MANAGER) {
      throw new AuditValidationError(
        `Root packageManager must be exactly ${EXPECTED_PACKAGE_MANAGER}.`,
      );
    }
  } else if (manifest.packageManager !== undefined) {
    throw new AuditValidationError(
      `${importerId}/package.json must not override packageManager.`,
    );
  }
  for (const key of [
    "bundleDependencies",
    "bundledDependencies",
    "dependenciesMeta",
    "devEngines",
    "overrides",
    "peerDependencies",
    "peerDependenciesMeta",
    "pnpm",
    "resolutions",
    "workspaces",
  ]) {
    if (manifest[key] !== undefined) {
      throw new AuditValidationError(
        `${importerId}/package.json contains forbidden package-manager control ${key}.`,
      );
    }
  }
  if (manifest.scripts !== undefined) {
    const scripts = requireRecord(
      manifest.scripts,
      `${importerId}.manifest.scripts`,
    );
    for (const [name, command] of Object.entries(scripts)) {
      requireString(command, `${importerId}.manifest.scripts.${name}`);
      if (LIFECYCLE_SCRIPT_NAMES.has(name)) {
        throw new AuditValidationError(
          `${importerId}/package.json lifecycle script ${name} is not allowlisted.`,
        );
      }
    }
  }
  if (importerId === ".") {
    const scripts = requireRecord(manifest.scripts, "root manifest scripts");
    for (const [name, expected] of [
      ["audit:ci", "node scripts/audit.mjs"],
      ["test:audit", "node --test scripts/audit.test.mjs"],
      [
        "ci:pr",
        "node scripts/audit.mjs && pnpm format:check && pnpm lint && pnpm quality:static && pnpm typecheck && pnpm test && pnpm build:ci && pnpm bundle:check && pnpm diff:check",
      ],
    ]) {
      if (scripts[name] !== expected) {
        throw new AuditValidationError(
          `Root script ${name} must be exactly ${JSON.stringify(expected)}.`,
        );
      }
    }
  }
}

function discoverWorkspaceImporters(rootDir, workspaceManifest) {
  validateWorkspacePolicy(workspaceManifest);
  const importerIds = ["."];
  for (const pattern of EXPECTED_WORKSPACE_PATTERNS) {
    const parentRelative = pattern.slice(0, -2);
    const parent = path.resolve(rootDir, parentRelative);
    let parentStat;
    try {
      parentStat = lstatSync(parent);
    } catch {
      throw new AuditValidationError(
        `Workspace directory ${parentRelative} is missing.`,
      );
    }
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      realpathSync(parent) !== parent
    ) {
      throw new AuditValidationError(
        `Workspace directory ${parentRelative} must be an exact non-symlink directory.`,
      );
    }
    for (const entry of readdirSync(parent, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      if (entry.isSymbolicLink()) {
        throw new AuditValidationError(
          `Workspace glob ${pattern} contains forbidden symlink ${entry.name}.`,
        );
      }
      if (!entry.isDirectory()) continue;
      const candidate = path.join(parent, entry.name);
      const manifestPath = path.join(candidate, "package.json");
      if (!repositoryFileExists(manifestPath)) continue;
      requireRegularRepositoryFile(
        manifestPath,
        `${path.relative(rootDir, manifestPath)}`,
      );
      importerIds.push(
        path.relative(rootDir, candidate).split(path.sep).join("/"),
      );
    }
  }
  const sortedImporterIds = sortedStrings(importerIds);
  if (new Set(sortedImporterIds).size !== sortedImporterIds.length) {
    throw new AuditValidationError(
      "Workspace patterns resolve duplicate importer paths.",
    );
  }
  const manifests = new Map();
  const importerByName = new Map();
  for (const importerId of sortedImporterIds) {
    const manifestPath = path.join(
      rootDir,
      importerId === "." ? "package.json" : `${importerId}/package.json`,
    );
    requireRegularRepositoryFile(manifestPath, `${importerId}/package.json`);
    const manifest = parseJsonObject(
      readBoundedFile(
        manifestPath,
        `${importerId}/package.json`,
        2 * 1024 * 1024,
      ),
      `${importerId}/package.json`,
    );
    validateManifestPolicy(manifest, importerId);
    if (importerByName.has(manifest.name)) {
      throw new AuditValidationError(
        `Workspace package name ${manifest.name} is duplicated by ${importerByName.get(manifest.name)} and ${importerId}.`,
      );
    }
    importerByName.set(manifest.name, importerId);
    manifests.set(importerId, manifest);
  }
  return { importerByName, importerIds: sortedImporterIds, manifests };
}

function expectedWorkspaceReference(importerId, targetImporterId) {
  const from = importerId === "." ? "." : importerId;
  return `link:${path.posix.relative(from, targetImporterId)}`;
}

function validateImporterManifest(
  importerId,
  importer,
  manifest,
  importerByName,
) {
  requireExactKeys(importer, IMPORTER_KEYS, `lockfile.importers.${importerId}`);
  const seenDependencyNames = new Map();
  const registryEdges = [];
  for (const dependencyType of DEPENDENCY_TYPES) {
    const declared =
      manifest[dependencyType] === undefined
        ? {}
        : requireRecord(
            manifest[dependencyType],
            `${importerId}.manifest.${dependencyType}`,
          );
    const locked =
      importer[dependencyType] === undefined
        ? {}
        : requireRecord(
            importer[dependencyType],
            `${importerId}.lockfile.${dependencyType}`,
          );
    const declaredNames = sortedStrings(Object.keys(declared));
    const lockedNames = sortedStrings(Object.keys(locked));
    if (!sameStrings(declaredNames, lockedNames)) {
      throw new AuditValidationError(
        `${importerId} ${dependencyType} do not exactly match repository lockfile importer.`,
      );
    }
    for (const dependencyName of declaredNames) {
      validatePackageName(
        dependencyName,
        `${importerId}.manifest.${dependencyType} dependency name`,
      );
      if (seenDependencyNames.has(dependencyName)) {
        throw new AuditValidationError(
          `${importerId} declares ${dependencyName} as both ${seenDependencyNames.get(dependencyName)} and ${dependencyType}.`,
        );
      }
      seenDependencyNames.set(dependencyName, dependencyType);
      const lockedDependency = requireExactKeys(
        locked[dependencyName],
        IMPORTER_DEPENDENCY_KEYS,
        `${importerId}.${dependencyType}.${dependencyName}`,
        [...IMPORTER_DEPENDENCY_KEYS],
      );
      if (lockedDependency.specifier !== declared[dependencyName]) {
        throw new AuditValidationError(
          `${importerId}.${dependencyType}.${dependencyName} specifier does not match package.json.`,
        );
      }
      const specifier = requireString(
        declared[dependencyName],
        `${importerId}.${dependencyType}.${dependencyName}.specifier`,
      );
      const lockedVersion = requireString(
        lockedDependency.version,
        `${importerId}.${dependencyType}.${dependencyName}.version`,
      );
      if (specifier.startsWith("workspace:")) {
        if (specifier !== "workspace:*") {
          throw new AuditValidationError(
            `${importerId}.${dependencyType}.${dependencyName} must use exact workspace:* protocol.`,
          );
        }
        const targetImporterId = importerByName.get(dependencyName);
        if (!targetImporterId || targetImporterId === importerId) {
          throw new AuditValidationError(
            `${importerId}.${dependencyType}.${dependencyName} does not bind to another exact workspace importer.`,
          );
        }
        const expectedReference = expectedWorkspaceReference(
          importerId,
          targetImporterId,
        );
        if (lockedVersion !== expectedReference) {
          throw new AuditValidationError(
            `${importerId}.${dependencyType}.${dependencyName} workspace link must be exactly ${expectedReference}.`,
          );
        }
        continue;
      }
      if (
        !/\d/u.test(specifier) ||
        semver.validRange(specifier, {
          includePrerelease: true,
          loose: false,
        }) === null
      ) {
        throw new AuditValidationError(
          `${importerId}.${dependencyType}.${dependencyName} uses mutable or non-registry specifier ${JSON.stringify(specifier)}.`,
        );
      }
      if (lockedVersion.startsWith("link:") || lockedVersion.includes(":")) {
        throw new AuditValidationError(
          `${importerId}.${dependencyType}.${dependencyName} resolves through forbidden local, URL, git, or protocol source.`,
        );
      }
      registryEdges.push({
        alias: dependencyName,
        dependencyType,
        importerId,
        reference: lockedVersion,
        specifier,
      });
    }
  }
  return registryEdges;
}

function parsePackageKey(packageKey, label) {
  const slashIndex = packageKey.startsWith("@") ? packageKey.indexOf("/") : -1;
  const separatorIndex = packageKey.indexOf(
    "@",
    slashIndex === -1 ? 1 : slashIndex + 1,
  );
  if (separatorIndex <= 0) {
    throw new AuditValidationError(
      `${label} ${JSON.stringify(packageKey)} has no canonical name/version separator.`,
    );
  }
  const name = validatePackageName(
    packageKey.slice(0, separatorIndex),
    `${label} package name`,
  );
  if (name.startsWith("@jsr/")) {
    throw new AuditValidationError(
      `${label} uses non-allowlisted @jsr registry scope ${name}.`,
    );
  }
  const version = validateExactVersion(
    packageKey.slice(separatorIndex + 1),
    `${label} package version`,
  );
  if (`${name}@${version}` !== packageKey) {
    throw new AuditValidationError(
      `${label} ${JSON.stringify(packageKey)} is not canonical.`,
    );
  }
  return { name, packageKey, version };
}

function parseSnapshotKey(depPath, label, depth = 0) {
  if (depth > 64 || depPath.length > 8_192) {
    throw new AuditValidationError(
      `${label} exceeds peer-context complexity limits.`,
    );
  }
  const suffixIndex = depPath.indexOf("(");
  const packageKey =
    suffixIndex === -1 ? depPath : depPath.slice(0, suffixIndex);
  const identity = parsePackageKey(packageKey, label);
  const peers = [];
  let cursor = suffixIndex === -1 ? depPath.length : suffixIndex;
  while (cursor < depPath.length) {
    if (depPath[cursor] !== "(") {
      throw new AuditValidationError(
        `${label} ${JSON.stringify(depPath)} has malformed peer suffix.`,
      );
    }
    let open = 1;
    let end = cursor + 1;
    while (end < depPath.length && open > 0) {
      if (depPath[end] === "(") open += 1;
      else if (depPath[end] === ")") open -= 1;
      end += 1;
    }
    if (open !== 0) {
      throw new AuditValidationError(
        `${label} ${JSON.stringify(depPath)} has unbalanced peer suffix.`,
      );
    }
    const peerPath = depPath.slice(cursor + 1, end - 1);
    if (peerPath.length === 0) {
      throw new AuditValidationError(
        `${label} ${JSON.stringify(depPath)} has empty peer suffix.`,
      );
    }
    peers.push(parseSnapshotKey(peerPath, `${label} peer`, depth + 1));
    cursor = end;
  }
  return { ...identity, depPath, peers };
}

function dependencyPathForReference(alias, dependency) {
  const reference = isRecord(dependency)
    ? requireString(dependency.version, `${alias}.version`)
    : requireString(dependency, alias);
  if (reference.startsWith("link:")) {
    return null;
  }
  if (reference.includes(":")) {
    throw new AuditValidationError(
      `${alias} resolves through forbidden local, URL, git, or protocol source ${JSON.stringify(reference)}.`,
    );
  }
  const baseReference = reference.includes("(")
    ? reference.slice(0, reference.indexOf("("))
    : reference;
  const depPath =
    semver.valid(baseReference, { loose: false }) === baseReference
      ? `${alias}@${reference}`
      : reference;
  parseSnapshotKey(depPath, `${alias} dependency reference`);
  return depPath;
}

function validateNonemptyStringMap(value, label) {
  const record = requireRecord(value, label);
  if (Object.keys(record).length === 0) {
    throw new AuditValidationError(`${label} must not be empty when present.`);
  }
  for (const [key, entry] of Object.entries(record)) {
    validatePackageName(key, `${label} key`);
    const string = requireString(entry, `${label}.${key}`);
    if (/\p{C}/u.test(string) || string !== string.trim()) {
      throw new AuditValidationError(
        `${label}.${key} contains unsafe or non-canonical text.`,
      );
    }
  }
  return record;
}

function validatePlatformList(value, label, allowedValues) {
  const entries = requireArray(value, label);
  if (entries.length === 0) {
    throw new AuditValidationError(`${label} must not be empty when present.`);
  }
  const normalized = [];
  for (const [index, entry] of entries.entries()) {
    const platform = requireString(entry, `${label}[${String(index)}]`);
    if (!allowedValues.has(platform)) {
      throw new AuditValidationError(
        `${label} contains unsupported platform ${JSON.stringify(platform)}.`,
      );
    }
    normalized.push(platform);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new AuditValidationError(`${label} contains duplicate platforms.`);
  }
  return normalized;
}

function validatePackageMetadata(packageKey, packageSnapshot) {
  const label = `lockfile.packages.${packageKey}`;
  const snapshot = requireExactKeys(
    packageSnapshot,
    PACKAGE_SNAPSHOT_KEYS,
    label,
    ["resolution"],
  );
  const resolution = requireExactKeys(
    snapshot.resolution,
    new Set(["integrity"]),
    `${label}.resolution`,
    ["integrity"],
  );
  validateStrongIntegrity(
    resolution.integrity,
    `${label}.resolution.integrity`,
  );

  if (snapshot.engines !== undefined) {
    const engines = requireExactKeys(
      snapshot.engines,
      new Set(["node", "npm", "pnpm"]),
      `${label}.engines`,
    );
    if (Object.keys(engines).length === 0) {
      throw new AuditValidationError(
        `${label}.engines must not be empty when present.`,
      );
    }
    for (const [engine, range] of Object.entries(engines)) {
      const value = requireString(range, `${label}.engines.${engine}`);
      if (semver.validRange(value, { loose: false }) === null) {
        throw new AuditValidationError(
          `${label}.engines.${engine} is not a valid semver range.`,
        );
      }
    }
  }
  for (const field of ["cpu", "libc", "os"]) {
    if (snapshot[field] !== undefined) {
      validatePlatformList(
        snapshot[field],
        `${label}.${field}`,
        PLATFORM_VALUES[field],
      );
    }
  }
  if (snapshot.hasBin !== undefined && snapshot.hasBin !== true) {
    throw new AuditValidationError(
      `${label}.hasBin must be true when present.`,
    );
  }
  if (snapshot.bundledDependencies !== undefined) {
    const bundled = requireArray(
      snapshot.bundledDependencies,
      `${label}.bundledDependencies`,
    );
    if (bundled.length === 0) {
      throw new AuditValidationError(
        `${label}.bundledDependencies must not be empty when present.`,
      );
    }
    for (const [index, dependencyName] of bundled.entries()) {
      validatePackageName(
        dependencyName,
        `${label}.bundledDependencies[${String(index)}]`,
      );
    }
    if (new Set(bundled).size !== bundled.length) {
      throw new AuditValidationError(
        `${label}.bundledDependencies contains duplicates.`,
      );
    }
  }
  const peers =
    snapshot.peerDependencies === undefined
      ? {}
      : validateNonemptyStringMap(
          snapshot.peerDependencies,
          `${label}.peerDependencies`,
        );
  if (snapshot.peerDependenciesMeta !== undefined) {
    const meta = requireRecord(
      snapshot.peerDependenciesMeta,
      `${label}.peerDependenciesMeta`,
    );
    if (Object.keys(meta).length === 0) {
      throw new AuditValidationError(
        `${label}.peerDependenciesMeta must not be empty when present.`,
      );
    }
    for (const [peerName, rawPeerMeta] of Object.entries(meta)) {
      if (!Object.hasOwn(peers, peerName)) {
        throw new AuditValidationError(
          `${label}.peerDependenciesMeta.${peerName} has no matching peer dependency.`,
        );
      }
      const peerMeta = requireExactKeys(
        rawPeerMeta,
        new Set(["optional"]),
        `${label}.peerDependenciesMeta.${peerName}`,
        ["optional"],
      );
      if (peerMeta.optional !== true) {
        throw new AuditValidationError(
          `${label}.peerDependenciesMeta.${peerName}.optional must be true.`,
        );
      }
    }
  }
  return snapshot;
}

function validateLifecycleIdentityPolicy(packageIdentities) {
  const policyNames = new Set();
  for (const [packageKey, policy] of Object.entries(
    EXPECTED_LIFECYCLE_PACKAGES,
  )) {
    const identity = parsePackageKey(packageKey, "lifecycle package policy");
    policyNames.add(identity.name);
    if (!packageIdentities.has(packageKey)) {
      throw new AuditValidationError(
        `Lifecycle package policy ${packageKey} has no exact lockfile identity.`,
      );
    }
    if (EXPECTED_ALLOW_BUILDS[identity.name] !== policy.allowed) {
      throw new AuditValidationError(
        `Lifecycle package policy ${packageKey} disagrees with allowBuilds decision.`,
      );
    }
  }
  requireExactValue(
    sortedStrings(Object.keys(EXPECTED_ALLOW_BUILDS)),
    sortedStrings(policyNames),
    "lifecycle package names",
  );
  for (const identity of packageIdentities.values()) {
    if (
      Object.hasOwn(EXPECTED_ALLOW_BUILDS, identity.name) &&
      !Object.hasOwn(EXPECTED_LIFECYCLE_PACKAGES, identity.packageKey)
    ) {
      throw new AuditValidationError(
        `Lifecycle decision for ${identity.name} is not pinned to exact version ${identity.version}.`,
      );
    }
  }
}

function validateDependencySnapshot(depPath, rawSnapshot) {
  const label = `lockfile.snapshots.${depPath}`;
  const snapshot = requireExactKeys(
    rawSnapshot,
    DEPENDENCY_SNAPSHOT_KEYS,
    label,
  );
  if (snapshot.optional !== undefined && snapshot.optional !== true) {
    throw new AuditValidationError(
      `${label}.optional must be true when present.`,
    );
  }
  const edges = [];
  const aliases = new Map();
  for (const dependencyType of ["dependencies", "optionalDependencies"]) {
    if (snapshot[dependencyType] === undefined) continue;
    const dependencies = requireRecord(
      snapshot[dependencyType],
      `${label}.${dependencyType}`,
    );
    if (Object.keys(dependencies).length === 0) {
      throw new AuditValidationError(
        `${label}.${dependencyType} must not be empty when present.`,
      );
    }
    for (const [alias, reference] of Object.entries(dependencies)) {
      validatePackageName(alias, `${label}.${dependencyType} alias`);
      if (aliases.has(alias)) {
        throw new AuditValidationError(
          `${label} classifies ${alias} as both ${aliases.get(alias)} and ${dependencyType}.`,
        );
      }
      aliases.set(alias, dependencyType);
      edges.push({
        alias,
        dependencyType,
        depPath: dependencyPathForReference(alias, reference),
        reference: requireString(
          reference,
          `${label}.${dependencyType}.${alias}`,
        ),
      });
    }
  }
  let transitivePeerDependencies = [];
  if (snapshot.transitivePeerDependencies !== undefined) {
    transitivePeerDependencies = requireArray(
      snapshot.transitivePeerDependencies,
      `${label}.transitivePeerDependencies`,
    );
    if (transitivePeerDependencies.length === 0) {
      throw new AuditValidationError(
        `${label}.transitivePeerDependencies must not be empty when present.`,
      );
    }
    for (const [index, peerName] of transitivePeerDependencies.entries()) {
      validatePackageName(
        peerName,
        `${label}.transitivePeerDependencies[${String(index)}]`,
      );
    }
    if (
      new Set(transitivePeerDependencies).size !==
        transitivePeerDependencies.length ||
      !sameStrings(
        transitivePeerDependencies,
        sortedStrings(transitivePeerDependencies),
      )
    ) {
      throw new AuditValidationError(
        `${label}.transitivePeerDependencies must be unique and sorted.`,
      );
    }
  }
  return { edges, snapshot, transitivePeerDependencies };
}

function peerRangeAlternatives(range) {
  return range
    .split("||")
    .map((entry) => entry.trim())
    .filter(
      (entry) =>
        entry.length > 0 && semver.validRange(entry, { loose: false }) !== null,
    );
}

function validatePeerContext(
  depPath,
  parsedSnapshot,
  packageSnapshot,
  snapshotInfoByPath,
) {
  const label = `lockfile.snapshots.${depPath}`;
  const peerNames = parsedSnapshot.peers.map((peer) => peer.name);
  if (new Set(peerNames).size !== peerNames.length) {
    throw new AuditValidationError(
      `${label} peer suffixes must have unique package names.`,
    );
  }
  const suffixByName = new Map();
  for (const peer of parsedSnapshot.peers) {
    if (!snapshotInfoByPath.has(peer.depPath)) {
      throw new AuditValidationError(
        `${label} peer suffix references missing snapshot ${peer.depPath}.`,
      );
    }
    suffixByName.set(peer.name, peer.depPath);
  }
  const info = snapshotInfoByPath.get(depPath);
  const edgeByAlias = new Map(info.edges.map((edge) => [edge.alias, edge]));
  const peerDependencies = packageSnapshot.peerDependencies ?? {};
  const peerMeta = packageSnapshot.peerDependenciesMeta ?? {};
  const transitivePeers = new Set(info.transitivePeerDependencies);

  for (const [peerName, range] of Object.entries(peerDependencies)) {
    const edge = edgeByAlias.get(peerName);
    const optional = peerMeta[peerName]?.optional === true;
    if (!edge) {
      if (!optional) {
        throw new AuditValidationError(
          `${label} omits required peer dependency ${peerName}.`,
        );
      }
      if (suffixByName.has(peerName)) {
        throw new AuditValidationError(
          `${label} peer suffix ${peerName} has no resolved dependency edge.`,
        );
      }
      continue;
    }
    const child = snapshotInfoByPath.get(edge.depPath)?.parsed;
    if (!child || child.name !== peerName) {
      throw new AuditValidationError(
        `${label} peer dependency ${peerName} does not bind to its canonical package identity.`,
      );
    }
    const alternatives = peerRangeAlternatives(range);
    if (
      alternatives.length === 0 ||
      !alternatives.some((alternative) =>
        semver.satisfies(child.version, alternative, {
          includePrerelease: true,
          loose: false,
        }),
      )
    ) {
      throw new AuditValidationError(
        `${label} peer dependency ${peerName}@${child.version} violates declared range ${JSON.stringify(range)}.`,
      );
    }
    if (suffixByName.get(peerName) !== edge.depPath) {
      throw new AuditValidationError(
        `${label} peer suffix for ${peerName} does not exactly match resolved edge.`,
      );
    }
  }
  for (const [peerName, peerPath] of suffixByName) {
    if (Object.hasOwn(peerDependencies, peerName)) continue;
    if (!transitivePeers.has(peerName)) {
      throw new AuditValidationError(
        `${label} peer suffix ${peerPath} is neither direct nor declared transitive peer context.`,
      );
    }
  }
}

function validateOverrideApplication(edgeRecords, packageIdentities) {
  const coverage = {};
  for (const [selector, expectedVersion] of Object.entries(
    EXPECTED_OVERRIDES,
  )) {
    const separator = selector.indexOf(">");
    const parentName =
      separator === -1 ? undefined : selector.slice(0, separator);
    const dependencyName =
      separator === -1 ? selector : selector.slice(separator + 1);
    validatePackageName(dependencyName, `override ${selector} dependency`);
    if (parentName !== undefined) {
      validatePackageName(parentName, `override ${selector} parent`);
    }
    validateExactVersion(expectedVersion, `override ${selector} target`);
    const matchingEdges = edgeRecords.filter(
      (edge) =>
        edge.alias === dependencyName &&
        (parentName === undefined || edge.parentName === parentName),
    );
    coverage[selector] = matchingEdges.length;
    if (matchingEdges.length === 0) {
      continue;
    }
    for (const edge of matchingEdges) {
      if (
        edge.child.name !== dependencyName ||
        edge.child.version !== expectedVersion
      ) {
        throw new AuditValidationError(
          `Pinned override ${selector} drifted to ${edge.child.name}@${edge.child.version}.`,
        );
      }
    }
    if (parentName === undefined) {
      for (const identity of packageIdentities.values()) {
        if (
          identity.name === dependencyName &&
          identity.version !== expectedVersion
        ) {
          throw new AuditValidationError(
            `Global override ${selector} permits unexpected package version ${identity.version}.`,
          );
        }
      }
    }
  }
  return coverage;
}

function occurrenceKey(name, version) {
  return `${name}\0${version}`;
}

function validateGraph(graph) {
  const request = requireRecord(graph.request, "audit request");
  const dependencyCounts = requireRecord(
    graph.dependencyCounts,
    "dependency counts",
  );
  if (!(graph.occurrences instanceof Map)) {
    throw new AuditValidationError("audit graph occurrences must be a Map.");
  }

  let totalDependencies = 0;
  let dependencies = 0;
  let devDependencies = 0;
  let optionalDependencies = 0;
  for (const packageName of sortedStrings(Object.keys(request))) {
    const versions = requireArray(
      request[packageName],
      `request.${packageName}`,
    );
    if (versions.length === 0) {
      throw new AuditValidationError(
        `request.${packageName} must include at least one version.`,
      );
    }
    const sortedVersions = sortedStrings(versions);
    if (
      !sameStrings(versions, sortedVersions) ||
      new Set(versions).size !== versions.length
    ) {
      throw new AuditValidationError(
        `request.${packageName} versions must be unique and sorted.`,
      );
    }
    for (const version of versions) {
      if (semver.valid(version) === null) {
        throw new AuditValidationError(
          `request.${packageName} contains invalid version ${JSON.stringify(version)}.`,
        );
      }
      const occurrence = requireRecord(
        graph.occurrences.get(occurrenceKey(packageName, version)),
        `occurrence ${packageName}@${version}`,
      );
      if (occurrence.name !== packageName || occurrence.version !== version) {
        throw new AuditValidationError(
          `Occurrence identity mismatch for ${packageName}@${version}.`,
        );
      }
      if (
        typeof occurrence.dev !== "boolean" ||
        typeof occurrence.optional !== "boolean"
      ) {
        throw new AuditValidationError(
          `Occurrence classification missing for ${packageName}@${version}.`,
        );
      }
      const paths = requireArray(
        occurrence.paths,
        `occurrence ${packageName}@${version}.paths`,
      );
      if (
        paths.length === 0 ||
        paths.some(
          (dependencyPath) =>
            typeof dependencyPath !== "string" || dependencyPath.length === 0,
        ) ||
        new Set(paths).size !== paths.length ||
        !sameStrings(paths, sortedStrings(paths))
      ) {
        throw new AuditValidationError(
          `Occurrence paths for ${packageName}@${version} must be nonempty, unique, and sorted.`,
        );
      }
      totalDependencies += 1;
      if (!occurrence.dev && !occurrence.optional) dependencies += 1;
      if (occurrence.dev) devDependencies += 1;
      if (occurrence.optional) optionalDependencies += 1;
    }
  }
  if (totalDependencies !== graph.occurrences.size) {
    throw new AuditValidationError(
      `Request/occurrence mismatch: request=${String(totalDependencies)}, occurrences=${String(graph.occurrences.size)}.`,
    );
  }
  const computed = {
    dependencies,
    devDependencies,
    optionalDependencies,
    totalDependencies,
  };
  for (const [key, value] of Object.entries(computed)) {
    if (dependencyCounts[key] !== value) {
      throw new AuditValidationError(
        `Dependency count mismatch for ${key}: metadata=${String(dependencyCounts[key])}, graph=${String(value)}.`,
      );
    }
  }
}

export function loadWorkspaceAuditGraph(rootDirectory = PROJECT_ROOT) {
  let rootDir;
  try {
    rootDir = realpathSync(rootDirectory);
  } catch {
    throw new AuditValidationError("Repository root cannot be resolved.");
  }
  if (rootDir !== path.resolve(rootDirectory)) {
    throw new AuditValidationError(
      "Repository root must be an exact non-symlink directory.",
    );
  }
  const lockfilePath = path.join(rootDir, "pnpm-lock.yaml");
  const workspacePath = path.join(rootDir, "pnpm-workspace.yaml");
  requireRegularRepositoryFile(lockfilePath, "pnpm-lock.yaml");
  requireRegularRepositoryFile(workspacePath, "pnpm-workspace.yaml");
  const lockfileSource = readBoundedFile(lockfilePath, "pnpm-lock.yaml");
  const workspaceSource = readBoundedFile(
    workspacePath,
    "pnpm-workspace.yaml",
    2 * 1024 * 1024,
  );
  const lockfile = parseYamlObject(lockfileSource, "pnpm-lock.yaml");
  const workspace = parseYamlObject(workspaceSource, "pnpm-workspace.yaml");
  requireExactKeys(lockfile, LOCKFILE_KEYS, "pnpm-lock.yaml", [
    ...LOCKFILE_KEYS,
  ]);
  if (String(lockfile.lockfileVersion) !== EXPECTED_LOCKFILE_VERSION) {
    throw new AuditValidationError(
      `pnpm-lock.yaml version must be ${EXPECTED_LOCKFILE_VERSION}.`,
    );
  }
  requireExactValue(
    requireRecord(lockfile.settings, "lockfile.settings"),
    EXPECTED_LOCKFILE_SETTINGS,
    "lockfile.settings",
  );
  requireExactValue(
    requireRecord(lockfile.overrides, "lockfile.overrides"),
    EXPECTED_OVERRIDES,
    "lockfile.overrides",
  );
  const workspaceState = discoverWorkspaceImporters(rootDir, workspace);
  for (const importerId of workspaceState.importerIds) {
    const importerRoot =
      importerId === "." ? rootDir : path.join(rootDir, importerId);
    for (const controlFile of [".npmrc", ".pnpmfile.cjs", "pnpmfile.cjs"]) {
      if (repositoryFileExists(path.join(importerRoot, controlFile))) {
        throw new AuditValidationError(
          `${importerId}/${controlFile} is forbidden; dependency policy has no untracked config or hook surface.`,
        );
      }
    }
  }
  if (repositoryFileExists(path.join(rootDir, "patches"))) {
    throw new AuditValidationError(
      "Repository patches path is forbidden; patchedDependencies policy is empty.",
    );
  }
  const importers = requireRecord(lockfile.importers, "lockfile.importers");
  const importerIds = sortedStrings(Object.keys(importers));
  if (!sameStrings(importerIds, workspaceState.importerIds)) {
    throw new AuditValidationError(
      `Lockfile importers do not exactly match workspace: lockfile=${importerIds.join(",")}; workspace=${workspaceState.importerIds.join(",")}.`,
    );
  }
  const importerEdges = [];
  for (const importerId of importerIds) {
    importerEdges.push(
      ...validateImporterManifest(
        importerId,
        requireRecord(
          importers[importerId],
          `lockfile.importers.${importerId}`,
        ),
        workspaceState.manifests.get(importerId),
        workspaceState.importerByName,
      ),
    );
  }

  const packages = requireRecord(lockfile.packages, "lockfile.packages");
  const snapshots = requireRecord(lockfile.snapshots, "lockfile.snapshots");
  const packageIdentities = new Map();
  const expectedPackagePairs = new Set();
  for (const packageKey of sortedStrings(Object.keys(packages))) {
    const packageSnapshot = requireRecord(
      packages[packageKey],
      `lockfile.packages.${packageKey}`,
    );
    const identity = parsePackageKey(packageKey, "Lockfile package key");
    validatePackageMetadata(packageKey, packageSnapshot);
    packageIdentities.set(packageKey, identity);
    expectedPackagePairs.add(occurrenceKey(identity.name, identity.version));
  }
  if (packageIdentities.size === 0) {
    throw new AuditValidationError(
      "Lockfile registry package graph must not be empty.",
    );
  }
  validateLifecycleIdentityPolicy(packageIdentities);
  const packageKeysWithSnapshots = new Set();
  const snapshotInfoByPath = new Map();
  for (const depPath of sortedStrings(Object.keys(snapshots))) {
    const parsed = parseSnapshotKey(depPath, "Lockfile snapshot key");
    const packageKey = parsed.packageKey;
    const packageSnapshot = packages[packageKey];
    if (packageSnapshot === undefined) {
      throw new AuditValidationError(
        `Dependency snapshot ${depPath} has no matching canonical package metadata.`,
      );
    }
    const validated = validateDependencySnapshot(
      depPath,
      requireRecord(snapshots[depPath], `lockfile.snapshots.${depPath}`),
    );
    snapshotInfoByPath.set(depPath, { ...validated, parsed });
    packageKeysWithSnapshots.add(packageKey);
  }
  if (snapshotInfoByPath.size === 0) {
    throw new AuditValidationError(
      "Lockfile dependency snapshot graph must not be empty.",
    );
  }
  const packagesWithoutSnapshots = sortedStrings(Object.keys(packages)).filter(
    (packageKey) => !packageKeysWithSnapshots.has(packageKey),
  );
  if (packagesWithoutSnapshots.length > 0) {
    throw new AuditValidationError(
      `Canonical packages have no dependency snapshots: ${packagesWithoutSnapshots.slice(0, 10).join(", ")}.`,
    );
  }
  if (expectedPackagePairs.size > MAX_PACKAGE_VERSIONS) {
    throw new AuditValidationError(
      `Lockfile graph exceeds ${String(MAX_PACKAGE_VERSIONS)} unique package-version limit.`,
    );
  }

  const edgeRecords = [];
  for (const edge of importerEdges) {
    const depPath = dependencyPathForReference(edge.alias, edge.reference);
    const childInfo = snapshotInfoByPath.get(depPath);
    if (!childInfo) {
      throw new AuditValidationError(
        `${edge.importerId}.${edge.dependencyType}.${edge.alias} references missing registry snapshot ${depPath}.`,
      );
    }
    if (childInfo.parsed.name !== edge.alias) {
      throw new AuditValidationError(
        `${edge.importerId}.${edge.dependencyType}.${edge.alias} uses forbidden direct package alias ${childInfo.parsed.name}.`,
      );
    }
    if (
      !semver.satisfies(childInfo.parsed.version, edge.specifier, {
        includePrerelease: true,
        loose: false,
      })
    ) {
      throw new AuditValidationError(
        `${edge.importerId}.${edge.dependencyType}.${edge.alias} locked version ${childInfo.parsed.version} violates manifest specifier ${edge.specifier}.`,
      );
    }
    edgeRecords.push({
      ...edge,
      child: childInfo.parsed,
      depPath,
      parentName: undefined,
    });
  }
  for (const [depPath, info] of snapshotInfoByPath) {
    for (const edge of info.edges) {
      const childInfo = snapshotInfoByPath.get(edge.depPath);
      if (!childInfo) {
        throw new AuditValidationError(
          `Dependency edge ${depPath}>${edge.alias} references missing registry snapshot ${edge.depPath}.`,
        );
      }
      const expectedReference =
        childInfo.parsed.name === edge.alias
          ? edge.depPath.slice(edge.alias.length + 1)
          : edge.depPath;
      if (edge.reference !== expectedReference) {
        throw new AuditValidationError(
          `Dependency edge ${depPath}>${edge.alias} is not encoded as canonical lockfile reference ${expectedReference}.`,
        );
      }
      edgeRecords.push({
        ...edge,
        child: childInfo.parsed,
        parentName: info.parsed.name,
      });
    }
  }
  for (const [depPath, info] of snapshotInfoByPath) {
    validatePeerContext(
      depPath,
      info.parsed,
      packages[info.parsed.packageKey],
      snapshotInfoByPath,
    );
  }
  const overrideCoverage = validateOverrideApplication(
    edgeRecords,
    packageIdentities,
  );

  const mutableOccurrences = new Map();
  const visitedSnapshotPaths = new Set();
  const snapshotReachability = new Map();
  let graphWalks = 0;
  const visit = ({
    depPath,
    importerId,
    optional,
    production,
    trail,
    onStack,
  }) => {
    graphWalks += 1;
    if (graphWalks > MAX_GRAPH_WALKS) {
      throw new AuditValidationError(
        `Lockfile traversal exceeds ${String(MAX_GRAPH_WALKS)} step limit.`,
      );
    }
    const snapshotInfo = snapshotInfoByPath.get(depPath);
    if (!snapshotInfo) {
      throw new AuditValidationError(
        `Dependency edge references missing registry package ${depPath}.`,
      );
    }
    const identity = snapshotInfo.parsed;
    visitedSnapshotPaths.add(depPath);
    let reachability = snapshotReachability.get(depPath);
    if (!reachability) {
      reachability = { reachedNonDev: false, reachedNonOptional: false };
      snapshotReachability.set(depPath, reachability);
    }
    if (production) reachability.reachedNonDev = true;
    if (!optional) reachability.reachedNonOptional = true;
    const nextTrail = [...trail, identity.name];
    const key = occurrenceKey(identity.name, identity.version);
    let occurrence = mutableOccurrences.get(key);
    if (!occurrence) {
      occurrence = {
        name: identity.name,
        version: identity.version,
        paths: new Set(),
        reachedNonDev: false,
        reachedNonOptional: false,
      };
      mutableOccurrences.set(key, occurrence);
    }
    occurrence.paths.add([importerId, ...nextTrail].join(">"));
    if (occurrence.paths.size > MAX_PATHS_PER_PACKAGE_VERSION) {
      throw new AuditValidationError(
        `${identity.name}@${identity.version} exceeds full path reporting limit; refusing to truncate.`,
      );
    }
    if (production) occurrence.reachedNonDev = true;
    if (!optional) occurrence.reachedNonOptional = true;
    if (onStack.has(depPath)) return;

    const nextOnStack = new Set(onStack);
    nextOnStack.add(depPath);
    const walkEdges = (dependencyType, edgeOptional) => {
      for (const edge of snapshotInfo.edges.filter(
        (candidate) => candidate.dependencyType === dependencyType,
      )) {
        visit({
          depPath: edge.depPath,
          importerId,
          optional: optional || edgeOptional,
          production,
          trail: nextTrail,
          onStack: nextOnStack,
        });
      }
    };
    walkEdges("dependencies", false);
    walkEdges("optionalDependencies", true);
  };

  for (const edge of importerEdges) {
    visit({
      depPath: dependencyPathForReference(edge.alias, edge.reference),
      importerId: edge.importerId,
      optional: edge.dependencyType === "optionalDependencies",
      production: edge.dependencyType !== "devDependencies",
      trail: [],
      onStack: new Set(),
    });
  }

  const unreachableSnapshots = sortedStrings(snapshotInfoByPath.keys()).filter(
    (depPath) => !visitedSnapshotPaths.has(depPath),
  );
  if (unreachableSnapshots.length > 0) {
    throw new AuditValidationError(
      `Lockfile contains unreachable dependency snapshots: ${unreachableSnapshots.slice(0, 10).join(", ")}.`,
    );
  }
  for (const [depPath, info] of snapshotInfoByPath) {
    const reachability = snapshotReachability.get(depPath);
    const expectedOptional = !reachability.reachedNonOptional;
    const recordedOptional = info.snapshot.optional === true;
    if (recordedOptional !== expectedOptional) {
      throw new AuditValidationError(
        `Dependency snapshot ${depPath} optional classification does not match complete importer graph.`,
      );
    }
    const packageSnapshot = packages[info.parsed.packageKey];
    if (
      (packageSnapshot.cpu !== undefined ||
        packageSnapshot.libc !== undefined ||
        packageSnapshot.os !== undefined) &&
      !recordedOptional
    ) {
      throw new AuditValidationError(
        `Platform-specific package ${depPath} must remain optional in every dependency path.`,
      );
    }
  }
  const observedPackagePairs = new Set(mutableOccurrences.keys());
  if (
    !sameStrings(
      sortedStrings(observedPackagePairs),
      sortedStrings(expectedPackagePairs),
    )
  ) {
    const missing = sortedStrings(expectedPackagePairs).filter(
      (key) => !observedPackagePairs.has(key),
    );
    throw new AuditValidationError(
      `Lockfile contains unreachable registry package versions: ${missing
        .slice(0, 10)
        .map((key) => key.replace("\0", "@"))
        .join(", ")}.`,
    );
  }

  const occurrences = new Map();
  let dependencies = 0;
  let devDependencies = 0;
  let optionalDependencies = 0;
  const versionsByName = new Map();
  for (const occurrence of mutableOccurrences.values()) {
    const dev = !occurrence.reachedNonDev;
    const optional = !occurrence.reachedNonOptional;
    const finalized = {
      name: occurrence.name,
      version: occurrence.version,
      paths: sortedStrings(occurrence.paths),
      dev,
      optional,
    };
    occurrences.set(
      occurrenceKey(finalized.name, finalized.version),
      finalized,
    );
    if (!dev && !optional) dependencies += 1;
    if (dev) devDependencies += 1;
    if (optional) optionalDependencies += 1;
    let versions = versionsByName.get(finalized.name);
    if (!versions) {
      versions = new Set();
      versionsByName.set(finalized.name, versions);
    }
    versions.add(finalized.version);
  }
  const request = Object.fromEntries(
    sortedStrings(versionsByName.keys()).map((name) => [
      name,
      sortedStrings(versionsByName.get(name)),
    ]),
  );
  const requestBytes = Buffer.byteLength(JSON.stringify(request));
  if (requestBytes > MAX_REQUEST_BYTES) {
    throw new AuditValidationError(
      `Bulk advisory request exceeds ${String(MAX_REQUEST_BYTES)} byte limit.`,
    );
  }
  const graph = {
    request,
    occurrences,
    provenance: {
      packageIdentities,
      packageSnapshots: packages,
      snapshotInfoByPath,
    },
    dependencyCounts: {
      dependencies,
      devDependencies,
      optionalDependencies,
      totalDependencies: occurrences.size,
    },
    lockfile: {
      path: "pnpm-lock.yaml",
      sha256: createHash("sha256").update(lockfileSource).digest("hex"),
      version: EXPECTED_LOCKFILE_VERSION,
      workspaceImporters: importerIds,
    },
    supplyChain: {
      allowedRegistries: [CANONICAL_REGISTRY],
      integrity: {
        algorithm: "sha512",
        completeDigestBytes: 64,
        entries: packageIdentities.size,
      },
      lifecycleScripts: {
        allowed: sortedStrings(
          Object.entries(EXPECTED_ALLOW_BUILDS)
            .filter(([, allowed]) => allowed)
            .map(([name]) => name),
        ),
        denied: sortedStrings(
          Object.entries(EXPECTED_ALLOW_BUILDS)
            .filter(([, allowed]) => !allowed)
            .map(([name]) => name),
        ),
        packages: Object.fromEntries(
          Object.entries(EXPECTED_LIFECYCLE_PACKAGES).map(
            ([packageKey, policy]) => [
              packageKey,
              {
                allowed: policy.allowed,
                gypfile: policy.gypfile,
                scripts: { ...policy.scripts },
              },
            ],
          ),
        ),
      },
      overrides: { ...EXPECTED_OVERRIDES },
      overrideCoverage,
      packageExtensions: [],
      patchedDependencies: [],
      catalogs: [],
      resolution: "canonical-registry-identity-with-implicit-tarball",
      snapshots: snapshotInfoByPath.size,
    },
  };
  validateGraph(graph);
  return graph;
}

function parsePinnedMise(source) {
  const sections = {};
  let currentSection;
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const sectionMatch = line.match(/^\[([a-z]+)\]$/u);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (Object.hasOwn(sections, currentSection)) {
        throw new AuditValidationError(
          `mise.toml repeats section ${currentSection}.`,
        );
      }
      sections[currentSection] = {};
      continue;
    }
    const assignment = line.match(
      /^(?:"([A-Za-z0-9_:/-]+)"|([A-Za-z0-9_-]+))\s*=\s*"([^"\\]*)"$/u,
    );
    if (!assignment || !currentSection) {
      throw new AuditValidationError(
        `mise.toml line ${String(index + 1)} uses unsupported or ambiguous TOML syntax.`,
      );
    }
    const [, quotedKey, bareKey, value] = assignment;
    const key = quotedKey ?? bareKey;
    if (Object.hasOwn(sections[currentSection], key)) {
      throw new AuditValidationError(
        `mise.toml repeats ${currentSection}.${key}.`,
      );
    }
    sections[currentSection][key] = value;
  }
  return sections;
}

function validateMisePolicy(rootDir) {
  const misePath = path.join(rootDir, "mise.toml");
  requireRegularRepositoryFile(misePath, "mise.toml");
  const mise = parsePinnedMise(
    readBoundedFile(misePath, "mise.toml", 64 * 1024),
  );
  requireExactValue(
    mise,
    {
      hooks: {
        postinstall:
          "node scripts/audit-preflight.mjs && pnpm --filter . install --frozen-lockfile --ignore-pnpmfile --ignore-scripts --registry=https://registry.npmjs.org/ --config.trust-lockfile=false --config.verify-store-integrity=true",
      },
      tasks: { ci: "pnpm run ci:pr" },
      tools: {
        actionlint: "1.7.12",
        gitleaks: "8.30.1",
        node: EXPECTED_NODE_VERSION,
        "npm:pnpm": EXPECTED_PNPM_VERSION,
        shellcheck: "0.11.0",
      },
    },
    "mise.toml toolchain policy",
  );
}

function validateWorkflowAction(rawStep, workflowName, jobName, stepIndex) {
  if (rawStep.uses === undefined) return;
  const uses = requireString(
    rawStep.uses,
    `${workflowName}.${jobName}.steps[${String(stepIndex)}].uses`,
  );
  // Local reusable workflow calls are same-repo and immutable per checkout.
  if (/^\.\/\.github\/workflows\/[\w.-]+\.ya?ml$/u.test(uses)) return;
  const match = uses.match(/^([^@\s]+)@([a-f0-9]{40})$/u);
  if (!match) {
    throw new AuditValidationError(
      `${workflowName}.${jobName} uses mutable or malformed action reference ${JSON.stringify(uses)}.`,
    );
  }
  const [, action, commit] = match;
  if (ALLOWED_ACTIONS.get(action) !== commit) {
    throw new AuditValidationError(
      `${workflowName}.${jobName} uses non-allowlisted action identity ${uses}.`,
    );
  }
  if (action === "actions/setup-node") {
    requireExactKeys(
      rawStep,
      new Set(["uses", "with"]),
      `${workflowName}.${jobName} setup-node step`,
      ["uses", "with"],
    );
    const inputs = requireExactKeys(
      rawStep.with,
      new Set([
        "architecture",
        "check-latest",
        "node-version",
        "package-manager-cache",
      ]),
      `${workflowName}.${jobName} setup-node inputs`,
      ["architecture", "check-latest", "node-version", "package-manager-cache"],
    );
    if (
      inputs.architecture !== "x64" ||
      inputs["check-latest"] !== false ||
      inputs["node-version"] !== EXPECTED_NODE_VERSION ||
      inputs["package-manager-cache"] !== false
    ) {
      throw new AuditValidationError(
        `${workflowName}.${jobName} must pin exact Node ${EXPECTED_NODE_VERSION} without mutable version or package-manager cache resolution.`,
      );
    }
  }
}

function validateAutomationEnvironment(value, label) {
  if (value === undefined) return;
  const environment = requireRecord(value, label);
  for (const key of Object.keys(environment)) {
    const upper = key.toUpperCase();
    if (
      upper === "PATH" ||
      upper === "INIT_CWD" ||
      upper === "NODE_OPTIONS" ||
      upper === "NODE_PATH" ||
      upper === "GITHUB_WORKSPACE" ||
      upper.startsWith("COREPACK_") ||
      upper.startsWith("NPM_CONFIG_") ||
      upper.startsWith("PNPM_CONFIG_")
    ) {
      throw new AuditValidationError(
        `${label} overrides protected dependency environment ${key}.`,
      );
    }
  }
}

function automationNeeds(rawNeeds, label) {
  if (rawNeeds === undefined) return [];
  const needs =
    typeof rawNeeds === "string"
      ? [rawNeeds]
      : requireArray(rawNeeds, label).map((entry, index) =>
          requireString(entry, `${label}[${String(index)}]`),
        );
  if (new Set(needs).size !== needs.length) {
    throw new AuditValidationError(`${label} contains duplicate jobs.`);
  }
  return needs;
}

function validateSetupStep(step, command, label) {
  requireExactKeys(step, new Set(["name", "run"]), label, ["name", "run"]);
  if (step.run.trim() !== command) {
    throw new AuditValidationError(`${label} must run exact ${command}.`);
  }
}

function validateWorkflowDependencyPolicy(workflow, workflowName) {
  validateAutomationEnvironment(
    workflow.env,
    `.github/workflows/${workflowName}.env`,
  );
  if (workflow.defaults !== undefined) {
    throw new AuditValidationError(
      `${workflowName} must not set workflow command defaults.`,
    );
  }
  const jobs = requireRecord(
    workflow.jobs,
    `.github/workflows/${workflowName}.jobs`,
  );
  const policies = new Map();
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const label = `.github/workflows/${workflowName}.jobs.${jobName}`;
    const job = requireRecord(rawJob, label);
    validateAutomationEnvironment(job.env, `${label}.env`);
    if (job.defaults !== undefined) {
      throw new AuditValidationError(
        `${label} must not set job command defaults.`,
      );
    }
    if (job.container !== undefined || job.services !== undefined) {
      throw new AuditValidationError(
        `${label} must not replace runner dependencies with containers or services.`,
      );
    }
    if (job["continue-on-error"] !== undefined) {
      throw new AuditValidationError(
        `${label} must not suppress job failures.`,
      );
    }
    const needs = automationNeeds(job.needs, `${label}.needs`);
    const steps = (job.steps ?? []).map((rawStep, stepIndex) => {
      const step = requireRecord(
        rawStep,
        `${label}.steps[${String(stepIndex)}]`,
      );
      validateAutomationEnvironment(
        step.env,
        `${label}.steps[${String(stepIndex)}].env`,
      );
      return step;
    });
    const setupNodeIndexes = steps
      .map((step, index) =>
        step.uses === EXPECTED_SETUP_NODE_ACTION ? index : undefined,
      )
      .filter((index) => index !== undefined);
    if (setupNodeIndexes.length > 1) {
      throw new AuditValidationError(
        `${label} invokes setup-node more than once.`,
      );
    }
    const miseIndexes = steps
      .map((step, index) =>
        step.uses === EXPECTED_MISE_ACTION ? index : undefined,
      )
      .filter((index) => index !== undefined);
    if (miseIndexes.length > 1) {
      throw new AuditValidationError(`${label} invokes mise more than once.`);
    }
    if (setupNodeIndexes.length === 1 && miseIndexes.length === 1) {
      throw new AuditValidationError(
        `${label} must not mix setup-node and mise bootstrap.`,
      );
    }
    const runSteps = steps
      .map((step, index) => ({ index, step, run: step.run }))
      .filter(({ run }) => run !== undefined)
      .map(({ index, step, run }) => ({
        index,
        step,
        run: requireString(run, `${label}.steps[${String(index)}].run`).trim(),
      }));
    for (const { index, run } of runSteps) {
      if (
        /(?:^|[\s;])(?:COREPACK_[A-Z0-9_]+|GITHUB_WORKSPACE|INIT_CWD|NODE_OPTIONS|NODE_PATH|NPM_CONFIG_[A-Z0-9_]+|PATH|PNPM_CONFIG_[A-Z0-9_]+)\s*=/iu.test(
          run,
        )
      ) {
        throw new AuditValidationError(
          `${label}.steps[${String(index)}] overrides protected dependency environment in shell.`,
        );
      }
      if (
        run === PREFLIGHT_COMMAND ||
        run === COREPACK_COMMAND ||
        run === BOOTSTRAP_INSTALL_COMMAND ||
        run === FULL_INSTALL_COMMAND ||
        run === BROWSER_INSTALL_COMMAND ||
        run === PLAIN_INSTALL_COMMAND ||
        run === REFEREE_INSTALL_COMMAND ||
        run === MISE_VERIFY_COMMAND
      ) {
        continue;
      }
      for (const forbidden of FORBIDDEN_AUTOMATION_COMMANDS) {
        if (forbidden.pattern.test(run)) {
          throw new AuditValidationError(
            `${label}.steps[${String(index)}] uses forbidden ${forbidden.reason}.`,
          );
        }
      }
    }
    const dependencyCommand = runSteps.some(({ run }) =>
      /(?:^|[\s;&|])(?:bun|corepack|e2e\/|node|npm|npx|pnpm|tsx|yarn)(?:\s|$)/u.test(
        run,
      ),
    );
    const usesToolchain =
      setupNodeIndexes.length === 1 || miseIndexes.length === 1;
    if (dependencyCommand && !usesToolchain) {
      throw new AuditValidationError(
        `${label} executes dependency code without pinned setup-node or mise bootstrap.`,
      );
    }
    const preflightSteps = runSteps.filter(
      ({ run }) => run === PREFLIGHT_COMMAND,
    );
    const corepackSteps = runSteps.filter(
      ({ run }) => run === COREPACK_COMMAND,
    );
    const bootstrapInstallSteps = runSteps.filter(
      ({ run }) => run === BOOTSTRAP_INSTALL_COMMAND,
    );
    const fullInstallSteps = runSteps.filter(
      ({ run }) => run === FULL_INSTALL_COMMAND,
    );
    const auditSteps = runSteps.filter(({ run }) => run === AUDIT_COMMAND);
    const rebuildSteps = runSteps.filter(({ run }) => run === REBUILD_COMMAND);
    if (miseIndexes.length === 1) {
      const verifySteps = runSteps.filter(
        ({ run }) => run === MISE_VERIFY_COMMAND,
      );
      const plainInstalls = runSteps.filter(
        ({ run }) => run === PLAIN_INSTALL_COMMAND,
      );
      const hasInlineAudit = auditSteps.length === 1;
      const installs = hasInlineAudit ? bootstrapInstallSteps : plainInstalls;
      if (verifySteps.length !== 1 || installs.length !== 1) {
        throw new AuditValidationError(
          `${label} must verify exact Node/pnpm and install once with a frozen lockfile after the pinned mise bootstrap.`,
        );
      }
      if (!(
        miseIndexes[0] < verifySteps[0].index &&
        verifySteps[0].index < installs[0].index
      )) {
        throw new AuditValidationError(
          `${label} must order mise bootstrap, toolchain verification, then frozen install.`,
        );
      }
      if (hasInlineAudit && auditSteps[0].index <= installs[0].index) {
        throw new AuditValidationError(
          `${label} must audit after the frozen no-script bootstrap install.`,
        );
      }
    } else if (usesToolchain) {
      const hasInlineAudit = auditSteps.length === 1;
      if (
        preflightSteps.length !== 1 ||
        corepackSteps.length !== 1 ||
        (hasInlineAudit && bootstrapInstallSteps.length !== 1) ||
        (!hasInlineAudit && bootstrapInstallSteps.length !== 0) ||
        (!hasInlineAudit && fullInstallSteps.length !== 1) ||
        (hasInlineAudit && fullInstallSteps.length > 1)
      ) {
        throw new AuditValidationError(
          `${label} must use exact root bootstrap before inline audit or exact full install after upstream audit.`,
        );
      }
      const install = hasInlineAudit
        ? bootstrapInstallSteps[0]
        : fullInstallSteps[0];
      validateSetupStep(
        install.step,
        install.run,
        `${label}.steps[${String(install.index)}]`,
      );
      const setupNodeIndex = setupNodeIndexes[0];
      const preflight = preflightSteps[0];
      const corepack = corepackSteps[0];
      validateSetupStep(
        preflight.step,
        PREFLIGHT_COMMAND,
        `${label}.steps[${String(preflight.index)}]`,
      );
      validateSetupStep(
        corepack.step,
        COREPACK_COMMAND,
        `${label}.steps[${String(corepack.index)}]`,
      );
      if (
        preflight.index !== setupNodeIndex + 1 ||
        corepack.index !== preflight.index + 1 ||
        install.index !== corepack.index + 1 ||
        runSteps.some(({ index }) => index < setupNodeIndex)
      ) {
        throw new AuditValidationError(
          `${label} must run preflight, enable Corepack, and install frozen dependencies immediately after pinned setup-node before any other command.`,
        );
      }
    } else if (
      preflightSteps.length > 0 ||
      corepackSteps.length > 0 ||
      bootstrapInstallSteps.length > 0 ||
      fullInstallSteps.length > 0 ||
      auditSteps.length > 0 ||
      rebuildSteps.length > 0
    ) {
      throw new AuditValidationError(
        `${label} uses dependency setup without pinned setup-node.`,
      );
    }
    if (auditSteps.length > 1) {
      throw new AuditValidationError(
        `${label} invokes dependency audit more than once.`,
      );
    }
    if (rebuildSteps.length > 1) {
      throw new AuditValidationError(
        `${label} invokes pnpm rebuild more than once.`,
      );
    }
    if (auditSteps.length === 1) {
      const audit = auditSteps[0];
      validateSetupStep(
        audit.step,
        AUDIT_COMMAND,
        `${label}.steps[${String(audit.index)}]`,
      );
      if (
        bootstrapInstallSteps.length !== 1 ||
        audit.index <= bootstrapInstallSteps[0].index
      ) {
        throw new AuditValidationError(
          `${label} must audit after isolated frozen no-script bootstrap.`,
        );
      }
      if (
        runSteps.some(
          ({ index }) =>
            index > bootstrapInstallSteps[0].index && index < audit.index,
        )
      ) {
        throw new AuditValidationError(
          `${label} executes dependency code before audit.`,
        );
      }
    }
    if (fullInstallSteps.length === 1) {
      const fullInstall = fullInstallSteps[0];
      validateSetupStep(
        fullInstall.step,
        FULL_INSTALL_COMMAND,
        `${label}.steps[${String(fullInstall.index)}]`,
      );
      if (auditSteps.length === 1) {
        if (fullInstall.index <= auditSteps[0].index) {
          throw new AuditValidationError(
            `${label} must install full workspace only after dependency audit.`,
          );
        }
        if (
          runSteps.some(
            ({ index }) =>
              index > auditSteps[0].index && index < fullInstall.index,
          )
        ) {
          throw new AuditValidationError(
            `${label} executes dependency code before audited full workspace install.`,
          );
        }
      }
    }
    const operationalRuns = runSteps.filter(
      ({ run }) =>
        run !== PREFLIGHT_COMMAND &&
        run !== COREPACK_COMMAND &&
        run !== BOOTSTRAP_INSTALL_COMMAND &&
        run !== FULL_INSTALL_COMMAND &&
        run !== AUDIT_COMMAND &&
        run !== REBUILD_COMMAND &&
        /(?:^|[\s;&|])(?:bun|corepack|e2e\/|node|npm|npx|pnpm|tsx|yarn)(?:\s|$)/u.test(
          run,
        ),
    );
    if (
      auditSteps.length === 1 &&
      fullInstallSteps.length === 0 &&
      operationalRuns.some(({ run }) => run !== "pnpm run format")
    ) {
      throw new AuditValidationError(
        `${label} executes non-bootstrap dependency code without audited full workspace install.`,
      );
    }
    if (rebuildSteps.length === 1) {
      const rebuild = rebuildSteps[0];
      validateSetupStep(
        rebuild.step,
        REBUILD_COMMAND,
        `${label}.steps[${String(rebuild.index)}]`,
      );
      const gateIndex =
        fullInstallSteps[0]?.index ??
        auditSteps[0]?.index ??
        bootstrapInstallSteps[0]?.index;
      if (gateIndex === undefined || rebuild.index <= gateIndex) {
        throw new AuditValidationError(
          `${label} must rebuild only after dependency gate.`,
        );
      }
      if (
        runSteps.some(({ index }) => index > gateIndex && index < rebuild.index)
      ) {
        throw new AuditValidationError(
          `${label} executes dependency code before allowlisted rebuild.`,
        );
      }
    }
    policies.set(jobName, {
      audit: auditSteps.length === 1,
      dependencyCommand,
      ifExpression: job.if,
      needs,
      usesToolchain,
    });
  }

  const reachesAudit = (jobName, visiting = new Set()) => {
    if (visiting.has(jobName)) {
      throw new AuditValidationError(
        `${workflowName} dependency job graph contains a cycle at ${jobName}.`,
      );
    }
    const policy = policies.get(jobName);
    if (!policy) {
      throw new AuditValidationError(
        `${workflowName} references missing dependency job ${jobName}.`,
      );
    }
    if (policy.audit) return true;
    const next = new Set(visiting).add(jobName);
    return policy.needs.some((dependency) => reachesAudit(dependency, next));
  };
  for (const [jobName, policy] of policies) {
    if (!policy.usesToolchain) continue;
    if (!reachesAudit(jobName)) {
      throw new AuditValidationError(
        `${workflowName}.${jobName} can execute dependency code without successful audit dependency.`,
      );
    }
    if (
      !policy.audit &&
      typeof policy.ifExpression === "string" &&
      /\b(?:always|cancelled|failure)\s*\(/u.test(policy.ifExpression)
    ) {
      throw new AuditValidationError(
        `${workflowName}.${jobName} can bypass failed audit with status condition.`,
      );
    }
  }
}

export function validateAutomationPolicy(rootDirectory = PROJECT_ROOT) {
  const rootDir = realpathSync(rootDirectory);
  validateMisePolicy(rootDir);
  const workflowDirectory = path.join(rootDir, ".github", "workflows");
  let entries;
  try {
    entries = readdirSync(workflowDirectory, { withFileTypes: true });
  } catch {
    throw new AuditValidationError(".github/workflows is missing.");
  }
  const workflows = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  if (workflows.length === 0) {
    throw new AuditValidationError(
      "No GitHub workflows are available to gate.",
    );
  }
  let ciWorkflow;
  for (const entry of workflows) {
    const workflowPath = path.join(workflowDirectory, entry.name);
    requireRegularRepositoryFile(
      workflowPath,
      `.github/workflows/${entry.name}`,
    );
    const workflow = parseYamlObject(
      readBoundedFile(
        workflowPath,
        `.github/workflows/${entry.name}`,
        2 * 1024 * 1024,
      ),
      `.github/workflows/${entry.name}`,
    );
    if (entry.name === "ci.yml") ciWorkflow = workflow;
    validateWorkflowDependencyPolicy(workflow, entry.name);
    const jobs = requireRecord(
      workflow.jobs,
      `.github/workflows/${entry.name}.jobs`,
    );
    for (const [jobName, rawJob] of Object.entries(jobs)) {
      const job = requireRecord(
        rawJob,
        `.github/workflows/${entry.name}.jobs.${jobName}`,
      );
      if (job.uses !== undefined) {
        validateWorkflowAction(
          { uses: job.uses, with: job.with },
          entry.name,
          jobName,
          0,
        );
      }
      if (job.steps === undefined) continue;
      const steps = requireArray(
        job.steps,
        `.github/workflows/${entry.name}.jobs.${jobName}.steps`,
      );
      for (const [stepIndex, rawStep] of steps.entries()) {
        validateWorkflowAction(
          requireRecord(
            rawStep,
            `.github/workflows/${entry.name}.jobs.${jobName}.steps[${String(stepIndex)}]`,
          ),
          entry.name,
          jobName,
          stepIndex,
        );
      }
    }
  }
  if (!ciWorkflow) {
    throw new AuditValidationError(".github/workflows/ci.yml is missing.");
  }
  const ciJobs = requireRecord(ciWorkflow.jobs, "ci workflow jobs");
  const security = requireRecord(ciJobs.security, "ci security job");
  const securitySteps = requireArray(security.steps, "ci security steps");
  const auditSteps = securitySteps.filter(
    (step) => isRecord(step) && step.run?.trim() === AUDIT_COMMAND,
  );
  if (auditSteps.length !== 1) {
    throw new AuditValidationError(
      "CI security job must invoke exact node scripts/audit.mjs once.",
    );
  }
  const aggregate = requireRecord(ciJobs.ci, "ci aggregate job");
  const needs = requireArray(aggregate.needs, "ci aggregate needs");
  if (!needs.includes("security")) {
    throw new AuditValidationError(
      "CI aggregate job must require dependency security result.",
    );
  }
  return workflows.length;
}

function inferPatchedVersions(vulnerableRange) {
  const trimmed = vulnerableRange.trim();
  const lessThan = trimmed.match(/^<\s*(\d+\.\d+\.\d[\w+.-]*)\s*$/);
  if (lessThan) return `>=${lessThan[1]}`;
  const lessThanOrEqual = trimmed.match(/^<=\s*(\d+\.\d+\.\d[\w+.-]*)\s*$/);
  if (lessThanOrEqual) {
    const nextVersion = semver.inc(lessThanOrEqual[1], "patch");
    if (nextVersion) return `>=${nextVersion}`;
  }
  return null;
}

function deriveGithubAdvisoryId(url) {
  const match = url.match(/\/(GHSA-[\w-]+)/i);
  return match ? match[1].toUpperCase() : "";
}

function validateCwe(value, label) {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.length > 0) return value;
  const cwes = requireArray(value, label);
  if (cwes.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new AuditValidationError(
      `${label} must contain only non-empty strings.`,
    );
  }
  return [...cwes];
}

function validateCvss(value, label) {
  if (value === undefined) return undefined;
  const cvss = requireRecord(value, label);
  const keys = sortedStrings(Object.keys(cvss));
  if (!sameStrings(keys, ["score", "vectorString"])) {
    throw new AuditValidationError(
      `${label} schema changed; expected score and vectorString.`,
    );
  }
  if (
    typeof cvss.score !== "number" ||
    !Number.isFinite(cvss.score) ||
    cvss.score < 0 ||
    cvss.score > 10
  ) {
    throw new AuditValidationError(`${label}.score must be between 0 and 10.`);
  }
  if (cvss.vectorString !== null && typeof cvss.vectorString !== "string") {
    throw new AuditValidationError(
      `${label}.vectorString must be a string or null.`,
    );
  }
  return { score: cvss.score, vectorString: cvss.vectorString };
}

function validateRawAdvisory(advisory, packageName, index, graph) {
  const label = `bulk response.${packageName}[${String(index)}]`;
  const value = requireRecord(advisory, label);
  const unknownKeys = Object.keys(value).filter(
    (key) => !RAW_ADVISORY_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new AuditValidationError(
      `${label} contains unsupported fields: ${sortedStrings(unknownKeys).join(", ")}.`,
    );
  }
  const id = requirePositiveInteger(value.id, `${label}.id`);
  const title = requireString(value.title, `${label}.title`);
  const url = requireString(value.url, `${label}.url`);
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new AuditValidationError(`${label}.url must be an absolute URL.`);
  }
  if (parsedUrl.protocol !== "https:") {
    throw new AuditValidationError(`${label}.url must use HTTPS.`);
  }
  if (value.name !== undefined && value.name !== packageName) {
    throw new AuditValidationError(
      `${label}.name does not bind to requested package ${packageName}.`,
    );
  }
  const severity = requireString(value.severity, `${label}.severity`);
  if (!CAPTURED_SEVERITIES.has(severity)) {
    throw new AuditValidationError(
      `${label}.severity has unsupported value ${JSON.stringify(severity)}.`,
    );
  }
  const vulnerableVersions = requireString(
    value.vulnerable_versions,
    `${label}.vulnerable_versions`,
  );
  if (
    semver.validRange(vulnerableVersions, {
      includePrerelease: true,
      loose: false,
    }) === null
  ) {
    throw new AuditValidationError(
      `${label}.vulnerable_versions is not a valid semver range.`,
    );
  }
  const requestedVersions = requireArray(
    graph.request[packageName],
    `request.${packageName}`,
  );
  const affectedVersions = requestedVersions.filter((version) =>
    semver.satisfies(version, vulnerableVersions, {
      includePrerelease: true,
      loose: false,
    }),
  );
  if (affectedVersions.length === 0) {
    throw new AuditValidationError(
      `${label} does not match any requested ${packageName} version.`,
    );
  }
  const findings = affectedVersions.map((version) => {
    const occurrence = requireRecord(
      graph.occurrences.get(occurrenceKey(packageName, version)),
      `occurrence ${packageName}@${version}`,
    );
    return {
      version,
      paths: [...occurrence.paths],
      dev: occurrence.dev,
      optional: occurrence.optional,
      bundled: false,
    };
  });
  const cwe = validateCwe(value.cwe, `${label}.cwe`);
  const cvss = validateCvss(value.cvss, `${label}.cvss`);
  return {
    id,
    module_name: packageName,
    severity,
    title,
    url,
    github_advisory_id: deriveGithubAdvisoryId(url),
    vulnerable_versions: vulnerableVersions,
    patched_versions: inferPatchedVersions(vulnerableVersions),
    ...(cwe === undefined ? {} : { cwe }),
    ...(cvss === undefined ? {} : { cvss }),
    findings,
  };
}

export function evaluateBulkAdvisories(rawResponse, graph) {
  validateGraph(graph);
  const response = requireRecord(rawResponse, "bulk advisory response");
  const advisories = [];
  const seenIds = new Set();
  for (const packageName of sortedStrings(Object.keys(response))) {
    if (!Object.hasOwn(graph.request, packageName)) {
      throw new AuditValidationError(
        `Bulk response package ${packageName} was not requested from exact lockfile graph.`,
      );
    }
    const packageAdvisories = requireArray(
      response[packageName],
      `bulk response.${packageName}`,
    );
    if (packageAdvisories.length === 0) {
      throw new AuditValidationError(
        `bulk response.${packageName} must not be an empty advisory array.`,
      );
    }
    for (const [index, rawAdvisory] of packageAdvisories.entries()) {
      const advisory = validateRawAdvisory(
        rawAdvisory,
        packageName,
        index,
        graph,
      );
      if (seenIds.has(advisory.id)) {
        throw new AuditValidationError(
          `Bulk response contains duplicate advisory id ${String(advisory.id)}.`,
        );
      }
      seenIds.add(advisory.id);
      advisories.push(advisory);
    }
  }
  advisories.sort(
    (left, right) =>
      left.id - right.id ||
      (left.module_name < right.module_name
        ? -1
        : left.module_name > right.module_name
          ? 1
          : 0),
  );
  const counts = Object.fromEntries(
    severities.map((severity) => [
      severity,
      advisories.filter((advisory) => advisory.severity === severity).length,
    ]),
  );
  if (
    Object.values(counts).reduce((sum, count) => sum + count, 0) !==
    advisories.length
  ) {
    throw new AuditValidationError(
      "Advisory severity counts do not reconcile with advisory detail.",
    );
  }
  const blockingAdvisories = advisories.filter((advisory) =>
    BLOCKING_SEVERITIES.has(advisory.severity),
  );
  const summary = {
    policy: {
      command: "node scripts/audit.mjs",
      registry: CANONICAL_REGISTRY,
      endpoint: BULK_ADVISORY_URL.href,
      dependencyScope: [...DEPENDENCY_TYPES],
      blocks: ["high", "critical"],
      reportsWithoutBlocking: ["info", "low", "moderate"],
      allowlist: [],
      networkTimeoutsMs: {
        connect: CONNECT_TIMEOUT_MS,
        idle: IDLE_TIMEOUT_MS,
        total: TOTAL_TIMEOUT_MS,
      },
    },
    lockfile: graph.lockfile,
    supplyChain: graph.supplyChain,
    vulnerabilities: counts,
    dependencyGraph: graph.dependencyCounts,
    advisories,
  };
  return {
    blockingAdvisories,
    exitCode: blockingAdvisories.length > 0 ? 1 : 0,
    summary,
  };
}

function signalChild(child, signal) {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Process may have exited between timeout and signal delivery.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Close/error event settles result.
  }
}

export function runBoundedChild(
  command,
  args,
  {
    cwd = PROJECT_ROOT,
    env = process.env,
    timeoutMs = CHILD_TIMEOUT_MS,
    killGraceMs = CHILD_KILL_GRACE_MS,
    maxBuffer = 1024 * 1024,
    label = command,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(
        new AuditValidationError(
          `Unable to start ${label}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminationReason;
    let forceKillTimer;
    let settled = false;

    const terminate = (reason) => {
      if (terminationReason !== undefined) return;
      terminationReason = reason;
      signalChild(child, "SIGTERM");
      forceKillTimer = setTimeout(
        () => signalChild(child, "SIGKILL"),
        killGraceMs,
      );
    };
    const timeout = setTimeout(
      () => terminate(`${label} timed out after ${String(timeoutMs)}ms.`),
      timeoutMs,
    );
    const collect = (chunks, chunk, stream) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stream === "stdout") stdoutBytes += buffer.length;
      else stderrBytes += buffer.length;
      if (stdoutBytes > maxBuffer || stderrBytes > maxBuffer) {
        terminate(`${label} exceeded ${String(maxBuffer)} byte output limit.`);
        return;
      }
      chunks.push(buffer);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(
        new AuditValidationError(
          `Unable to run ${label}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (terminationReason !== undefined) {
        reject(new AuditValidationError(terminationReason));
        return;
      }
      resolve({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function requireChildSuccess(result, label) {
  if (result.status !== 0 || result.signal !== null) {
    throw new AuditValidationError(
      `${label} exited ${String(result.status)}${result.signal ? ` via ${result.signal}` : ""}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

async function inspectPnpm(environment) {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const commandOptions = { cwd: PROJECT_ROOT, env: environment };
  const versionResult = await runBoundedChild(pnpm, ["--version"], {
    ...commandOptions,
    label: "pnpm --version",
  });
  const pnpmVersion = requireChildSuccess(
    versionResult,
    "pnpm --version",
  ).trim();
  if (pnpmVersion !== EXPECTED_PNPM_VERSION) {
    throw new AuditValidationError(
      `pnpm version must be exactly ${EXPECTED_PNPM_VERSION}; found ${pnpmVersion || "empty output"}.`,
    );
  }
  const configResult = await runBoundedChild(
    pnpm,
    ["config", "list", "--json"],
    { ...commandOptions, label: "pnpm config list" },
  );
  const config = parseJsonObject(
    requireChildSuccess(configResult, "pnpm config list"),
    "pnpm config",
  );
  validateAuditConfig(config);

  const tokenKey = "//registry.npmjs.org/:_authToken";
  const tokenConfigured = Object.hasOwn(config, tokenKey);
  const tokenResult = await runBoundedChild(
    pnpm,
    ["config", "get", "--json", tokenKey],
    { ...commandOptions, label: "pnpm registry credential lookup" },
  );
  const tokenOutput = requireChildSuccess(
    tokenResult,
    "pnpm registry credential lookup",
  ).trim();
  const tokenValue =
    tokenOutput === ""
      ? undefined
      : parseJson(tokenOutput, "pnpm registry credential lookup");
  if (
    tokenValue !== null &&
    tokenValue !== undefined &&
    (typeof tokenValue !== "string" || tokenValue.length === 0)
  ) {
    throw new AuditValidationError(
      "pnpm registry credential lookup returned an unexpected value.",
    );
  }
  if (tokenConfigured && !tokenValue) {
    throw new AuditValidationError(
      "Canonical registry token is configured but could not be resolved.",
    );
  }
  return {
    authorization: tokenValue ? `Bearer ${tokenValue}` : undefined,
    version: pnpmVersion,
  };
}

function boundedHttpError(message) {
  return new AuditValidationError(`Bulk advisory request failed: ${message}`);
}

export function postBoundedJson(
  endpoint,
  payload,
  {
    authorization,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    idleTimeoutMs = IDLE_TIMEOUT_MS,
    totalTimeoutMs = TOTAL_TIMEOUT_MS,
    maxRequestBytes = MAX_REQUEST_BYTES,
    maxResponseBytes = MAX_RESPONSE_BYTES,
    requestImpl = httpsRequest,
    requestOptions = {},
  } = {},
) {
  const url = endpoint instanceof URL ? endpoint : new URL(endpoint);
  const body = JSON.stringify(payload);
  const requestBytes = Buffer.byteLength(body);
  if (requestBytes > maxRequestBytes) {
    return Promise.reject(
      boundedHttpError(
        `payload exceeds ${String(maxRequestBytes)} byte request limit.`,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let connectTimer;
    let request;
    const settleError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      if (connectTimer) clearTimeout(connectTimer);
      if (request && !request.destroyed) request.destroy();
      reject(
        error instanceof AuditValidationError
          ? error
          : boundedHttpError(
              error instanceof Error ? error.message : String(error),
            ),
      );
    };
    const totalTimer = setTimeout(() => {
      const error = boundedHttpError(
        `total timeout after ${String(totalTimeoutMs)}ms.`,
      );
      settleError(error);
    }, totalTimeoutMs);

    try {
      request = requestImpl(
        url,
        {
          agent: false,
          ...requestOptions,
          method: "POST",
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "identity",
            "Content-Length": String(requestBytes),
            "Content-Type": "application/json",
            "User-Agent": `zevium-dependency-audit/1 pnpm/${EXPECTED_PNPM_VERSION} node/${process.versions.node}`,
            ...(authorization === undefined
              ? {}
              : { Authorization: authorization }),
          },
        },
        (response) => {
          if (connectTimer) clearTimeout(connectTimer);
          const status = response.statusCode;
          if (status !== 200) {
            response.destroy();
            settleError(
              boundedHttpError(`registry returned HTTP ${String(status)}.`),
            );
            return;
          }
          const contentType = response.headers["content-type"];
          if (
            contentType !== undefined &&
            (typeof contentType !== "string" ||
              !/^application\/json(?:\s*;|$)/i.test(contentType))
          ) {
            response.destroy();
            settleError(
              boundedHttpError("registry returned non-JSON content type."),
            );
            return;
          }
          const contentEncoding = response.headers["content-encoding"];
          if (
            contentEncoding !== undefined &&
            String(contentEncoding).toLowerCase() !== "identity"
          ) {
            response.destroy();
            settleError(
              boundedHttpError("registry ignored identity content encoding."),
            );
            return;
          }
          const declaredLength = response.headers["content-length"];
          if (declaredLength !== undefined) {
            const length = Number(declaredLength);
            if (!Number.isSafeInteger(length) || length < 0) {
              response.destroy();
              settleError(
                boundedHttpError("registry returned invalid Content-Length."),
              );
              return;
            }
            if (length > maxResponseBytes) {
              response.destroy();
              settleError(
                boundedHttpError(
                  `response exceeds ${String(maxResponseBytes)} byte limit.`,
                ),
              );
              return;
            }
          }
          const chunks = [];
          let responseBytes = 0;
          response.on("data", (chunk) => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            responseBytes += buffer.length;
            if (responseBytes > maxResponseBytes) {
              const error = boundedHttpError(
                `response exceeds ${String(maxResponseBytes)} byte limit.`,
              );
              response.destroy(error);
              settleError(error);
              return;
            }
            chunks.push(buffer);
          });
          response.once("aborted", () =>
            settleError(boundedHttpError("registry response was truncated.")),
          );
          response.once("error", settleError);
          response.once("end", () => {
            if (settled) return;
            if (!response.complete) {
              settleError(
                boundedHttpError("registry response was incomplete."),
              );
              return;
            }
            const rawBody = Buffer.concat(chunks).toString("utf8");
            let parsed;
            try {
              parsed = parseJson(rawBody, "bulk advisory response");
            } catch (error) {
              settleError(
                boundedHttpError(
                  `registry returned invalid JSON: ${error instanceof Error ? error.message : String(error)}.`,
                ),
              );
              return;
            }
            settled = true;
            clearTimeout(totalTimer);
            resolve(parsed);
          });
        },
      );
    } catch (error) {
      settleError(error);
      return;
    }
    request.setTimeout(idleTimeoutMs, () => {
      const error = boundedHttpError(
        `idle timeout after ${String(idleTimeoutMs)}ms.`,
      );
      settleError(error);
    });
    request.once("socket", (socket) => {
      const connectedEvent =
        url.protocol === "https:" ? "secureConnect" : "connect";
      connectTimer = setTimeout(() => {
        const error = boundedHttpError(
          `connect timeout after ${String(connectTimeoutMs)}ms.`,
        );
        settleError(error);
      }, connectTimeoutMs);
      socket.once(connectedEvent, () => {
        if (connectTimer) clearTimeout(connectTimer);
      });
    });
    request.once("error", settleError);
    request.end(body);
  });
}

function encodeRegistryPackageName(packageName) {
  if (!packageName.startsWith("@")) return encodeURIComponent(packageName);
  const separator = packageName.indexOf("/");
  return `${packageName.slice(0, separator)}%2F${packageName.slice(separator + 1)}`;
}

function getBoundedJson(
  endpoint,
  {
    authorization,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    idleTimeoutMs = IDLE_TIMEOUT_MS,
    totalTimeoutMs = TOTAL_TIMEOUT_MS,
    maxResponseBytes = MAX_METADATA_RESPONSE_BYTES,
    requestImpl = httpsRequest,
  } = {},
) {
  const url = endpoint instanceof URL ? endpoint : new URL(endpoint);
  if (
    url.protocol !== "https:" ||
    url.origin !== new URL(CANONICAL_REGISTRY).origin
  ) {
    return Promise.reject(
      new AuditValidationError(
        `Registry metadata URL is not allowlisted: ${url.href}.`,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let connectTimer;
    let request;
    const settleError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      if (connectTimer) clearTimeout(connectTimer);
      if (request && !request.destroyed) request.destroy();
      reject(
        error instanceof AuditValidationError
          ? error
          : new AuditValidationError(
              `Registry metadata request failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
      );
    };
    const totalTimer = setTimeout(
      () =>
        settleError(
          new AuditValidationError(
            `Registry metadata request timed out after ${String(totalTimeoutMs)}ms.`,
          ),
        ),
      totalTimeoutMs,
    );
    try {
      request = requestImpl(
        url,
        {
          agent: false,
          method: "GET",
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "identity",
            "User-Agent": `zevium-dependency-audit/1 pnpm/${EXPECTED_PNPM_VERSION} node/${process.versions.node}`,
            ...(authorization === undefined
              ? {}
              : { Authorization: authorization }),
          },
        },
        (response) => {
          if (connectTimer) clearTimeout(connectTimer);
          if (response.statusCode !== 200) {
            response.destroy();
            settleError(
              new AuditValidationError(
                `Registry metadata request returned HTTP ${String(response.statusCode)} for ${url.pathname}.`,
              ),
            );
            return;
          }
          const contentType = response.headers["content-type"];
          if (
            contentType !== undefined &&
            (typeof contentType !== "string" ||
              !/^application\/json(?:\s*;|$)/iu.test(contentType))
          ) {
            response.destroy();
            settleError(
              new AuditValidationError(
                `Registry metadata returned non-JSON content for ${url.pathname}.`,
              ),
            );
            return;
          }
          const contentEncoding = response.headers["content-encoding"];
          if (
            contentEncoding !== undefined &&
            String(contentEncoding).toLowerCase() !== "identity"
          ) {
            response.destroy();
            settleError(
              new AuditValidationError(
                `Registry metadata returned unsupported content encoding for ${url.pathname}.`,
              ),
            );
            return;
          }
          const chunks = [];
          let bytes = 0;
          response.on("data", (chunk) => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > maxResponseBytes) {
              const error = new AuditValidationError(
                `Registry metadata exceeds ${String(maxResponseBytes)} bytes for ${url.pathname}.`,
              );
              response.destroy(error);
              settleError(error);
              return;
            }
            chunks.push(buffer);
          });
          response.once("aborted", () =>
            settleError(
              new AuditValidationError(
                `Registry metadata response was truncated for ${url.pathname}.`,
              ),
            ),
          );
          response.once("error", settleError);
          response.once("end", () => {
            if (settled) return;
            if (!response.complete) {
              settleError(
                new AuditValidationError(
                  `Registry metadata response was incomplete for ${url.pathname}.`,
                ),
              );
              return;
            }
            try {
              const parsed = parseJson(
                Buffer.concat(chunks).toString("utf8"),
                `Registry metadata ${url.pathname}`,
              );
              settled = true;
              clearTimeout(totalTimer);
              resolve(parsed);
            } catch (error) {
              settleError(error);
            }
          });
        },
      );
    } catch (error) {
      settleError(error);
      return;
    }
    request.setTimeout(idleTimeoutMs, () =>
      settleError(
        new AuditValidationError(
          `Registry metadata request idle timeout after ${String(idleTimeoutMs)}ms.`,
        ),
      ),
    );
    request.once("socket", (socket) => {
      connectTimer = setTimeout(
        () =>
          settleError(
            new AuditValidationError(
              `Registry metadata connect timeout after ${String(connectTimeoutMs)}ms.`,
            ),
          ),
        connectTimeoutMs,
      );
      socket.once("secureConnect", () => {
        if (connectTimer) clearTimeout(connectTimer);
      });
    });
    request.once("error", settleError);
    request.end();
  });
}

function optionalRecord(value, label) {
  return value === undefined ? {} : requireRecord(value, label);
}

function optionalStringArray(value, label) {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  const entries = requireArray(value, label);
  for (const [index, entry] of entries.entries()) {
    requireString(entry, `${label}[${String(index)}]`);
  }
  return entries;
}

function registryPeerPolicy(metadata, label) {
  const peers = {
    ...optionalRecord(metadata.peerDependencies, `${label}.peerDependencies`),
  };
  const rawMeta = optionalRecord(
    metadata.peerDependenciesMeta,
    `${label}.peerDependenciesMeta`,
  );
  const meta = {};
  for (const [peerName, rawEntry] of Object.entries(rawMeta)) {
    validatePackageName(peerName, `${label}.peerDependenciesMeta key`);
    const entry = requireExactKeys(
      rawEntry,
      new Set(["optional"]),
      `${label}.peerDependenciesMeta.${peerName}`,
      ["optional"],
    );
    requireBoolean(
      entry.optional,
      `${label}.peerDependenciesMeta.${peerName}.optional`,
    );
    if (entry.optional === true) {
      meta[peerName] = { optional: true };
      if (!Object.hasOwn(peers, peerName)) peers[peerName] = "*";
    }
  }
  validateNonemptyStringMapOrEmpty(peers, `${label}.peerDependencies`);
  return { meta, peers };
}

function validateRegistryDependenciesMeta(
  metadata,
  dependencies,
  optionalDependencies,
  label,
) {
  if (metadata.dependenciesMeta === undefined) return;
  const meta = requireRecord(
    metadata.dependenciesMeta,
    `${label}.dependenciesMeta`,
  );
  if (Object.keys(meta).length === 0) {
    throw new AuditValidationError(
      `${label}.dependenciesMeta must not be empty when present.`,
    );
  }
  for (const [dependencyName, rawEntry] of Object.entries(meta)) {
    validatePackageName(dependencyName, `${label}.dependenciesMeta key`);
    const entry = requireExactKeys(
      rawEntry,
      new Set(["optional"]),
      `${label}.dependenciesMeta.${dependencyName}`,
      ["optional"],
    );
    const optional = requireBoolean(
      entry.optional,
      `${label}.dependenciesMeta.${dependencyName}.optional`,
    );
    const expectedContainer = optional ? optionalDependencies : dependencies;
    if (!Object.hasOwn(expectedContainer, dependencyName)) {
      throw new AuditValidationError(
        `${label}.dependenciesMeta.${dependencyName} does not match registry dependency kind.`,
      );
    }
  }
}

function validateNonemptyStringMapOrEmpty(value, label) {
  const record = requireRecord(value, label);
  for (const [key, entry] of Object.entries(record)) {
    validatePackageName(key, `${label} key`);
    requireString(entry, `${label}.${key}`);
  }
  return record;
}

function parseRegistryDependencySpecifier(alias, specifier, label) {
  const value = requireString(specifier, label);
  let name = alias;
  let range = value;
  if (value.startsWith("npm:")) {
    const target = value.slice(4);
    const slashIndex = target.startsWith("@") ? target.indexOf("/") : -1;
    const separatorIndex = target.indexOf(
      "@",
      slashIndex === -1 ? 1 : slashIndex + 1,
    );
    if (separatorIndex <= 0) {
      throw new AuditValidationError(
        `${label} has malformed npm alias ${JSON.stringify(value)}.`,
      );
    }
    name = validatePackageName(
      target.slice(0, separatorIndex),
      `${label} alias target`,
    );
    range = target.slice(separatorIndex + 1);
  }
  const ranges = peerRangeAlternatives(range);
  if (ranges.length === 0) {
    throw new AuditValidationError(
      `${label} uses mutable, local, URL, git, or non-semver specifier ${JSON.stringify(value)}.`,
    );
  }
  return { name, ranges };
}

function overrideVersionFor(parentName, alias) {
  return (
    EXPECTED_OVERRIDES[`${parentName}>${alias}`] ?? EXPECTED_OVERRIDES[alias]
  );
}

function validateResolvedRegistryDependency(
  edge,
  alias,
  specifier,
  identity,
  label,
) {
  if (!edge) {
    throw new AuditValidationError(
      `${label} has no matching resolved lockfile edge.`,
    );
  }
  const parsedSpecifier = parseRegistryDependencySpecifier(
    alias,
    specifier,
    label,
  );
  if (edge.child.name !== parsedSpecifier.name) {
    throw new AuditValidationError(
      `${label} resolves canonical package ${edge.child.name}, expected ${parsedSpecifier.name}.`,
    );
  }
  const overrideVersion = overrideVersionFor(identity.name, alias);
  if (overrideVersion !== undefined) {
    if (edge.child.version !== overrideVersion) {
      throw new AuditValidationError(
        `${label} violates pinned override version ${overrideVersion}.`,
      );
    }
    return;
  }
  if (
    !parsedSpecifier.ranges.some((range) =>
      semver.satisfies(edge.child.version, range, {
        includePrerelease: true,
        loose: false,
      }),
    )
  ) {
    throw new AuditValidationError(
      `${label} resolves ${edge.child.version}, outside metadata semver ranges ${parsedSpecifier.ranges.join(" || ")}.`,
    );
  }
}

function validateRegistryDependencyKinds(
  metadata,
  identity,
  variantInfos,
  label,
) {
  const dependencies = optionalRecord(
    metadata.dependencies,
    `${label}.dependencies`,
  );
  const optionalDependencies = optionalRecord(
    metadata.optionalDependencies,
    `${label}.optionalDependencies`,
  );
  validateNonemptyStringMapOrEmpty(dependencies, `${label}.dependencies`);
  validateNonemptyStringMapOrEmpty(
    optionalDependencies,
    `${label}.optionalDependencies`,
  );
  validateRegistryDependenciesMeta(
    metadata,
    dependencies,
    optionalDependencies,
    label,
  );
  const bundled = new Set([
    ...optionalStringArray(
      metadata.bundledDependencies,
      `${label}.bundledDependencies`,
    ),
    ...optionalStringArray(
      metadata.bundleDependencies,
      `${label}.bundleDependencies`,
    ),
  ]);
  const peerPolicy = registryPeerPolicy(metadata, label);
  const regularNames = new Set(
    Object.keys(dependencies).filter(
      (name) =>
        !Object.hasOwn(optionalDependencies, name) && !bundled.has(name),
    ),
  );
  const optionalNames = new Set(
    Object.keys(optionalDependencies).filter((name) => !bundled.has(name)),
  );

  for (const info of variantInfos) {
    const edgeByAlias = new Map(info.edges.map((edge) => [edge.alias, edge]));
    const expectedDependencies = new Set(regularNames);
    const expectedOptionalDependencies = new Set(optionalNames);
    for (const peerName of Object.keys(peerPolicy.peers)) {
      if (!edgeByAlias.has(peerName)) continue;
      if (peerPolicy.meta[peerName]?.optional === true) {
        expectedOptionalDependencies.add(peerName);
      } else {
        expectedDependencies.add(peerName);
      }
    }
    const actualDependencies = new Set(
      info.edges
        .filter((edge) => edge.dependencyType === "dependencies")
        .map((edge) => edge.alias),
    );
    const actualOptionalDependencies = new Set(
      info.edges
        .filter((edge) => edge.dependencyType === "optionalDependencies")
        .map((edge) => edge.alias),
    );
    if (
      !sameStrings(
        sortedStrings(actualDependencies),
        sortedStrings(expectedDependencies),
      ) ||
      !sameStrings(
        sortedStrings(actualOptionalDependencies),
        sortedStrings(expectedOptionalDependencies),
      )
    ) {
      throw new AuditValidationError(
        `${label} dependency-kind classification does not match lock snapshot ${info.parsed.depPath}.`,
      );
    }
    for (const dependencyName of regularNames) {
      validateResolvedRegistryDependency(
        edgeByAlias.get(dependencyName),
        dependencyName,
        dependencies[dependencyName],
        identity,
        `${label}.dependencies.${dependencyName}`,
      );
    }
    for (const dependencyName of optionalNames) {
      validateResolvedRegistryDependency(
        edgeByAlias.get(dependencyName),
        dependencyName,
        optionalDependencies[dependencyName],
        identity,
        `${label}.optionalDependencies.${dependencyName}`,
      );
    }
    for (const [peerName, peerRange] of Object.entries(peerPolicy.peers)) {
      const edge = edgeByAlias.get(peerName);
      if (!edge) continue;
      validateResolvedRegistryDependency(
        edge,
        peerName,
        peerRange,
        identity,
        `${label}.peerDependencies.${peerName}`,
      );
    }
  }
  return peerPolicy;
}

export function validateRegistryMetadata(
  rawMetadata,
  identity,
  packageSnapshot,
  variantInfos,
) {
  const label = `registry metadata ${identity.name}@${identity.version}`;
  const metadata = requireRecord(rawMetadata, label);
  if (
    metadata.name !== identity.name ||
    metadata.version !== identity.version
  ) {
    throw new AuditValidationError(
      `${label} does not bind canonical name and version.`,
    );
  }
  const dist = requireRecord(metadata.dist, `${label}.dist`);
  const registryIntegrity = validateStrongIntegrity(
    dist.integrity,
    `${label}.dist.integrity`,
  );
  if (registryIntegrity !== packageSnapshot.resolution.integrity) {
    throw new AuditValidationError(
      `${label} integrity does not match pnpm-lock.yaml.`,
    );
  }
  const tarball = requireString(dist.tarball, `${label}.dist.tarball`);
  let tarballUrl;
  try {
    tarballUrl = new URL(tarball);
  } catch {
    throw new AuditValidationError(`${label}.dist.tarball must be absolute.`);
  }
  const registryOrigin = new URL(CANONICAL_REGISTRY).origin;
  if (
    tarballUrl.protocol !== "https:" ||
    tarballUrl.origin !== registryOrigin ||
    tarballUrl.username !== "" ||
    tarballUrl.password !== "" ||
    tarballUrl.search !== "" ||
    tarballUrl.hash !== ""
  ) {
    throw new AuditValidationError(
      `${label}.dist.tarball leaves canonical registry allowlist.`,
    );
  }
  const expectedPath = identity.name.startsWith("@")
    ? `/${identity.name}/-/${identity.name.slice(identity.name.indexOf("/") + 1)}-${identity.version}.tgz`
    : `/${identity.name}/-/${identity.name}-${identity.version}.tgz`;
  if (decodeURIComponent(tarballUrl.pathname) !== expectedPath) {
    throw new AuditValidationError(
      `${label}.dist.tarball does not match canonical package identity and version.`,
    );
  }

  const registryEngines = optionalRecord(metadata.engines, `${label}.engines`);
  const lockedEngines = packageSnapshot.engines ?? {};
  requireExactValue(lockedEngines, registryEngines, `${label}.engines`);
  for (const field of ["cpu", "libc", "os"]) {
    requireExactValue(
      sortedStrings(packageSnapshot[field] ?? []),
      sortedStrings(optionalStringArray(metadata[field], `${label}.${field}`)),
      `${label}.${field}`,
    );
  }
  const bundled = new Set([
    ...optionalStringArray(
      metadata.bundledDependencies,
      `${label}.bundledDependencies`,
    ),
    ...optionalStringArray(
      metadata.bundleDependencies,
      `${label}.bundleDependencies`,
    ),
  ]);
  requireExactValue(
    sortedStrings(packageSnapshot.bundledDependencies ?? []),
    sortedStrings(bundled),
    `${label}.bundledDependencies`,
  );
  const hasBin =
    typeof metadata.bin === "string"
      ? metadata.bin.length > 0
      : isRecord(metadata.bin) && Object.keys(metadata.bin).length > 0;
  if ((packageSnapshot.hasBin === true) !== hasBin) {
    throw new AuditValidationError(`${label}.bin does not match lock hasBin.`);
  }
  const peerPolicy = validateRegistryDependencyKinds(
    metadata,
    identity,
    variantInfos,
    label,
  );
  requireExactValue(
    packageSnapshot.peerDependencies ?? {},
    peerPolicy.peers,
    `${label}.peerDependencies`,
  );
  requireExactValue(
    packageSnapshot.peerDependenciesMeta ?? {},
    peerPolicy.meta,
    `${label}.peerDependenciesMeta`,
  );
  const scripts = optionalRecord(metadata.scripts, `${label}.scripts`);
  const installScripts = Object.fromEntries(
    ["preinstall", "install", "postinstall"]
      .filter((scriptName) => scripts[scriptName] !== undefined)
      .map((scriptName) => [
        scriptName,
        requireString(scripts[scriptName], `${label}.scripts.${scriptName}`),
      ]),
  );
  if (metadata.gypfile !== undefined) {
    requireBoolean(metadata.gypfile, `${label}.gypfile`);
  }
  const lifecyclePolicy = EXPECTED_LIFECYCLE_PACKAGES[identity.packageKey];
  const hasExecutableLifecycle =
    Object.keys(installScripts).length > 0 || metadata.gypfile === true;
  if (hasExecutableLifecycle && lifecyclePolicy === undefined) {
    throw new AuditValidationError(
      `${label} has unclassified install lifecycle scripts: ${Object.keys(installScripts).join(", ") || "implicit node-gyp"}.`,
    );
  }
  if (lifecyclePolicy !== undefined) {
    requireExactValue(
      installScripts,
      lifecyclePolicy.scripts,
      `${label}.install lifecycle scripts`,
    );
    if ((metadata.gypfile === true) !== lifecyclePolicy.gypfile) {
      throw new AuditValidationError(
        `${label}.gypfile does not match pinned lifecycle package policy.`,
      );
    }
    if (EXPECTED_ALLOW_BUILDS[identity.name] !== lifecyclePolicy.allowed) {
      throw new AuditValidationError(
        `${label} allowBuilds decision does not match pinned lifecycle package policy.`,
      );
    }
  }
}

async function verifyRegistryProvenance(graph, authorization) {
  if (!isRecord(graph.provenance)) {
    throw new AuditValidationError("Audit graph provenance is missing.");
  }
  const identities = [...graph.provenance.packageIdentities.values()];
  const variantsByPackageKey = new Map();
  for (const info of graph.provenance.snapshotInfoByPath.values()) {
    const enrichedInfo = {
      ...info,
      edges: info.edges.map((edge) => ({
        ...edge,
        child: graph.provenance.snapshotInfoByPath.get(edge.depPath)?.parsed,
      })),
    };
    let variants = variantsByPackageKey.get(info.parsed.packageKey);
    if (!variants) {
      variants = [];
      variantsByPackageKey.set(info.parsed.packageKey, variants);
    }
    variants.push(enrichedInfo);
  }
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(METADATA_CONCURRENCY, identities.length) },
    async () => {
      while (cursor < identities.length) {
        const identity = identities[cursor];
        cursor += 1;
        const endpoint = new URL(
          `${encodeRegistryPackageName(identity.name)}/${encodeURIComponent(identity.version)}`,
          CANONICAL_REGISTRY,
        );
        const metadata = await getBoundedJson(endpoint, { authorization });
        validateRegistryMetadata(
          metadata,
          identity,
          graph.provenance.packageSnapshots[identity.packageKey],
          variantsByPackageKey.get(identity.packageKey),
        );
      }
    },
  );
  await Promise.all(workers);
}

async function requestBulkAdvisories(request, authorization) {
  return postBoundedJson(BULK_ADVISORY_URL, request, { authorization });
}

export async function runAudit({
  args = process.argv.slice(2),
  cwd = process.cwd(),
  environment = process.env,
  requestAdvisories = requestBulkAdvisories,
  verifyProvenance = verifyRegistryProvenance,
} = {}) {
  if (bootstrapError !== undefined) throw bootstrapError;
  validateAuditArguments(args);
  validateAuditEnvironment(environment);
  validateWorkspaceRoot(cwd, environment.INIT_CWD);
  if (process.versions.node !== EXPECTED_NODE_VERSION) {
    throw new AuditValidationError(
      `Node version must be exactly ${EXPECTED_NODE_VERSION}; found ${process.versions.node}.`,
    );
  }
  const graph = loadWorkspaceAuditGraph();
  validateAutomationPolicy();
  const pnpm = await inspectPnpm(environment);
  await verifyProvenance(graph, pnpm.authorization);
  const rawResponse = await requestAdvisories(
    graph.request,
    pnpm.authorization,
  );
  return evaluateBulkAdvisories(rawResponse, graph);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderSummaryHtml(summary) {
  return `## Dependency audit\n\n<pre>${escapeHtml(JSON.stringify(summary, null, 2))}</pre>\n`;
}

export async function main() {
  try {
    const outcome = await runAudit();
    console.log(JSON.stringify(outcome.summary, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        renderSummaryHtml(outcome.summary),
      );
    }
    if (outcome.blockingAdvisories.length > 0) {
      console.error(
        `Dependency audit blocked: ${String(outcome.blockingAdvisories.length)} high/critical advisories found.`,
      );
    }
    return outcome.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Dependency audit\n\n<pre>${escapeHtml(JSON.stringify({ infrastructureError: message }, null, 2))}</pre>\n`,
      );
    }
    return 2;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
