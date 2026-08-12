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

import semver from "semver";
import { parseDocument } from "yaml";

export const severities = ["info", "low", "moderate", "high", "critical"];
export const CANONICAL_REGISTRY = "https://registry.npmjs.org/";
export const BULK_ADVISORY_URL = new URL(
  "-/npm/v1/security/advisories/bulk",
  CANONICAL_REGISTRY,
);

const PROJECT_ROOT = realpathSync(
  fileURLToPath(new URL("../", import.meta.url)),
);
const EXPECTED_PNPM_VERSION = "11.8.0";
const EXPECTED_LOCKFILE_VERSION = "9.0";
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);
const CAPTURED_SEVERITIES = new Set(severities);
const DEPENDENCY_TYPES = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];
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
  "PNPM_REGISTRY",
  "PNPM_WORKSPACE",
  "PNPM_WORKSPACE_ROOT",
]);
const BUILTIN_SCOPED_REGISTRIES = new Map([
  ["@jsr:registry", "https://npm.jsr.io/"],
]);
const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_VERSIONS = 50_000;
const MAX_GRAPH_WALKS = 2_000_000;
const MAX_PATHS_PER_PACKAGE_VERSION = 10_000;
const CHILD_TIMEOUT_MS = 5_000;
const CHILD_KILL_GRACE_MS = 250;
const CONNECT_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 20_000;

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

function normalizeConfigKey(key) {
  return key.replaceAll(/[-_.:@/]/g, "").toLowerCase();
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AuditValidationError(`${label} returned invalid JSON: ${detail}`);
  }
}

function parseJsonObject(stdout, label) {
  return requireRecord(parseJson(stdout, label), label);
}

function parseYamlObject(source, label) {
  const document = parseDocument(source, {
    merge: false,
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new AuditValidationError(
      `${label} is invalid YAML: ${document.errors[0].message}`,
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
    if (key === "registry") {
      if (value !== CANONICAL_REGISTRY) {
        throw new AuditValidationError(
          `registry overrides canonical ${CANONICAL_REGISTRY}.`,
        );
      }
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
      throw new AuditValidationError(
        `${key} overrides audit scope, registry, lockfile, or filtering policy.`,
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

function expectedWorkspaceImporters(rootDir, workspaceManifest) {
  const importers = new Set(["."]);
  const patterns = requireArray(
    workspaceManifest.packages,
    "workspace.packages",
  );
  for (const [index, patternValue] of patterns.entries()) {
    const pattern = requireString(
      patternValue,
      `workspace.packages[${String(index)}]`,
    );
    if (
      pattern.includes("\\") ||
      pattern.startsWith("/") ||
      pattern.includes("..")
    ) {
      throw new AuditValidationError(
        `workspace.packages[${String(index)}] is not a safe repository-relative pattern.`,
      );
    }
    const starMatch = pattern.match(/^([^*?[\]{}!]+)\/\*$/);
    const candidates = [];
    if (starMatch) {
      const parent = path.resolve(rootDir, starMatch[1]);
      if (!parent.startsWith(`${rootDir}${path.sep}`)) {
        throw new AuditValidationError(
          "Workspace pattern escapes repository root.",
        );
      }
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          candidates.push(path.join(parent, entry.name));
        }
      }
    } else if (!pattern.match(/[*?[\]{}!]/)) {
      candidates.push(path.resolve(rootDir, pattern));
    } else {
      throw new AuditValidationError(
        `Unsupported workspace pattern ${JSON.stringify(pattern)}; audit cannot prove exact importer coverage.`,
      );
    }
    for (const candidate of candidates) {
      const manifestPath = path.join(candidate, "package.json");
      try {
        if (!lstatSync(manifestPath).isFile()) continue;
      } catch {
        continue;
      }
      importers.add(
        path.relative(rootDir, candidate).split(path.sep).join("/"),
      );
    }
  }
  return sortedStrings(importers);
}

function validateImporterManifest(rootDir, importerId, importer) {
  const manifestPath = path.join(
    rootDir,
    importerId === "." ? "package.json" : `${importerId}/package.json`,
  );
  const manifest = parseJsonObject(
    readBoundedFile(
      manifestPath,
      `${importerId}/package.json`,
      2 * 1024 * 1024,
    ),
    `${importerId}/package.json`,
  );
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
      const lockedDependency = requireRecord(
        locked[dependencyName],
        `${importerId}.${dependencyType}.${dependencyName}`,
      );
      if (lockedDependency.specifier !== declared[dependencyName]) {
        throw new AuditValidationError(
          `${importerId}.${dependencyType}.${dependencyName} specifier does not match package.json.`,
        );
      }
      requireString(
        lockedDependency.version,
        `${importerId}.${dependencyType}.${dependencyName}.version`,
      );
    }
  }
}

function indexOfDepPathSuffix(depPath) {
  if (!depPath.endsWith(")")) return -1;
  let open = 1;
  for (let index = depPath.length - 2; index >= 0; index -= 1) {
    if (depPath[index] === "(") open -= 1;
    else if (depPath[index] === ")") open += 1;
    else if (open === 0) return index + 1;
  }
  return -1;
}

function packageIdentity(depPath, packageSnapshot) {
  const suffixIndex = indexOfDepPathSuffix(depPath);
  const withoutSuffix =
    suffixIndex === -1 ? depPath : depPath.slice(0, suffixIndex);
  const separatorIndex = withoutSuffix.indexOf("@", 1);
  if (separatorIndex === -1) {
    throw new AuditValidationError(
      `Lockfile package key ${JSON.stringify(depPath)} has no name/version separator.`,
    );
  }
  const name = packageSnapshot.name ?? withoutSuffix.slice(0, separatorIndex);
  const version =
    packageSnapshot.version ?? withoutSuffix.slice(separatorIndex + 1);
  requireString(name, `packages.${depPath}.name`);
  requireString(version, `packages.${depPath}.version`);
  if (
    name.includes("\0") ||
    /\s/.test(name) ||
    (!name.startsWith("@") && name.includes("/")) ||
    (name.startsWith("@") && name.split("/").length !== 2)
  ) {
    throw new AuditValidationError(
      `Lockfile package ${JSON.stringify(depPath)} has invalid package name ${JSON.stringify(name)}.`,
    );
  }
  if (semver.valid(version) === null) {
    throw new AuditValidationError(
      `Lockfile package ${JSON.stringify(depPath)} has unsupported non-semver version ${JSON.stringify(version)}.`,
    );
  }
  return { name, version };
}

function dependencyPathForReference(alias, dependency) {
  const reference = isRecord(dependency)
    ? requireString(dependency.version, `${alias}.version`)
    : requireString(dependency, alias);
  if (reference.startsWith("link:") || reference.startsWith("workspace:")) {
    return null;
  }
  if (reference[0] === "@") return reference;
  const atIndex = reference.indexOf("@");
  if (atIndex === -1) return `${alias}@${reference}`;
  const colonIndex = reference.indexOf(":");
  const bracketIndex = reference.indexOf("(");
  if (
    (colonIndex === -1 || atIndex < colonIndex) &&
    (bracketIndex === -1 || atIndex < bracketIndex)
  ) {
    return reference;
  }
  return `${alias}@${reference}`;
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

export function loadWorkspaceAuditGraph() {
  const rootDir = PROJECT_ROOT;
  const lockfilePath = path.join(rootDir, "pnpm-lock.yaml");
  const workspacePath = path.join(rootDir, "pnpm-workspace.yaml");
  if (realpathSync(lockfilePath) !== lockfilePath) {
    throw new AuditValidationError(
      "Repository pnpm-lock.yaml resolves outside exact workspace path.",
    );
  }
  const lockfileSource = readBoundedFile(lockfilePath, "pnpm-lock.yaml");
  const workspaceSource = readBoundedFile(
    workspacePath,
    "pnpm-workspace.yaml",
    2 * 1024 * 1024,
  );
  const lockfile = parseYamlObject(lockfileSource, "pnpm-lock.yaml");
  const workspace = parseYamlObject(workspaceSource, "pnpm-workspace.yaml");
  if (String(lockfile.lockfileVersion) !== EXPECTED_LOCKFILE_VERSION) {
    throw new AuditValidationError(
      `pnpm-lock.yaml version must be ${EXPECTED_LOCKFILE_VERSION}.`,
    );
  }
  const importers = requireRecord(lockfile.importers, "lockfile.importers");
  const importerIds = sortedStrings(Object.keys(importers));
  const expectedImporters = expectedWorkspaceImporters(rootDir, workspace);
  if (!sameStrings(importerIds, expectedImporters)) {
    throw new AuditValidationError(
      `Lockfile importers do not exactly match workspace: lockfile=${importerIds.join(",")}; workspace=${expectedImporters.join(",")}.`,
    );
  }
  for (const importerId of importerIds) {
    validateImporterManifest(
      rootDir,
      importerId,
      requireRecord(importers[importerId], `lockfile.importers.${importerId}`),
    );
  }

  const packages = requireRecord(lockfile.packages, "lockfile.packages");
  const snapshots = requireRecord(lockfile.snapshots, "lockfile.snapshots");
  const identities = new Map();
  const expectedPackagePairs = new Set();
  for (const depPath of sortedStrings(Object.keys(packages))) {
    const packageSnapshot = requireRecord(
      packages[depPath],
      `lockfile.packages.${depPath}`,
    );
    const resolution = requireRecord(
      packageSnapshot.resolution,
      `lockfile.packages.${depPath}.resolution`,
    );
    requireString(
      resolution.integrity,
      `lockfile.packages.${depPath}.resolution.integrity`,
    );
    const identity = packageIdentity(depPath, packageSnapshot);
    expectedPackagePairs.add(occurrenceKey(identity.name, identity.version));
  }
  const packageKeysWithSnapshots = new Set();
  for (const depPath of sortedStrings(Object.keys(snapshots))) {
    const suffixIndex = indexOfDepPathSuffix(depPath);
    const packageKey =
      suffixIndex === -1 ? depPath : depPath.slice(0, suffixIndex);
    const packageSnapshot = packages[packageKey];
    if (packageSnapshot === undefined) {
      throw new AuditValidationError(
        `Dependency snapshot ${depPath} has no matching canonical package metadata.`,
      );
    }
    identities.set(
      depPath,
      packageIdentity(
        depPath,
        requireRecord(packageSnapshot, `lockfile.packages.${packageKey}`),
      ),
    );
    packageKeysWithSnapshots.add(packageKey);
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

  const mutableOccurrences = new Map();
  const visitedSnapshotPaths = new Set();
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
    const identity = identities.get(depPath);
    if (!identity) {
      throw new AuditValidationError(
        `Dependency edge references missing registry package ${depPath}.`,
      );
    }
    visitedSnapshotPaths.add(depPath);
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

    const snapshot = requireRecord(
      snapshots[depPath],
      `lockfile.snapshots.${depPath}`,
    );
    const nextOnStack = new Set(onStack);
    nextOnStack.add(depPath);
    const walkEdges = (dependencies, edgeOptional) => {
      for (const [alias, reference] of Object.entries(dependencies)) {
        const childPath = dependencyPathForReference(alias, reference);
        if (childPath === null) continue;
        visit({
          depPath: childPath,
          importerId,
          optional: optional || edgeOptional,
          production,
          trail: nextTrail,
          onStack: nextOnStack,
        });
      }
    };
    walkEdges(
      snapshot.dependencies === undefined
        ? {}
        : requireRecord(
            snapshot.dependencies,
            `lockfile.snapshots.${depPath}.dependencies`,
          ),
      false,
    );
    walkEdges(
      snapshot.optionalDependencies === undefined
        ? {}
        : requireRecord(
            snapshot.optionalDependencies,
            `lockfile.snapshots.${depPath}.optionalDependencies`,
          ),
      true,
    );
  };

  for (const importerId of importerIds) {
    const importer = requireRecord(
      importers[importerId],
      `lockfile.importers.${importerId}`,
    );
    for (const dependencyType of DEPENDENCY_TYPES) {
      const dependencies =
        importer[dependencyType] === undefined
          ? {}
          : requireRecord(
              importer[dependencyType],
              `lockfile.importers.${importerId}.${dependencyType}`,
            );
      for (const [alias, dependency] of Object.entries(dependencies)) {
        const depPath = dependencyPathForReference(alias, dependency);
        if (depPath === null) continue;
        visit({
          depPath,
          importerId,
          optional: dependencyType === "optionalDependencies",
          production: dependencyType !== "devDependencies",
          trail: [],
          onStack: new Set(),
        });
      }
    }
  }

  const unreachableSnapshots = sortedStrings(identities.keys()).filter(
    (depPath) => !visitedSnapshotPaths.has(depPath),
  );
  if (unreachableSnapshots.length > 0) {
    throw new AuditValidationError(
      `Lockfile contains unreachable dependency snapshots: ${unreachableSnapshots.slice(0, 10).join(", ")}.`,
    );
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
  };
  validateGraph(graph);
  return graph;
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
  if (!new Set(["https:", "http:"]).has(parsedUrl.protocol)) {
    throw new AuditValidationError(`${label}.url must use HTTP or HTTPS.`);
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
      loose: true,
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
      loose: true,
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
              parsed = JSON.parse(rawBody);
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

async function requestBulkAdvisories(request, authorization) {
  return postBoundedJson(BULK_ADVISORY_URL, request, { authorization });
}

export async function runAudit({
  args = process.argv.slice(2),
  cwd = process.cwd(),
  environment = process.env,
  requestAdvisories = requestBulkAdvisories,
} = {}) {
  validateAuditArguments(args);
  validateAuditEnvironment(environment);
  validateWorkspaceRoot(cwd, environment.INIT_CWD);
  const graph = loadWorkspaceAuditGraph();
  const pnpm = await inspectPnpm(environment);
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
