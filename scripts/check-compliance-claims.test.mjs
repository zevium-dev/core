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
  listGeneratedClaimFiles,
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

function initAndTrack(root, paths) {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", ...paths], { cwd: root });
}

test("default scope includes tracked test, generated, dist, and unknown extensions", (t) => {
  const root = fixture(t, {
    "README.md": "ordinary copy",
    "src/production.test.ts": "ordinary test-named production input",
    "convex/_generated/api.ts": "ordinary generated input",
    "public/dist/feed.odd": "ordinary dist input",
    "site/image.png": Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]),
    "untracked.md": "ordinary untracked input",
  });
  initAndTrack(root, [
    "README.md",
    "src/production.test.ts",
    "convex/_generated/api.ts",
    "public/dist/feed.odd",
    "site/image.png",
  ]);

  const relative = listDefaultClaimFiles(root)
    .map((path) => path.slice(root.length + 1))
    .sort();
  assert.deepEqual(relative, [
    "README.md",
    "convex/_generated/api.ts",
    "public/dist/feed.odd",
    "site/image.png",
    "src/production.test.ts",
  ]);
  assert.deepEqual(scanComplianceClaims({ root }), []);
});

test("allows evidence analysis and direct negative language", (t) => {
  const root = fixture(t, {
    "public/page.md": [
      "Analyzes SOC 2 reports and PCI DSS documentation.",
      "We are not HIPAA compliant.",
      "This service does not comply with GDPR.",
      "No end-to-end encryption.",
      "Publisher credential values use AES-GCM encryption.",
    ].join("\n"),
  });
  assert.deepEqual(scanComplianceClaims({ root, targets: ["public"] }), []);
});

test("rejects normalized adversarial claims", (t) => {
  const claims = [
    "SOC.2 certified",
    "S.O.C. 2 approved",
    "HIPAA\nready",
    "H.I.P.A.A. compliant",
    "G.D.P.R compliant",
    "complies with GDPR",
    "C.C.P.A compliant",
    "I.S.O/IEC 27001 certified",
    "P.C.I. D.S.S approved",
    "ΗΙΡΑΑ compliant",
    "ɢ.ᴅ.ᴘ.ʀ compliant",
    "not not HIPAA compliant",
    "No one doubts we are SOC 2 certified",
    "enterprise-grade platform",
    "fully-secure",
    "zero-risk",
    "zero data retention",
    "end-to-end encryption",
  ];
  const root = fixture(t, { "public/page.mdx": claims.join("\n---\n") });
  const failures = scanComplianceClaims({ root, targets: ["public"] });
  assert.equal(failures.length, claims.length);
  assert.match(formatFailures(failures)[0] ?? "", /soc 2/i);
});

test("does not trust test-like names or file extensions", (t) => {
  const root = fixture(t, {
    "public/release.test.ts": "HIPAA ready",
    "public/fake.png": "SOC 2 certified",
    "public/no-extension": "GDPR compliant",
  });
  const failures = scanComplianceClaims({ root, targets: ["public"] });
  assert.deepEqual([...new Set(failures.map(({ file }) => file))].sort(), [
    "public/fake.png",
    "public/no-extension",
    "public/release.test.ts",
  ]);
});

test("NUL and unknown binary content cannot hide claims", (t) => {
  const root = fixture(t, {
    "public/nul.bin": Buffer.from("SOC\0.2 certified", "utf8"),
    "public/late-nul.bin": Buffer.from(
      `${"x".repeat(9000)}\0HIPAA ready`,
      "utf8",
    ),
    "public/unknown.bin": Buffer.from([1, 2, 3, 4]),
    "public/real.png": Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("HIPAA ready", "utf8"),
    ]),
  });
  const failures = scanComplianceClaims({ root, targets: ["public"] });
  assert.ok(
    failures.some(
      ({ file, label }) => file === "public/nul.bin" && label === "SOC 2 claim",
    ),
  );
  assert.ok(
    failures.some(
      ({ file, label }) =>
        file === "public/late-nul.bin" &&
        label === "unsafe compliance scan input",
    ),
  );
  assert.ok(
    failures.some(
      ({ file, label }) =>
        file === "public/unknown.bin" &&
        label === "unsafe compliance scan input",
    ),
  );
  assert.ok(
    failures.some(
      ({ file, label }) =>
        file === "public/real.png" && label === "HIPAA claim",
    ),
  );
});

test("symlinks are followed only inside repository", (t) => {
  const outside = mkdtempSync(join(tmpdir(), "zevium-compliance-outside-"));
  t.after(() => rmSync(outside, { force: true, recursive: true }));
  writeFileSync(join(outside, "outside.txt"), "HIPAA ready");
  const root = fixture(t, {
    "public/target.txt": "SOC 2 certified",
  });
  symlinkSync("target.txt", join(root, "public/inside-link"));
  symlinkSync(join(outside, "outside.txt"), join(root, "public/outside-link"));

  const failures = scanComplianceClaims({ root, targets: ["public"] });
  assert.ok(failures.some(({ file }) => file === "public/inside-link"));
  assert.ok(
    failures.some(
      ({ file, match }) =>
        file === "public/outside-link" && /escapes repository/.test(match),
    ),
  );
});

test("fixture exemption is not transferable by basename or modified content", (t) => {
  const root = fixture(t, {
    "scripts/check-compliance-claims.test.mjs": "SOC 2 certified",
    "elsewhere/public-claims.test.ts": "HIPAA ready",
  });
  const failures = scanComplianceClaims({
    root,
    targets: ["scripts", "elsewhere"],
  });
  assert.equal(failures.length, 2);
});

test("untracked web deploy assets are derived from generated manifest and scanned", (t) => {
  const root = fixture(t, {
    "apps/web/dist/server/wrangler.json": JSON.stringify({
      main: "index.js",
      assets: { directory: "../client" },
    }),
    "apps/web/dist/server/index.js": "export default {};",
    "apps/web/dist/client/release.test.png": "SOC 2 certified",
  });
  execFileSync("git", ["init", "-q"], { cwd: root });
  const generated = listGeneratedClaimFiles(root, "web");
  assert.ok(generated.some((file) => file.endsWith("release.test.png")));
  const failures = scanComplianceClaims({ root, requireGenerated: "web" });
  assert.ok(
    failures.some(({ file }) =>
      file.endsWith("apps/web/dist/client/release.test.png"),
    ),
  );
});

test("untracked web main is scanned even when manifest points outside its directory", (t) => {
  const root = fixture(t, {
    "apps/web/dist/server/wrangler.json": JSON.stringify({
      main: "../outside-main.test.js",
      assets: { directory: "../client" },
    }),
    "apps/web/dist/outside-main.test.js": "HIPAA ready",
    "apps/web/dist/client/asset.js": "ordinary asset",
  });
  execFileSync("git", ["init", "-q"], { cwd: root });

  const failures = scanComplianceClaims({ root, requireGenerated: "web" });
  assert.ok(
    failures.some(({ file }) =>
      file.endsWith("apps/web/dist/outside-main.test.js"),
    ),
  );
});

test("generated web output rejects local secret carrier", (t) => {
  const root = fixture(t, {
    "apps/web/dist/server/wrangler.json": JSON.stringify({
      main: "index.js",
      assets: { directory: "../client" },
    }),
    "apps/web/dist/server/index.js": "export default {};",
    "apps/web/dist/server/.dev.vars": "SECRET=value",
    "apps/web/dist/client/asset.js": "ordinary asset",
  });
  execFileSync("git", ["init", "-q"], { cwd: root });

  assert.throws(
    () => scanComplianceClaims({ root, requireGenerated: "web" }),
    /forbidden secret carrier/,
  );
});

test("gateway deploy allowlist comes from dry-run metafile", (t) => {
  const output = "apps/gateway/.compliance-dist/index.js";
  const root = fixture(t, {
    [output]: "export default 'GDPR compliant';",
    "apps/gateway/.compliance-dist/bundle-meta.json": JSON.stringify({
      outputs: { ".compliance-dist/index.js": {} },
    }),
  });
  execFileSync("git", ["init", "-q"], { cwd: root });
  const failures = scanComplianceClaims({ root, requireGenerated: "gateway" });
  assert.ok(failures.some(({ file }) => file === output));
});

test("gateway upload file must be an output in the dry-run metafile", (t) => {
  const root = fixture(t, {
    "apps/gateway/.compliance-dist/index.js": "ordinary stale worker",
    "apps/gateway/.compliance-dist/other.js": "ordinary output",
    "apps/gateway/.compliance-dist/bundle-meta.json": JSON.stringify({
      outputs: { ".compliance-dist/other.js": {} },
    }),
  });
  execFileSync("git", ["init", "-q"], { cwd: root });

  assert.throws(
    () => scanComplianceClaims({ root, requireGenerated: "gateway" }),
    /upload file is absent from metafile outputs/,
  );
});

test("required generated inputs and explicit targets fail closed", (t) => {
  const root = fixture(t, { "public/page.md": "ordinary copy" });
  execFileSync("git", ["init", "-q"], { cwd: root });
  assert.throws(
    () => scanComplianceClaims({ root, targets: ["missing"] }),
    /target does not exist: missing/,
  );
  assert.throws(
    () => scanComplianceClaims({ root, requireGenerated: "all" }),
    /Generated web manifest missing/,
  );
});

test("generated source directories receive no global bypass", (t) => {
  const root = fixture(t, {
    "convex/queries.ts": "export const message = 'ordinary';",
    "convex/_generated/api.test.ts": "export const badge = 'SOC 2 certified';",
  });
  const failures = scanComplianceClaims({ root, targets: ["convex"] });
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.file, "convex/_generated/api.test.ts");
});
