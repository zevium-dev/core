import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_NODE_VERSION = "24.15.0";
const EXPECTED_PACKAGE_MANAGER =
  "pnpm@11.8.0+sha512.c1f5e7c4cb241c8f174b743851d82f42b802324afc8b0f116b96adb15aa06664948dde36960a3ba1079ba5b4b29dd0140135b94b5b5f5263592249d68e555f26";
const BOOT_PACKAGES = Object.freeze({
  semver: {
    files: 53,
    treeSha512:
      "d583a6e22f6c035140a42966b62eba9e212ddbf6b780416c3194a5e19a66199183e423b3d6accb90eb6ed24149767d42c8ed83c1c573537f9705c274395c0414",
    version: "7.8.5",
    packageBlock: `  semver@7.8.5:
    resolution: {integrity: sha512-Y7/KDsb8LjooZpwaqGyulO6DQlksgCncchHGk+sZIY4SBvUocMBEFH5Ur1fI4dV+Jvl0w6cjvucaIi40puRioA==}
    engines: {node: '>=10'}
    hasBin: true`,
    expandedPackageBlock: `  semver@7.8.5:
    resolution:
      integrity: sha512-Y7/KDsb8LjooZpwaqGyulO6DQlksgCncchHGk+sZIY4SBvUocMBEFH5Ur1fI4dV+Jvl0w6cjvucaIi40puRioA==
    engines:
      node: ">=10"
    hasBin: true`,
  },
  yaml: {
    files: 233,
    treeSha512:
      "93f483a0bc0aac31996906d47116ef820f922aa5f61649cae735320e82b1726ffcf862adce42a9ca07ba4274ce7bdbe4320ab4b406da25661aa27ced5f2c894f",
    version: "2.9.0",
    packageBlock: `  yaml@2.9.0:
    resolution: {integrity: sha512-2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==}
    engines: {node: '>= 14.6'}
    hasBin: true`,
    expandedPackageBlock: `  yaml@2.9.0:
    resolution:
      integrity: sha512-2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==
    engines:
      node: ">= 14.6"
    hasBin: true`,
  },
});

const ROOT = realpathSync(fileURLToPath(new URL("../", import.meta.url)));

export class AuditBootstrapError extends Error {}

function fail(message) {
  throw new AuditBootstrapError(message);
}

function readRegularFile(relativePath, maxBytes) {
  const filePath = path.join(ROOT, relativePath);
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    fail(`${relativePath} is missing during dependency audit bootstrap.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${relativePath} must be a regular, non-symlink bootstrap file.`);
  }
  if (realpathSync(filePath) !== filePath) {
    fail(`${relativePath} resolves outside exact repository bootstrap path.`);
  }
  if (stat.size > maxBytes) {
    fail(`${relativePath} exceeds bootstrap byte limit.`);
  }
  return readFileSync(filePath, "utf8");
}

function rejectDuplicateJsonKeys(source) {
  let cursor = 0;
  const whitespace = /\s/u;
  const skipWhitespace = () => {
    while (cursor < source.length && whitespace.test(source[cursor])) {
      cursor += 1;
    }
  };
  const parseString = () => {
    const start = cursor;
    cursor += 1;
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (source[cursor] === '"') {
        cursor += 1;
        return JSON.parse(source.slice(start, cursor));
      }
      cursor += 1;
    }
    fail("package.json contains unterminated JSON string.");
  };
  const parseValue = (location) => {
    skipWhitespace();
    if (source[cursor] === "{") {
      cursor += 1;
      skipWhitespace();
      const keys = new Set();
      if (source[cursor] === "}") {
        cursor += 1;
        return;
      }
      while (cursor < source.length) {
        skipWhitespace();
        if (source[cursor] !== '"') {
          fail("package.json object key is malformed during bootstrap.");
        }
        const key = parseString();
        if (keys.has(key)) {
          fail(`package.json contains duplicate JSON key ${location}${key}.`);
        }
        keys.add(key);
        skipWhitespace();
        if (source[cursor] !== ":") {
          fail("package.json object separator is malformed during bootstrap.");
        }
        cursor += 1;
        parseValue(`${location}${key}.`);
        skipWhitespace();
        if (source[cursor] === "}") {
          cursor += 1;
          return;
        }
        if (source[cursor] !== ",") {
          fail("package.json object delimiter is malformed during bootstrap.");
        }
        cursor += 1;
      }
      fail("package.json object is unterminated during bootstrap.");
    }
    if (source[cursor] === "[") {
      cursor += 1;
      skipWhitespace();
      if (source[cursor] === "]") {
        cursor += 1;
        return;
      }
      let index = 0;
      while (cursor < source.length) {
        parseValue(`${location}${String(index)}.`);
        index += 1;
        skipWhitespace();
        if (source[cursor] === "]") {
          cursor += 1;
          return;
        }
        if (source[cursor] !== ",") {
          fail("package.json array delimiter is malformed during bootstrap.");
        }
        cursor += 1;
      }
      fail("package.json array is unterminated during bootstrap.");
    }
    if (source[cursor] === '"') {
      parseString();
      return;
    }
    const start = cursor;
    while (
      cursor < source.length &&
      source[cursor] !== "," &&
      source[cursor] !== "]" &&
      source[cursor] !== "}"
    ) {
      cursor += 1;
    }
    if (source.slice(start, cursor).trim() === "") {
      fail("package.json contains empty JSON value during bootstrap.");
    }
  };
  parseValue("");
  skipWhitespace();
  if (cursor !== source.length) {
    fail("package.json contains trailing JSON content during bootstrap.");
  }
}

function parseRootManifest(source) {
  rejectDuplicateJsonKeys(source);
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    fail(
      `package.json is invalid during dependency audit bootstrap: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) {
    fail(
      "package.json must contain an object during dependency audit bootstrap.",
    );
  }
  if (
    manifest.name !== "zevium" ||
    manifest.private !== true ||
    manifest.packageManager !== EXPECTED_PACKAGE_MANAGER
  ) {
    fail(
      "package.json identity or package manager drifted during audit bootstrap.",
    );
  }
  if (
    manifest.scripts?.["audit:ci"] !== "node scripts/audit.mjs" ||
    manifest.devDependencies === null ||
    typeof manifest.devDependencies !== "object" ||
    Array.isArray(manifest.devDependencies)
  ) {
    fail("package.json audit bootstrap controls are missing.");
  }
  for (const [name, expected] of Object.entries(BOOT_PACKAGES)) {
    if (manifest.devDependencies[name] !== expected.version) {
      fail(
        `package.json must pin audit bootstrap package ${name}@${expected.version}.`,
      );
    }
  }
}

function indentation(line) {
  const match = line.match(/^ */u);
  return match ? match[0].length : 0;
}

function exactYamlBlock(lines, key, indent, label) {
  const prefix = `${" ".repeat(indent)}${key}:`;
  const indexes = lines
    .map((line, index) => (line === prefix ? index : -1))
    .filter((index) => index !== -1);
  if (indexes.length !== 1) {
    fail(`${label} must occur exactly once during audit bootstrap.`);
  }
  const start = indexes[0];
  let end = start + 1;
  while (
    end < lines.length &&
    (lines[end].trim() === "" || indentation(lines[end]) > indent)
  ) {
    end += 1;
  }
  while (end > start + 1 && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end);
}

function topLevelSection(lines, key) {
  return exactYamlBlock(lines, key, 0, `pnpm-lock.yaml ${key} section`);
}

function validateBootLockfile(source) {
  if (
    /\t/u.test(source) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(source)
  ) {
    fail("pnpm-lock.yaml contains unsafe bootstrap whitespace or controls.");
  }
  if (/^[ ]*(?:<<\s*:|[^#\n]*[&*!][A-Za-z0-9_-]+)/mu.test(source)) {
    fail(
      "pnpm-lock.yaml uses YAML aliases, anchors, merges, or tags during bootstrap.",
    );
  }
  const lines = source.split(/\r?\n/u);
  const importers = topLevelSection(lines, "importers");
  const rootImporter = exactYamlBlock(
    importers,
    ".",
    2,
    "pnpm-lock.yaml root importer",
  );
  const rootDevDependencies = exactYamlBlock(
    rootImporter,
    "devDependencies",
    4,
    "pnpm-lock.yaml root devDependencies",
  );
  for (const [name, expected] of Object.entries(BOOT_PACKAGES)) {
    const importerBlock = exactYamlBlock(
      rootDevDependencies,
      name,
      6,
      `pnpm-lock.yaml bootstrap importer ${name}`,
    ).join("\n");
    const expectedImporterBlock = `      ${name}:
        specifier: ${expected.version}
        version: ${expected.version}`;
    if (importerBlock !== expectedImporterBlock) {
      fail(`pnpm-lock.yaml bootstrap importer ${name} drifted.`);
    }
  }

  const packages = topLevelSection(lines, "packages");
  for (const [name, expected] of Object.entries(BOOT_PACKAGES)) {
    const packageBlock = exactYamlBlock(
      packages,
      `${name}@${expected.version}`,
      2,
      `pnpm-lock.yaml bootstrap package ${name}`,
    ).join("\n");
    if (
      packageBlock !== expected.packageBlock &&
      packageBlock !== expected.expandedPackageBlock
    ) {
      fail(
        `pnpm-lock.yaml bootstrap identity or sha512 integrity drifted for ${name}@${expected.version}.`,
      );
    }
  }
}

function assertInside(parent, candidate, label) {
  const relative = path.relative(parent, candidate);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".."
  ) {
    fail(`${label} resolves outside repository node_modules.`);
  }
}

function validateInstalledBootPackage(name, expectedVersion) {
  const nodeModules = path.join(ROOT, "node_modules");
  let packageRoot;
  let packageManifestPath;
  let resolvedEntry;
  try {
    packageManifestPath = realpathSync(
      path.join(nodeModules, name, "package.json"),
    );
    packageRoot = path.dirname(packageManifestPath);
    resolvedEntry = realpathSync(fileURLToPath(import.meta.resolve(name)));
  } catch {
    fail(
      `Audit bootstrap package ${name}@${expectedVersion} is not installed.`,
    );
  }
  assertInside(realpathSync(nodeModules), packageRoot, `${name} package root`);
  assertInside(packageRoot, resolvedEntry, `${name} module entry`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
  } catch {
    fail(`Installed audit bootstrap package ${name} has invalid package.json.`);
  }
  if (manifest.name !== name || manifest.version !== expectedVersion) {
    fail(`Installed audit bootstrap package ${name} identity drifted.`);
  }
  const files = [];
  const walk = (directory, relativeParent = "") => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativeParent
        ? `${relativeParent}/${entry.name}`
        : entry.name;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        fail(
          `Installed audit bootstrap package ${name} contains symlink ${relative}.`,
        );
      }
      if (stat.isDirectory()) {
        walk(absolute, relative);
      } else if (stat.isFile()) {
        files.push([relative, readFileSync(absolute)]);
      } else {
        fail(
          `Installed audit bootstrap package ${name} contains special file ${relative}.`,
        );
      }
    }
  };
  walk(packageRoot);
  const hash = createHash("sha512");
  for (const [relative, contents] of files) {
    const relativeBuffer = Buffer.from(relative, "utf8");
    for (const part of [
      Buffer.from(String(relativeBuffer.length)),
      Buffer.from(":"),
      relativeBuffer,
      Buffer.from(":"),
      Buffer.from(String(contents.length)),
      Buffer.from(":"),
      contents,
    ]) {
      hash.update(part);
    }
  }
  const expected = BOOT_PACKAGES[name];
  if (
    files.length !== expected.files ||
    hash.digest("hex") !== expected.treeSha512
  ) {
    fail(
      `Installed audit bootstrap package ${name} tree does not match pinned sha512.`,
    );
  }
}

export function validateAuditBootstrap({ requireInstalled = false } = {}) {
  if (process.versions.node !== EXPECTED_NODE_VERSION) {
    fail(
      `Node version must be exactly ${EXPECTED_NODE_VERSION} during audit bootstrap; found ${process.versions.node}.`,
    );
  }
  if (realpathSync(process.cwd()) !== ROOT) {
    fail(
      `Dependency audit bootstrap must run from exact repository root ${ROOT}.`,
    );
  }
  if (process.env.INIT_CWD !== undefined) {
    let initCwd;
    try {
      initCwd = realpathSync(process.env.INIT_CWD);
    } catch {
      fail("INIT_CWD cannot be resolved during dependency audit bootstrap.");
    }
    if (initCwd !== ROOT) {
      fail(
        "INIT_CWD selects alternate workspace during dependency audit bootstrap.",
      );
    }
  }
  for (const key of Object.keys(process.env)) {
    const upper = key.toUpperCase();
    const value = process.env[key];
    const allowedPackageManagerRuntime =
      (upper === "NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS" &&
        value === "false") ||
      (upper === "PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN" && value === "false") ||
      upper === "NPM_CONFIG_NODE_GYP" ||
      (upper === "NPM_CONFIG_USER_AGENT" &&
        /^pnpm\/11\.8\.0 npm\/\? node\/v24\.15\.0 [a-z0-9_-]+ [a-z0-9_-]+$/u.test(
          value ?? "",
        ));
    if (
      upper === "NODE_OPTIONS" ||
      upper === "NODE_PATH" ||
      (upper.startsWith("COREPACK_") && upper !== "COREPACK_ROOT") ||
      ((upper.startsWith("NPM_CONFIG_") || upper.startsWith("PNPM_CONFIG_")) &&
        !allowedPackageManagerRuntime)
    ) {
      fail(`${key} is forbidden during dependency audit bootstrap.`);
    }
  }
  for (const relativePath of [
    ".corepack.env",
    ".npmrc",
    ".pnpmfile.cjs",
    "pnpmfile.cjs",
    "scripts/node_modules",
  ]) {
    try {
      lstatSync(path.join(ROOT, relativePath));
      fail(`${relativePath} is forbidden during dependency audit bootstrap.`);
    } catch (error) {
      if (error instanceof AuditBootstrapError) throw error;
    }
  }
  parseRootManifest(readRegularFile("package.json", 2 * 1024 * 1024));
  validateBootLockfile(readRegularFile("pnpm-lock.yaml", 32 * 1024 * 1024));
  if (requireInstalled) {
    for (const [name, expected] of Object.entries(BOOT_PACKAGES)) {
      validateInstalledBootPackage(name, expected.version);
    }
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    validateAuditBootstrap();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
