import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findPublicClaimViolations } from "../packages/shared/src/public-claims.ts";

// Candid control inventory and scanner fixtures necessarily name prohibited
// phrases. They are not publication surfaces. Every other tracked text/code/
// config file is discovered from Git, so new roots and extensions fail into
// scope automatically.
const EXCLUDED_PATHS = new Set([
  "docs/launch-security-compliance.md",
  "scripts/check-compliance-claims.mjs",
  "scripts/check-compliance-claims.test.mjs",
  "packages/shared/src/public-claims.ts",
  "packages/shared/src/public-claims.test.ts",
]);

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  "_generated",
  "coverage",
  "dist",
  "node_modules",
]);

const BINARY_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".tar",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

const TEXT_EXTENSIONS = new Set([
  ".astro",
  ".cjs",
  ".css",
  ".env",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

function normalizeRelativePath(root, file) {
  return relative(root, file).replaceAll("\\", "/");
}

function isExcluded(relativePath) {
  if (EXCLUDED_PATHS.has(relativePath)) return true;
  if (/(?:^|\/)[^/]+\.test\.[^/]+$/u.test(relativePath)) return true;
  return relativePath
    .split("/")
    .some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}

function filesUnder(root, path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) {
    throw new Error(`Compliance claim target does not exist: ${path}`);
  }
  if (!statSync(absolute).isDirectory()) return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) return [];
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(root, child) : [join(root, child)];
  });
}

function isTextFile(file, contents) {
  const extension = extname(file).toLowerCase();
  if (BINARY_EXTENSIONS.has(extension)) return false;
  if (TEXT_EXTENSIONS.has(extension)) return true;
  // NUL is a reliable binary signal for remaining unknown extensions. Unknown
  // NUL-free files are scanned, which includes YAML, XML, Astro, env and
  // extensionless config/docs without maintaining a bypass-prone allowlist.
  return !contents.includes(0);
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
    .filter((path) => !isExcluded(path))
    .map((path) => {
      const absolute = join(root, path);
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

export function scanComplianceClaims({ root = process.cwd(), targets } = {}) {
  const failures = [];
  const files =
    targets === undefined
      ? listDefaultClaimFiles(root)
      : targets.flatMap((target) => filesUnder(root, target));

  for (const file of files) {
    const relativePath = normalizeRelativePath(root, file);
    if (isExcluded(relativePath)) continue;
    // Scan tracked symlink text itself; never follow a link outside the tree or
    // into a directory while enumerating repository claim surfaces.
    const contents = lstatSync(file).isSymbolicLink()
      ? Buffer.from(readlinkSync(file), "utf8")
      : readFileSync(file);
    if (!isTextFile(file, contents)) continue;

    const source = contents.toString("utf8");
    for (const violation of findPublicClaimViolations(source)) {
      failures.push({
        file: relativePath,
        line: lineAt(source, violation.index),
        label: violation.label,
        match: violation.match.replace(/\s+/g, " ").trim(),
      });
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

export function runComplianceClaimCheck() {
  const failures = scanComplianceClaims();
  if (failures.length > 0) {
    console.error("Unsupported public compliance/security claims found:\n");
    console.error(formatFailures(failures).join("\n"));
    console.error(
      "\nUse narrow, evidenced control language. Update docs/launch-security-compliance.md before adding public claims.",
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
