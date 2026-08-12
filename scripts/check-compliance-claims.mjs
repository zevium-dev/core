import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_TARGETS = [
  "README.md",
  "SECURITY.md",
  "PRODUCT.md",
  "FLOW.md",
  "DESIGN.md",
  "TECH.md",
  "docs",
  "apps/web/src",
  "apps/web/public",
  "apps/gateway/src",
  "convex",
  "packages/shared/src",
];

const EXCLUDED_PATHS = new Set(["docs/launch-security-compliance.md"]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  "_generated",
  "coverage",
  "dist",
  "node_modules",
]);
const EXTENSIONS = new Set([
  ".cjs",
  ".css",
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
]);

const PROHIBITED = [
  {
    label: "SOC 2 claim",
    pattern: /\bSOC\s*-?\s*2(?:\s+Type\s+(?:I{1,2}|[12]))?\b/giu,
  },
  {
    label: "HIPAA claim",
    pattern:
      /\bHIPAA(?:\s*[- ]\s*(?:compliant|certified|eligible|ready))?\b/giu,
  },
  {
    label: "privacy-law compliance claim",
    pattern:
      /\b(?:GDPR|CCPA|CPRA)\s*[- ]\s*(?:aligned|approved|certified|compliance|compliant|ready)|\b(?:meets?|satisf(?:y|ies))\s+(?:all\s+)?(?:GDPR|CCPA|CPRA)\s+(?:requirements?|standards?)/giu,
  },
  {
    label: "PCI claim",
    pattern:
      /\bPCI(?:\s*-?\s*DSS)?\s*[- ]\s*(?:compliant|certified|ready)|\bPCI\s*-?\s*DSS\b/giu,
  },
  {
    label: "ISO 27001 claim",
    pattern:
      /\bISO\s*-?\s*27001(?:\s*[- ]\s*(?:aligned|compliant|certified|ready))?\b/giu,
  },
  {
    label: "security-grade superlative",
    pattern:
      /\b(?:enterprise|bank|military)\s*[- ]\s*grade\s+secur(?:e|ity)\b/giu,
  },
  {
    label: "absolute security claim",
    pattern: /\b(?:fully|100\s*%|completely)\s+secure\b/giu,
  },
  {
    label: "absolute risk claim",
    pattern:
      /\b(?:zero\s+risk|breach\s*[- ]\s*proof|hack\s*[- ]\s*proof|unhackable|impossible\s+to\s+breach)\b/giu,
  },
  {
    label: "absolute privacy claim",
    pattern:
      /\b(?:we\s+)?(?:never|do\s+not|don't)\s+(?:collect|retain|share|store)\s+(?:any\s+|your\s+)?(?:data|personal (?:data|information))\b|\bno\s+(?:personal\s+)?data\s+(?:is\s+)?(?:collected|retained|shared|stored)\b/giu,
  },
  {
    label: "broad encryption claim",
    pattern:
      /\bend\s*[- ]\s*to\s*[- ]\s*end encrypted\b|\b(?:all|customer|your)\s+data\s+(?:is|are)\s+encrypted\s+at\s+rest\b/giu,
  },
];

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

function lineAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

export function scanComplianceClaims({
  root = process.cwd(),
  targets = DEFAULT_TARGETS,
} = {}) {
  const failures = [];
  for (const file of targets.flatMap((target) => filesUnder(root, target))) {
    const relativePath = relative(root, file).replaceAll("\\", "/");
    if (EXCLUDED_PATHS.has(relativePath)) continue;
    if (!EXTENSIONS.has(extname(file).toLowerCase())) continue;

    const source = readFileSync(file, "utf8");
    for (const rule of PROHIBITED) {
      for (const match of source.matchAll(rule.pattern)) {
        const index = match.index ?? 0;
        failures.push({
          file: relativePath,
          line: lineAt(source, index),
          label: rule.label,
          match: match[0].replace(/\s+/g, " ").trim(),
        });
      }
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
