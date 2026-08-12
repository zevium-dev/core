import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_TARGETS,
  formatFailures,
  scanComplianceClaims,
} from "./check-compliance-claims.mjs";

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "zevium-compliance-claims-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

test("default scope includes source docs, web source, and public assets", () => {
  for (const target of [
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
  ]) {
    assert.ok(
      DEFAULT_TARGETS.includes(target),
      `missing scan target: ${target}`,
    );
  }
});

test("allows narrow control language without assurance claims", (t) => {
  const root = fixture(t, {
    "public/page.md":
      "Gateway strips consumer authorization before forwarding. Security reports are private.",
  });
  assert.deepEqual(scanComplianceClaims({ root, targets: ["public"] }), []);
});

test("rejects common certification, readiness, and absolute claim variants", (t) => {
  const root = fixture(t, {
    "public/page.mdx": [
      "SOC2 Type 2",
      "HIPAA-eligible",
      "GDPR aligned",
      "CPRA compliance",
      "meets all CCPA requirements",
      "PCI-DSS",
      "ISO-27001 certified",
      "enterprise-grade security",
      "100% secure",
      "zero risk",
      "breach-proof",
      "we never store your data",
      "we don't collect personal information",
      "all data is encrypted at rest",
    ].join("\n"),
  });
  const failures = scanComplianceClaims({ root, targets: ["public"] });
  assert.equal(failures.length, 14);
  assert.deepEqual(
    failures.map(({ line }) => line).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  );
});

test("detects claims split across lines and reports the starting line", (t) => {
  const root = fixture(t, {
    "public/page.tsx": 'const badge = "SOC\n2 Type II";',
  });
  const failures = scanComplianceClaims({ root, targets: ["public"] });
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.line, 1);
  assert.match(formatFailures(failures)[0] ?? "", /SOC 2 Type II/);
});

test("scans text-bearing public assets and skips binary files", (t) => {
  const root = fixture(t, {
    "public/badge.svg": "<text>bank-grade security</text>",
    "public/claim.html": "<p>HIPAA ready</p>",
    "public/image.png": "SOC 2 Type II",
  });
  const failures = scanComplianceClaims({ root, targets: ["public"] });
  assert.deepEqual(failures.map(({ file }) => file).sort(), [
    "public/badge.svg",
    "public/claim.html",
  ]);
});

test("excludes the candid internal posture from public-claim enforcement", (t) => {
  const root = fixture(t, {
    "docs/launch-security-compliance.md":
      "Not certified. Prohibited wording: SOC 2 and HIPAA compliant.",
    "docs/marketing.md": "SOC 2 ready",
  });
  const failures = scanComplianceClaims({ root, targets: ["docs"] });
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.file, "docs/marketing.md");
});

test("fails closed when a configured target disappears", (t) => {
  const root = fixture(t, { "public/page.md": "ordinary copy" });
  assert.throws(
    () => scanComplianceClaims({ root, targets: ["missing"] }),
    /target does not exist: missing/,
  );
});

test("skips generated and dependency directories inside broad source roots", (t) => {
  const root = fixture(t, {
    "convex/queries.ts": "export const message = 'narrow control wording';",
    "convex/_generated/api.ts": "export const badge = 'SOC 2 Type II';",
    "convex/node_modules/vendor/index.js": "export default 'HIPAA ready';",
  });
  assert.deepEqual(scanComplianceClaims({ root, targets: ["convex"] }), []);
});
