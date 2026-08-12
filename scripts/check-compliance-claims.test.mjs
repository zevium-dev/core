import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatFailures,
  listDefaultClaimFiles,
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

test("default scope enumerates every tracked text/code/config extension", (t) => {
  const root = fixture(t, {
    "README.md": "ordinary copy",
    "config/policy.yaml": "name: ordinary",
    "config/feed.xml": "<name>ordinary</name>",
    "site/page.astro": "<p>ordinary</p>",
    "site/image.png": Buffer.from([0, 1, 2, 3]),
    "untracked.md": "SOC2",
  });
  symlinkSync("README.md", join(root, "tracked-link"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync(
    "git",
    [
      "add",
      "README.md",
      "config/policy.yaml",
      "config/feed.xml",
      "site/page.astro",
      "site/image.png",
      "tracked-link",
    ],
    { cwd: root },
  );

  const relative = listDefaultClaimFiles(root)
    .map((path) => path.slice(root.length + 1))
    .sort();
  assert.deepEqual(relative, [
    "README.md",
    "config/feed.xml",
    "config/policy.yaml",
    "site/image.png",
    "site/page.astro",
    "tracked-link",
  ]);
  assert.deepEqual(scanComplianceClaims({ root }), []);
});

test("allows narrow control and explicit negative language", (t) => {
  const root = fixture(t, {
    "public/page.md": [
      "Gateway strips consumer authorization before forwarding.",
      "We do not have a SOC 2 report.",
      "HIPAA use is prohibited.",
      "Publisher credential values use AES-GCM encryption.",
    ].join("\n"),
  });
  assert.deepEqual(scanComplianceClaims({ root, targets: ["public"] }), []);
});

test("rejects every reported adversarial bypass", (t) => {
  const claims = [
    "SOC.2 certified",
    "S.O.C. 2",
    "SOC_2",
    "SOC‑2",
    "SOC​2",
    "HIPAA\nready",
    "H.I.P.A.A. ready",
    "GDPR\ncompliant",
    "GDPR: compliant",
    "complies with GDPR",
    "ISO/IEC 27001 certified",
    "P.C.I. DSS",
    "enterprise-grade platform",
    "bank grade encryption",
    "fully-secure",
    "zero-risk",
    "secure against every breach",
    "zero data retention",
    "we store none of your data",
    "all information is encrypted at rest",
    "data is always encrypted",
    "end-to-end encryption",
  ];
  const root = fixture(t, { "public/page.mdx": claims.join("\n---\n") });
  const failures = scanComplianceClaims({ root, targets: ["public"] });
  assert.equal(failures.length, claims.length);
});

test("detects compatibility forms, homoglyphs, multiline claims, and line", (t) => {
  const root = fixture(t, {
    "public/page.tsx": [
      'const first = "ＳＯＣ２ certified";',
      'const second = "ЅΟС\u200b2 Type II";',
      'const third = "HIPAA\nready";',
    ].join("\n"),
  });
  const failures = scanComplianceClaims({ root, targets: ["public"] });
  assert.equal(failures.length, 3);
  assert.deepEqual(
    failures.map(({ line }) => line),
    [1, 2, 3],
  );
  assert.match(formatFailures(failures)[0] ?? "", /soc2/i);
});

test("scans unknown text assets and skips known or NUL binary files", (t) => {
  const root = fixture(t, {
    "public/claim.astro": "<p>HIPAA ready</p>",
    "public/claim.xml": "<badge>bank-grade encryption</badge>",
    "public/image.png": "SOC 2 Type II",
    "public/blob.custom": Buffer.from([83, 79, 67, 0, 50]),
  });
  const failures = scanComplianceClaims({ root, targets: ["public"] });
  assert.deepEqual(failures.map(({ file }) => file).sort(), [
    "public/claim.astro",
    "public/claim.xml",
  ]);
});

test("excludes candid posture and scanner fixtures only", (t) => {
  const root = fixture(t, {
    "docs/launch-security-compliance.md": "SOC 2 and HIPAA compliant",
    "scripts/check-compliance-claims.test.mjs": "SOC 2 ready",
    "docs/marketing.md": "SOC 2 ready",
  });
  const failures = scanComplianceClaims({
    root,
    targets: ["docs", "scripts"],
  });
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

test("skips generated and dependency directories inside explicit roots", (t) => {
  const root = fixture(t, {
    "convex/queries.ts": "export const message = 'narrow control wording';",
    "convex/_generated/api.ts": "export const badge = 'SOC 2 Type II';",
    "convex/node_modules/vendor/index.js": "export default 'HIPAA ready';",
  });
  assert.deepEqual(scanComplianceClaims({ root, targets: ["convex"] }), []);
});
