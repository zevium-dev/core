import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOT = process.cwd();
const TARGETS = [
  "README.md",
  "PRODUCT.md",
  "FLOW.md",
  "SECURITY.md",
  "apps/web/src",
];
const EXTENSIONS = new Set([".md", ".ts", ".tsx", ".js", ".jsx"]);

const PROHIBITED = [
  { label: "SOC 2 claim", pattern: /\bSOC\s*2(?:\s+Type\s+(?:I|II|1|2))?\b/i },
  {
    label: "HIPAA claim",
    pattern: /\bHIPAA(?:[- ](?:compliant|certified|ready))?\b/i,
  },
  {
    label: "privacy-law compliance claim",
    pattern: /\b(?:GDPR|CCPA|CPRA)\s+(?:compliant|certified|ready)\b/i,
  },
  {
    label: "PCI claim",
    pattern: /\bPCI(?:[- ]DSS)?\s+(?:compliant|certified|ready)\b/i,
  },
  {
    label: "ISO 27001 claim",
    pattern: /\bISO\s*27001(?:\s+(?:compliant|certified|ready))?\b/i,
  },
  {
    label: "security-grade superlative",
    pattern: /\b(?:enterprise|bank|military)[- ]grade\s+secur(?:e|ity)\b/i,
  },
  {
    label: "absolute security claim",
    pattern: /\b(?:fully|100%|completely)\s+secure\b/i,
  },
];

function filesUnder(path) {
  const absolute = join(ROOT, path);
  if (!statSync(absolute).isDirectory()) return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [join(ROOT, child)];
  });
}

const failures = [];
for (const file of TARGETS.flatMap(filesUnder)) {
  if (!EXTENSIONS.has(extname(file))) continue;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const rule of PROHIBITED) {
      if (rule.pattern.test(line)) {
        failures.push(
          `${relative(ROOT, file)}:${index + 1}: ${rule.label}: ${line.trim()}`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Unsupported public compliance/security claims found:\n");
  console.error(failures.join("\n"));
  console.error(
    "\nUse narrow, evidenced control language. Update docs/launch-security-compliance.md before adding public claims.",
  );
  process.exitCode = 1;
} else {
  console.log("Compliance claim check passed.");
}
