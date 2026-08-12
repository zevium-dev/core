import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  brotliCompressSync,
  deflateRawSync,
  deflateSync,
  gzipSync,
} from "node:zlib";
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
  assert.deepEqual(scanComplianceClaims({ root }), [
    {
      file: "site/image.png",
      line: 1,
      label: "unsafe compliance scan input",
      match: "PNG image has no bounded exact text decoder",
    },
  ]);
});

test("allows evidence analysis and direct negative language", (t) => {
  const root = fixture(t, {
    "public/page.md": [
      "Analyzes SOC 2 reports and PCI DSS documentation.",
      "We are not HIPAA compliant.",
      "We aren’t HIPAA compliant.",
      "We cannot claim HIPAA compliant.",
      "We can't claim HIPAA compliant.",
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
    "HıPAA ready",
    "ԌDPR compliant",
    "We guarantee GDPR compliance",
    "HIPAA indisputably compliant",
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
  // An all-Unicode fixed-length skeleton can conservatively match more than
  // one protected acronym. Every corpus entry must produce at least one hit.
  assert.ok(failures.length >= claims.length);
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

test("NUL, unknown, and recognized binary content cannot hide claims", (t) => {
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
      ({ file, label, match }) =>
        file === "public/real.png" &&
        label === "unsafe compliance scan input" &&
        /PNG image/.test(match),
    ),
  );
});

test("compressed, archive, and PDF magic always fails closed without a decoder", (t) => {
  const claim = Buffer.from("HIPAA ready", "utf8");
  const compressedPdf = Buffer.concat([
    Buffer.from(
      "%PDF-1.7\n1 0 obj\n<< /Length 999 /Filter /FlateDecode >>\nstream\n",
      "ascii",
    ),
    deflateSync(Buffer.from(`BT (${claim.toString("utf8")}) Tj ET`, "utf8")),
    Buffer.from("\nendstream\nendobj\n%%EOF\n", "ascii"),
  ]);
  const root = fixture(t, {
    "public/claim.pdf": compressedPdf,
    "public/claim.gz": gzipSync(claim),
    "public/claim.zip": Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      deflateRawSync(claim),
    ]),
    "public/claim.xz": Buffer.concat([
      Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
      claim,
    ]),
    "public/claim.7z": Buffer.concat([
      Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
      claim,
    ]),
  });

  const failures = scanComplianceClaims({ root, targets: ["public"] });
  assert.deepEqual(failures.map(({ file, label }) => [file, label]).sort(), [
    ["public/claim.7z", "unsafe compliance scan input"],
    ["public/claim.gz", "unsafe compliance scan input"],
    ["public/claim.pdf", "unsafe compliance scan input"],
    ["public/claim.xz", "unsafe compliance scan input"],
    ["public/claim.zip", "unsafe compliance scan input"],
  ]);
  assert.ok(
    failures.every(({ match }) => /no bounded exact text decoder/.test(match)),
  );
});

test("Brotli streams fail closed despite having no format magic", (t) => {
  const stream = brotliCompressSync(Buffer.from("HIPAA ready", "utf8"));
  const largeStream = brotliCompressSync(randomBytes(16 * 1024));
  assert.ok(largeStream.byteLength > 8 * 1024);
  const root = fixture(t, {
    "public/claim.br": stream,
    "public/renamed.odd": stream,
    "public/renamed-large.odd": largeStream,
  });

  const failures = scanComplianceClaims({ root, targets: ["public"] });
  assert.deepEqual(
    failures.map(({ file, label, match }) => [file, label, match]).sort(),
    [
      [
        "public/claim.br",
        "unsafe compliance scan input",
        "Brotli stream has no bounded exact text decoder",
      ],
      [
        "public/renamed-large.odd",
        "unsafe compliance scan input",
        "Brotli stream has no bounded exact text decoder",
      ],
      [
        "public/renamed.odd",
        "unsafe compliance scan input",
        "Brotli stream has no bounded exact text decoder",
      ],
    ],
  );
});

test("every recognized opaque magic family fails closed", (t) => {
  const at = (offset, bytes) => {
    const result = Buffer.alloc(offset + bytes.length);
    Buffer.from(bytes).copy(result, offset);
    return result;
  };
  const riffWebp = Buffer.alloc(12);
  Buffer.from("RIFF", "ascii").copy(riffWebp);
  Buffer.from("WEBP", "ascii").copy(riffWebp, 8);
  const tar = at(257, Buffer.from("ustar", "ascii"));
  const corpus = {
    "png.bin": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    "jpeg.bin": Buffer.from([0xff, 0xd8, 0xff]),
    "gif.bin": Buffer.from("GIF89a", "ascii"),
    "bmp.bin": Buffer.from("BM", "ascii"),
    "tiff-le.bin": Buffer.from([0x49, 0x49, 0x2a, 0x00]),
    "tiff-be.bin": Buffer.from([0x4d, 0x4d, 0x00, 0x2a]),
    "ico.bin": Buffer.from([0x00, 0x00, 0x01, 0x00]),
    "webp.bin": riffWebp,
    "woff.bin": Buffer.from("wOFF", "ascii"),
    "woff2.bin": Buffer.from("wOF2", "ascii"),
    "ttf.bin": Buffer.from([0x00, 0x01, 0x00, 0x00]),
    "otf.bin": Buffer.from("OTTO", "ascii"),
    "zip.bin": Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    "gzip.bin": Buffer.from([0x1f, 0x8b]),
    "bzip2.bin": Buffer.from("BZh", "ascii"),
    "xz.bin": Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
    "zstd.bin": Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
    "lz4.bin": Buffer.from([0x04, 0x22, 0x4d, 0x18]),
    "zlib.bin": Buffer.from([0x78, 0x9c]),
    "7z.bin": Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
    "rar.bin": Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]),
    "ar.bin": Buffer.from("!<arch>\n", "ascii"),
    "cab.bin": Buffer.from("MSCF", "ascii"),
    "tar.bin": tar,
    "pdf.bin": Buffer.from("%PDF-1.7", "ascii"),
    "iso-media.bin": at(4, Buffer.from("ftyp", "ascii")),
    "elf.bin": Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    "wasm.bin": Buffer.from([0x00, 0x61, 0x73, 0x6d]),
    "compound.bin": Buffer.from([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
    ]),
    "sqlite.bin": Buffer.from("SQLite f", "ascii"),
  };
  const root = fixture(
    t,
    Object.fromEntries(
      Object.entries(corpus).map(([name, contents]) => [
        `public/${name}`,
        contents,
      ]),
    ),
  );

  const failures = scanComplianceClaims({ root, targets: ["public"] });
  assert.equal(failures.length, Object.keys(corpus).length);
  assert.ok(
    failures.every(
      ({ label, match }) =>
        label === "unsafe compliance scan input" &&
        /no bounded exact text decoder/.test(match),
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

test("internal reference exemption requires exact path, bytes, and source provenance", (t) => {
  const reference = readFileSync(
    new URL(
      "../.agents/skills/stripe-best-practices/references/payments.md",
      import.meta.url,
    ),
  );
  const path = ".agents/skills/stripe-best-practices/references/payments.md";
  const root = fixture(t, {
    [path]: reference,
    "copied/payments.md": reference,
  });
  initAndTrack(root, [path, "copied/payments.md"]);

  const failures = scanComplianceClaims({ root });
  assert.ok(failures.length > 0);
  assert.ok(failures.every(({ file }) => file === "copied/payments.md"));
  assert.ok(
    scanComplianceClaims({ root, targets: [path] }).some(
      ({ label }) => label === "PCI claim",
    ),
  );
});

test("POSIX backslashes cannot alias an exempt source path", (t) => {
  if (process.platform === "win32") return;
  const path = "docs\\launch-security-compliance.md";
  const root = fixture(t, { [path]: "SOC 2 certified" });
  initAndTrack(root, [path]);

  const failures = scanComplianceClaims({ root });
  assert.ok(
    failures.some(
      ({ file, label }) => file === path && label === "SOC 2 claim",
    ),
  );
});

test("generated provenance disables exact source path and digest exemptions", (t) => {
  const root = fixture(t, {
    "apps/web/dist/server/wrangler.json": JSON.stringify({
      main: "../../../../docs/launch-security-compliance.md",
      assets: { directory: "../../../.." },
    }),
    "docs/launch-security-compliance.md": readFileSync(
      new URL("../docs/launch-security-compliance.md", import.meta.url),
    ),
    "apps/web/public/logo192.png": readFileSync(
      new URL("../apps/web/public/logo192.png", import.meta.url),
    ),
    "packages/shared/src/public-claims.test.ts": readFileSync(
      new URL("../packages/shared/src/public-claims.test.ts", import.meta.url),
    ),
  });
  execFileSync("git", ["init", "-q"], { cwd: root });

  const failures = scanComplianceClaims({ root, requireGenerated: "web" });
  assert.ok(
    failures.some(({ file }) => file === "docs/launch-security-compliance.md"),
  );
  assert.ok(
    failures.some(
      ({ file, match }) =>
        file === "apps/web/public/logo192.png" &&
        /no bounded exact text decoder/.test(match),
    ),
  );
  assert.ok(
    failures.some(
      ({ file }) => file === "packages/shared/src/public-claims.test.ts",
    ),
  );
});

test("untracked web deploy assets are derived from generated manifest and scanned", (t) => {
  const retiredSourceBytes = readFileSync(
    new URL("../apps/web/public/logo192.png", import.meta.url),
  );
  const root = fixture(t, {
    "apps/web/dist/server/wrangler.json": JSON.stringify({
      main: "index.js",
      assets: { directory: "../client" },
    }),
    "apps/web/dist/server/index.js": "export default {};",
    "apps/web/dist/client/release.test.png": "SOC 2 certified",
    "apps/web/dist/client/opaque.png": Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]),
    // Exact source digest is not transferable into generated deploy output.
    "apps/web/dist/client/logo192.png": retiredSourceBytes,
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
  assert.ok(
    failures.some(
      ({ file, match }) =>
        file.endsWith("apps/web/dist/client/opaque.png") &&
        /no bounded exact text decoder/.test(match),
    ),
  );
  assert.ok(
    failures.some(
      ({ file, match }) =>
        file.endsWith("apps/web/dist/client/logo192.png") &&
        /no bounded exact text decoder/.test(match),
    ),
  );
});

test("generated CodeMirror regex metadata is inert but ordinary bidi copy fails", (t) => {
  const metadata =
    'const specials = RegExp(`[\\0-\\b\\n-\u001f\u061c\u200e\u200f\\u2028\\u2029\u202d\u202e\u2066\u2067\u2069\ufeff\ufff9-\ufffc]`, "gu");';
  const minifiedMetadata = metadata.replace("\\n", "\n");
  const root = fixture(t, {
    "apps/web/dist/server/wrangler.json": JSON.stringify({
      main: "index.js",
      assets: { directory: "../client" },
    }),
    "apps/web/dist/server/index.js": metadata,
    "apps/web/dist/client/safe.js": minifiedMetadata,
    "apps/web/dist/client/attack.js": 'const copy = "safe\u202eclaim";',
  });
  execFileSync("git", ["init", "-q"], { cwd: root });

  const failures = scanComplianceClaims({ root, requireGenerated: "web" });
  assert.ok(failures.some(({ file }) => file.endsWith("attack.js")));
  assert.ok(
    failures.every(
      ({ file }) => !file.endsWith("index.js") && !file.endsWith("safe.js"),
    ),
  );
});

test("retired source digest is no exemption for an explicit scan target", (t) => {
  const root = fixture(t, {
    "apps/web/public/logo192.png": readFileSync(
      new URL("../apps/web/public/logo192.png", import.meta.url),
    ),
  });

  const failures = scanComplianceClaims({
    root,
    targets: ["apps/web/public/logo192.png"],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0]?.match ?? "", /no bounded exact text decoder/);
});

test("retired source asset fails closed if tracked copy references it", (t) => {
  const path = "apps/web/public/logo192.png";
  const root = fixture(t, {
    [path]: readFileSync(
      new URL("../apps/web/public/logo192.png", import.meta.url),
    ),
    "README.md": `![opaque](${path})`,
  });
  initAndTrack(root, [path, "README.md"]);

  assert.throws(
    () => scanComplianceClaims({ root }),
    /Retired opaque asset became referenced/,
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
  assert.ok(failures.length >= 1);
  assert.ok(
    failures.every(({ file }) => file === "convex/_generated/api.test.ts"),
  );
});
