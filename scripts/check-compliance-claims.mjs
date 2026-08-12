import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findPublicClaimViolations } from "../packages/shared/src/public-claims.ts";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const SNIFF_BYTES = 8 * 1024;

// Candid control inventory and detector source necessarily spell out denied
// phrases. They are exact non-deploy publication exceptions, never basenames.
const EXACT_NON_SURFACE_PATHS = new Set([
  ".claude",
  "docs/launch-security-compliance.md",
  "scripts/check-compliance-claims.mjs",
  "packages/shared/src/public-claims.ts",
]);

// Hostile tests are exempt only while exact path and complete-content digest
// match. Any edit invalidates exemption and fails into normal scanning.
const TEST_FIXTURE_SHA256 = new Map([
  [
    "apps/gateway/test/discovery-mcp.test.ts",
    "db938c6634a2483564f44a9a83e28266d222c24caa9d4ae11cc6ac504d352dee",
  ],
  [
    "apps/gateway/test/mock.test.ts",
    "8205b8bd2ddcc65811fa46bc5f3ea0e62faf46ecb669e0055b1535203075121b",
  ],
  [
    "apps/gateway/test/pipeline.test.ts",
    "17ec63ff744c7586c7cd3f732faafe15c11f6739cec91399762ee22d0d2204f6",
  ],
  [
    "apps/gateway/test/spec-source.test.ts",
    "25540dc6ce28311737f7dc8f40baf248cfd94543600658faa1c17c4ff33c4586",
  ],
  [
    "convex/publicClaims.test.ts",
    "6b18b40e71448b7482deb683eb9c2c4e8a034b1002044005d40d749942af58f9",
  ],
  [
    "convex/dev.test.ts",
    "187effd0df5295d2f224fdd869086fabab9363906e3ad406cf74d53b27c3f70a",
  ],
  [
    "convex/search.test.ts",
    "70bc7e198c646662f443ea13cf8cd1d1ef2aca3d061a42e0baf4ad6478437ac8",
  ],
  [
    "packages/shared/src/public-claims.test.ts",
    "a48976965d0e06b5fe4af32fd29822a131f9ddbdcc17cf168654bf55f963955e",
  ],
  [
    "scripts/check-compliance-claims.test.mjs",
    "ea8aa393705674fcdb50e68af9f02c48256da08455edbb40f0296d6fb016b085",
  ],
]);

const TRAVERSAL_SKIP_DIRECTORIES = new Set([".git", ".turbo", "node_modules"]);

const WEB_MANIFEST = "apps/web/dist/server/wrangler.json";
const GATEWAY_OUTPUT_DIR = "apps/gateway/.compliance-dist";
const GATEWAY_METAFILE = `${GATEWAY_OUTPUT_DIR}/bundle-meta.json`;
const GATEWAY_WORKER = `${GATEWAY_OUTPUT_DIR}/index.js`;

function normalizeRelativePath(root, file) {
  return relative(root, file).replaceAll("\\", "/");
}

function isInside(root, target) {
  const rel = relative(root, target).replaceAll("\\", "/");
  return rel === "" || (rel !== ".." && !rel.startsWith("../"));
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function isFingerprintExcluded(relativePath, contents) {
  const expected = TEST_FIXTURE_SHA256.get(relativePath);
  return expected !== undefined && sha256(contents) === expected;
}

function filesUnder(root, path) {
  const absolute = resolve(root, path);
  if (!isInside(root, absolute)) {
    throw new Error(`Compliance claim target escapes repository: ${path}`);
  }
  if (!existsSync(absolute)) {
    throw new Error(`Compliance claim target does not exist: ${path}`);
  }
  const info = lstatSync(absolute);
  if (!info.isDirectory()) return [absolute];

  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && TRAVERSAL_SKIP_DIRECTORIES.has(entry.name)) {
      return [];
    }
    return filesUnder(root, join(path, entry.name));
  });
}

function parseJsonFile(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${label} is missing or invalid: ${file}`);
  }
}

function requireInside(root, candidate, label) {
  const absolute = resolve(candidate);
  if (!isInside(root, absolute)) {
    throw new Error(`${label} escapes repository: ${candidate}`);
  }
  return absolute;
}

function listWebDeployFiles(root, required) {
  const manifest = resolve(root, WEB_MANIFEST);
  if (!existsSync(manifest)) {
    if (required)
      throw new Error(`Generated web manifest missing: ${WEB_MANIFEST}`);
    return [];
  }

  const config = parseJsonFile(manifest, "Generated web manifest");
  if (config === null || typeof config !== "object") {
    throw new Error(
      `Generated web manifest has invalid shape: ${WEB_MANIFEST}`,
    );
  }
  const manifestDir = dirname(manifest);
  const devVars = resolve(manifestDir, ".dev.vars");
  if (existsSync(devVars)) {
    throw new Error(
      `Generated web output contains forbidden secret carrier: ${normalizeRelativePath(root, devVars)}`,
    );
  }
  if (typeof config.main !== "string" || config.main.length === 0) {
    throw new Error(`Generated web manifest lacks main: ${WEB_MANIFEST}`);
  }
  const main = requireInside(
    root,
    resolve(manifestDir, config.main),
    "Web main",
  );
  if (!existsSync(main))
    throw new Error(`Generated web main missing: ${config.main}`);

  const assetsDirectory =
    config.assets !== null &&
    typeof config.assets === "object" &&
    typeof config.assets.directory === "string"
      ? config.assets.directory
      : null;
  if (assetsDirectory === null) {
    throw new Error(
      `Generated web manifest lacks assets.directory: ${WEB_MANIFEST}`,
    );
  }
  const assets = requireInside(
    root,
    resolve(manifestDir, assetsDirectory),
    "Web assets directory",
  );
  if (!existsSync(assets)) {
    throw new Error(`Generated web assets missing: ${assetsDirectory}`);
  }

  return [
    manifest,
    main,
    ...filesUnder(root, normalizeRelativePath(root, manifestDir)),
    ...filesUnder(root, normalizeRelativePath(root, assets)),
  ];
}

function listGatewayDeployFiles(root, required) {
  const outputDir = resolve(root, GATEWAY_OUTPUT_DIR);
  const metafile = resolve(root, GATEWAY_METAFILE);
  const worker = resolve(root, GATEWAY_WORKER);
  if (!existsSync(outputDir) || !existsSync(metafile) || !existsSync(worker)) {
    if (required) {
      throw new Error(
        `Generated gateway output missing: ${GATEWAY_WORKER} and ${GATEWAY_METAFILE} required`,
      );
    }
    return [];
  }

  const meta = parseJsonFile(metafile, "Gateway esbuild metafile");
  if (
    meta === null ||
    typeof meta !== "object" ||
    meta.outputs === null ||
    typeof meta.outputs !== "object"
  ) {
    throw new Error(
      `Gateway esbuild metafile has invalid outputs: ${GATEWAY_METAFILE}`,
    );
  }
  const outputNames = Object.keys(meta.outputs);
  if (outputNames.length === 0) {
    throw new Error(
      `Gateway esbuild metafile has no outputs: ${GATEWAY_METAFILE}`,
    );
  }
  const resolvedOutputs = new Set();
  for (const outputName of outputNames) {
    // Wrangler runs in apps/gateway, so metafile keys are package-relative.
    // Accept repository-relative keys too for fixture/tool-version stability,
    // but only when resolved file lands in exact generated output directory.
    const absolute = [
      resolve(root, outputName),
      resolve(root, "apps/gateway", outputName),
    ].find(
      (candidate) =>
        isInside(root, candidate) &&
        isInside(outputDir, candidate) &&
        existsSync(candidate),
    );
    if (absolute === undefined) {
      throw new Error(
        `Gateway metafile output is outside allowlist: ${outputName}`,
      );
    }
    resolvedOutputs.add(absolute);
  }
  if (!resolvedOutputs.has(worker)) {
    throw new Error(
      `Gateway upload file is absent from metafile outputs: ${GATEWAY_WORKER}`,
    );
  }

  return filesUnder(root, GATEWAY_OUTPUT_DIR);
}

export function listGeneratedClaimFiles(
  root = process.cwd(),
  requireGenerated = "none",
) {
  const webRequired = requireGenerated === "web" || requireGenerated === "all";
  const gatewayRequired =
    requireGenerated === "gateway" || requireGenerated === "all";
  return [
    ...listWebDeployFiles(root, webRequired),
    ...listGatewayDeployFiles(root, gatewayRequired),
  ];
}

export function listDefaultClaimFiles(root = process.cwd()) {
  let tracked;
  try {
    tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to enumerate tracked claim surfaces: ${detail}`);
  }

  return tracked
    .split("\0")
    .filter((path) => path.length > 0)
    .filter((path) => !EXACT_NON_SURFACE_PATHS.has(path))
    .map((path) => {
      const absolute = resolve(root, path);
      if (!existsSync(absolute)) {
        throw new Error(`Tracked compliance claim surface is missing: ${path}`);
      }
      return absolute;
    });
}

function lineAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function hasMagic(bytes, signature, offset = 0) {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function isRecognizedBinary(bytes) {
  return (
    hasMagic(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    hasMagic(bytes, [0xff, 0xd8, 0xff]) ||
    hasMagic(bytes, [0x00, 0x00, 0x01, 0x00]) ||
    hasMagic(bytes, [0x47, 0x49, 0x46, 0x38]) ||
    (hasMagic(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      hasMagic(bytes, [0x57, 0x45, 0x42, 0x50], 8)) ||
    hasMagic(bytes, [0x77, 0x4f, 0x46, 0x46]) ||
    hasMagic(bytes, [0x77, 0x4f, 0x46, 0x32]) ||
    hasMagic(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    hasMagic(bytes, [0x1f, 0x8b]) ||
    hasMagic(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]) ||
    hasMagic(bytes, [0x66, 0x74, 0x79, 0x70], 4)
  );
}

function hasUnknownBinaryBytes(sniff) {
  if (sniff.includes(0)) return true;
  let controls = 0;
  for (const byte of sniff) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      controls += 1;
    }
  }
  if (controls > Math.max(2, Math.floor(sniff.length * 0.01))) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sniff, { stream: true });
    return false;
  } catch {
    return true;
  }
}

function unsafeFailure(file, reason) {
  return {
    file,
    line: 1,
    label: "unsafe compliance scan input",
    match: reason,
  };
}

function readBoundedFile(root, file) {
  const relativePath = normalizeRelativePath(root, file);
  let actual = file;
  let info = lstatSync(file);
  if (info.isSymbolicLink()) {
    try {
      actual = realpathSync(file);
    } catch {
      return { failure: unsafeFailure(relativePath, "broken symlink") };
    }
    if (!isInside(root, actual)) {
      return {
        failure: unsafeFailure(
          relativePath,
          "symlink target escapes repository",
        ),
      };
    }
    info = statSync(actual);
  }
  if (!info.isFile()) {
    return {
      failure: unsafeFailure(relativePath, "input is not a regular file"),
    };
  }
  if (info.size > MAX_FILE_BYTES) {
    return {
      failure: unsafeFailure(
        relativePath,
        `file exceeds ${MAX_FILE_BYTES} byte scan bound`,
      ),
    };
  }
  return { contents: readFileSync(actual), relativePath };
}

export function scanComplianceClaims({
  root = process.cwd(),
  targets,
  requireGenerated = "none",
} = {}) {
  const failures = [];
  const candidates =
    targets === undefined
      ? [
          ...listDefaultClaimFiles(root),
          ...listGeneratedClaimFiles(root, requireGenerated),
        ]
      : targets.flatMap((target) => filesUnder(root, target));
  const files = [...new Set(candidates.map((file) => resolve(file)))];

  for (const file of files) {
    const relativePath = normalizeRelativePath(root, file);
    if (EXACT_NON_SURFACE_PATHS.has(relativePath)) continue;
    const read = readBoundedFile(root, file);
    if (read.failure) {
      failures.push(read.failure);
      continue;
    }
    const contents = read.contents;
    if (isFingerprintExcluded(relativePath, contents)) continue;

    const sniff = contents.subarray(0, SNIFF_BYTES);
    const recognizedBinary = isRecognizedBinary(sniff);
    const unknownBinary = !recognizedBinary && hasUnknownBinaryBytes(contents);
    // Decode bounded bytes even for recognized binaries: textual metadata and
    // fake extensions do not get an escape hatch. NUL/control bytes become
    // separators so split claim tokens remain detectable.
    const source = contents
      .toString("utf8")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, " ");
    for (const violation of findPublicClaimViolations(source)) {
      failures.push({
        file: relativePath,
        line: lineAt(source, violation.index),
        label: violation.label,
        match: violation.match.replace(/\s+/g, " ").trim(),
      });
    }
    if (unknownBinary) {
      failures.push(
        unsafeFailure(relativePath, "unrecognized binary or NUL content"),
      );
    }
  }
  return failures;
}

export function formatFailures(failures) {
  return failures.map(
    ({ file, line, label, match }) =>
      `${file}:${line}: ${label}: ${JSON.stringify(match)}`,
  );
}

function requiredGeneratedMode(argv) {
  const exact = argv.find((arg) => arg.startsWith("--require-generated"));
  if (exact === undefined) return "none";
  if (exact === "--require-generated") return "all";
  const value = exact.slice("--require-generated=".length);
  if (value === "web" || value === "gateway" || value === "all") return value;
  throw new Error(`Invalid generated mode: ${value}`);
}

export function runComplianceClaimCheck(argv = process.argv.slice(2)) {
  const failures = scanComplianceClaims({
    requireGenerated: requiredGeneratedMode(argv),
  });
  if (failures.length > 0) {
    console.error("Unsupported public compliance/security claims found:\n");
    console.error(formatFailures(failures).join("\n"));
    console.error(
      "\nUse narrow evidence/control language or remove publisher copy from public output.",
    );
    process.exitCode = 1;
    return;
  }
  console.log("Compliance claim check passed.");
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  runComplianceClaimCheck();
}
