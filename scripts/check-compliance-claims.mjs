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
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import { findPublicClaimViolations } from "../packages/shared/src/public-claims.ts";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const SNIFF_BYTES = 8 * 1024;

function isDisallowedControlCodePoint(character) {
  const codePoint = character.codePointAt(0);
  return (
    codePoint !== undefined &&
    (codePoint < 9 ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint < 32))
  );
}

// Candid control inventory and detector source necessarily spell out denied
// phrases. They are exact non-deploy publication exceptions, never basenames.
const EXACT_NON_SURFACE_PATHS = new Set([
  ".claude",
  "docs/launch-security-compliance.md",
  "scripts/check-compliance-claims.mjs",
  "packages/shared/src/public-claims.ts",
]);

// Retired legacy media below are inert: README/skill/manifest references are
// removed, and web build deletes retired public copies. Path plus whole-file
// digest is required. A rename, byte change, or generated/deploy copy receives
// no exception and fails closed.
const EXACT_INERT_NON_SURFACE_SHA256 = new Map([
  [
    ".agents/skills/shadcn/assets/shadcn-small.png",
    "0ecc62d682727f68fc4937eed19960c706714fa084d44f63028d611ae02bf3d7",
  ],
  [
    ".agents/skills/shadcn/assets/shadcn.png",
    "7d60ad6fec4d89a0d44ba5a3c9283d2fea0047af5467f9227040e20d927d39b7",
  ],
  [
    "apps/web/public/favicon.ico",
    "b05c05916e4be302aab2d4c77089df5bb1ac41ab141441124597b63b959e5d9f",
  ],
  [
    "apps/web/public/logo192.png",
    "06926ae5ffe1a375a00ba3e7b0f8f9c49395dcae291c5880356d815a4c242654",
  ],
  [
    "apps/web/public/logo512.png",
    "5cb47d47d52faceb4d3a0cd49c6598982703b29083ca8bf68d68f1382d76ec45",
  ],
  [
    "docs/assets/api-detail.png",
    "24a9af68d4a5fc0497d1c5d04c250038cf413cfe466a6ee9d33226ce5d2f1930",
  ],
  [
    "docs/assets/billing.png",
    "4cece06effe7df1e38012ae28545edb8dfcd2d78e8e30b5fe7d1029b6e7df17d",
  ],
  [
    "docs/assets/catalogue.png",
    "252e22590ceaef6972be5650280ed2de2b24170297df70f07caedc81def37195",
  ],
  [
    "docs/assets/demo.gif",
    "6c7a261b74f0da617cb928092a6c7d7eb7e40273d96df20eafa9d45a356b3ae4",
  ],
  [
    "docs/assets/demo.mp4",
    "4e45df96497c27d5b38568c9c94673aa727c4206dbe30d94e448a4ce8d6348b4",
  ],
  [
    "docs/assets/spec-editor.png",
    "c4fe368c06cb12e62f86f3a2fa178b2e494bc32fba7e2b9f71a1ec28fda21914",
  ],
  [
    "docs/polar-e2e-demo.mp4",
    "fdc36f34d34d7addbae954f6cf3863d0b643c4214ac5a34a6ab82c710caa8927",
  ],
]);
// Internal reference material can discuss third-party assurance requirements
// without becoming Zevium publisher copy. Exemption requires exact source path
// and bytes and never transfers to explicit or generated/deploy inventory.
const EXACT_INTERNAL_REFERENCE_SHA256 = new Map([
  [
    ".agents/skills/stripe-best-practices/references/payments.md",
    "4c94d2762e371bf0e0257084f3efcf3358a35b3c54a34f2bb65b530ebb586e79",
  ],
]);
const INERT_REFERENCE_ALLOWLIST = new Map([
  ["apps/web/public/favicon.ico", new Set(["apps/web/scripts/build.mjs"])],
  [
    "apps/web/public/logo192.png",
    new Set([
      "apps/web/scripts/build.mjs",
      "scripts/check-compliance-claims.test.mjs",
    ]),
  ],
  ["apps/web/public/logo512.png", new Set(["apps/web/scripts/build.mjs"])],
]);

// Hostile tests are exempt only while exact path and complete-content digest
// match. Any edit invalidates exemption and fails into normal scanning.
const TEST_FIXTURE_SHA256 = new Map([
  [
    "apps/gateway/test/discovery-mcp.test.ts",
    "49ef95a3a19fc4150c4daa7c4097e0ea326468045d0ddebfe2f59736a7ff1893",
  ],
  [
    "apps/gateway/test/mock.test.ts",
    "8e6930b88f321d6fae8e9de28742476c02740a6fff67712506742fc7906af79b",
  ],
  [
    "apps/gateway/test/pipeline.test.ts",
    "b8c4a5b61537ea4981a91499b7a8ffb5a9de662fd2a53d108b169736a6703806",
  ],
  [
    "apps/gateway/test/spec-source.test.ts",
    "162a963e8353cbf1f44d354c6a337c375325b3d85a9ee2dd65da44efded9c992",
  ],
  [
    "convex/publicClaims.test.ts",
    "92d3ba63a3bcd60379896e987b18e74d3a893817fabf93e424a05ccf6bd7a687",
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
    "c56728846853fa684cd8a60002eec60a13c864a48b51ca2547c6b80ab6ee28d9",
  ],
  [
    "scripts/check-compliance-claims.test.mjs",
    "416cbc59c39411e4fca68a748cfa29f188c457e02a2ff6e25c49196c1229bb1d",
  ],
]);

const TRAVERSAL_SKIP_DIRECTORIES = new Set([".git", ".turbo", "node_modules"]);

const WEB_MANIFEST = "apps/web/dist/server/wrangler.json";
const GATEWAY_OUTPUT_DIR = "apps/gateway/.compliance-dist";
const GATEWAY_METAFILE = `${GATEWAY_OUTPUT_DIR}/bundle-meta.json`;
const GATEWAY_WORKER = `${GATEWAY_OUTPUT_DIR}/index.js`;

function normalizeRelativePath(root, file) {
  // Convert platform separators only. On POSIX, backslash is a valid filename
  // byte and must never alias an exempt repository path.
  return relative(root, file).split(sep).join("/");
}

function isInside(root, target) {
  const rel = relative(root, target).split(sep).join("/");
  return rel === "" || (rel !== ".." && !rel.startsWith("../"));
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function isFingerprintExcluded(relativePath, contents, allowSourceExemption) {
  if (!allowSourceExemption) return false;
  const fixture = TEST_FIXTURE_SHA256.get(relativePath);
  if (fixture !== undefined) return sha256(contents) === fixture;
  const internalReference = EXACT_INTERNAL_REFERENCE_SHA256.get(relativePath);
  if (internalReference !== undefined) {
    return sha256(contents) === internalReference;
  }
  const inert = EXACT_INERT_NON_SURFACE_SHA256.get(relativePath);
  return inert !== undefined && sha256(contents) === inert;
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

function isBrotliCandidate(bytes, relativePath) {
  // Brotli deliberately has no magic number. Reject its conventional suffix,
  // then use a bounded decoder probe so renamed non-empty streams and output
  // bombs cannot masquerade as UTF-8 source. We do not use decoded content as
  // scan evidence: any detected stream remains an opaque rejected input.
  if (relativePath.toLowerCase().endsWith(".br")) return true;
  try {
    return (
      brotliDecompressSync(bytes, { maxOutputLength: MAX_FILE_BYTES + 1 })
        .byteLength > 0
    );
  } catch (error) {
    return (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ERR_BUFFER_TOO_LARGE"
    );
  }
}

function recognizedBinaryKind(contents, relativePath) {
  // Brotli needs complete bytes because it has no magic number; probing only
  // the sniff prefix would miss renamed streams larger than SNIFF_BYTES.
  if (isBrotliCandidate(contents, relativePath)) return "Brotli stream";
  const bytes = contents.subarray(0, SNIFF_BYTES);
  if (hasMagic(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "PNG image";
  if (hasMagic(bytes, [0xff, 0xd8, 0xff])) return "JPEG image";
  if (
    hasMagic(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    hasMagic(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  )
    return "GIF image";
  if (
    hasMagic(bytes, [0x42, 0x4d]) ||
    hasMagic(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    hasMagic(bytes, [0x4d, 0x4d, 0x00, 0x2a]) ||
    hasMagic(bytes, [0x00, 0x00, 0x01, 0x00])
  )
    return "raster image";
  if (
    hasMagic(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    hasMagic(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  )
    return "WebP image";
  if (
    hasMagic(bytes, [0x77, 0x4f, 0x46, 0x46]) ||
    hasMagic(bytes, [0x77, 0x4f, 0x46, 0x32]) ||
    hasMagic(bytes, [0x00, 0x01, 0x00, 0x00]) ||
    hasMagic(bytes, [0x4f, 0x54, 0x54, 0x4f])
  )
    return "binary font";
  if (
    hasMagic(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    hasMagic(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    hasMagic(bytes, [0x50, 0x4b, 0x07, 0x08])
  )
    return "ZIP archive";
  if (hasMagic(bytes, [0x1f, 0x8b])) return "gzip stream";
  if (hasMagic(bytes, [0x42, 0x5a, 0x68])) return "bzip2 stream";
  if (hasMagic(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return "xz stream";
  if (hasMagic(bytes, [0x28, 0xb5, 0x2f, 0xfd])) return "zstd stream";
  if (hasMagic(bytes, [0x04, 0x22, 0x4d, 0x18])) return "LZ4 stream";
  if (
    bytes.length >= 2 &&
    bytes[0] === 0x78 &&
    [0x01, 0x5e, 0x9c, 0xda].includes(bytes[1])
  )
    return "zlib stream";
  if (hasMagic(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))
    return "7z archive";
  if (hasMagic(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]))
    return "RAR archive";
  if (hasMagic(bytes, [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a]))
    return "ar archive";
  if (hasMagic(bytes, [0x4d, 0x53, 0x43, 0x46])) return "CAB archive";
  if (hasMagic(bytes, [0x75, 0x73, 0x74, 0x61, 0x72], 257))
    return "tar archive";
  if (
    bytes
      .subarray(0, Math.min(bytes.length, 1024))
      .indexOf(Buffer.from("%PDF-", "ascii")) >= 0
  )
    return "PDF document";
  if (hasMagic(bytes, [0x66, 0x74, 0x79, 0x70], 4))
    return "ISO media container";
  if (hasMagic(bytes, [0x7f, 0x45, 0x4c, 0x46])) return "ELF binary";
  if (hasMagic(bytes, [0x00, 0x61, 0x73, 0x6d])) return "WebAssembly binary";
  if (hasMagic(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    return "compound binary document";
  if (hasMagic(bytes, [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66]))
    return "SQLite database";
  return null;
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
    new TextDecoder("utf-8", { fatal: true }).decode(sniff);
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

const CODEMIRROR_METADATA_CONSTRUCTORS = new Set([
  String.raw`RegExp([\0-\b\n-        \u2028\u2029        \ufff9-\ufffc], "gu")`,
]);

for (const lineFeed of ["\\n", "\n"]) {
  CODEMIRROR_METADATA_CONSTRUCTORS.add(
    "RegExp(" +
      String.fromCharCode(96) +
      "[\\0-\\b" +
      lineFeed +
      "-" +
      String.fromCodePoint(0x1f, 0x61c, 0x200e, 0x200f) +
      "\\u2028\\u2029" +
      String.fromCodePoint(
        0x202d,
        0x202e,
        0x2066,
        0x2067,
        0x2069,
        0xfeff,
        0xfff9,
      ) +
      "-" +
      String.fromCodePoint(0xfffc) +
      "]" +
      String.fromCharCode(96) +
      ', "gu")',
  );
}
const CODEMIRROR_BUNDLE_METADATA =
  'var Specials = /*@__PURE__*/ new RegExp("[' +
  "\\0-\\b\\n-" +
  String.fromCodePoint(31, 127) +
  "-" +
  String.fromCodePoint(159, 173, 0x61c, 0x200b, 0x200e, 0x200f) +
  "\\u2028\\u2029" +
  String.fromCodePoint(0x202d, 0x202e, 0x2066, 0x2067, 0x2069, 0xfeff, 0xfff9) +
  "-" +
  String.fromCodePoint(0xfffc) +
  ']", UnicodeRegexpSupport$1);';
const CODEMIRROR_MINIFIED_METADATA =
  "oS=/x/.unicode==null?" +
  String.fromCharCode(96) +
  "g" +
  String.fromCharCode(96) +
  ":" +
  String.fromCharCode(96) +
  "gu" +
  String.fromCharCode(96) +
  ",sS=RegExp(" +
  String.fromCharCode(96) +
  "[\\0-\\b\n-" +
  String.fromCodePoint(31, 127) +
  "-" +
  String.fromCodePoint(159, 173, 0x61c, 0x200b, 0x200e, 0x200f) +
  "\\u2028\\u2029" +
  String.fromCodePoint(0x202d, 0x202e, 0x2066, 0x2067, 0x2069, 0xfeff, 0xfff9) +
  "-" +
  String.fromCodePoint(0xfffc) +
  "]" +
  String.fromCharCode(96) +
  ",oS),";

function isCodeMirrorSpecialCharacterMetadata(source, index) {
  // Only the exact generated constructor bytes are exempt. Structural or
  // nearby matches would let a publisher string hitchhike on CodeMirror.
  const constructorStart = source.lastIndexOf("RegExp(", index);
  const bundleStart = source.lastIndexOf("var Specials", index);
  if (
    bundleStart >= 0 &&
    source.slice(
      bundleStart,
      bundleStart + CODEMIRROR_BUNDLE_METADATA.length,
    ) === CODEMIRROR_BUNDLE_METADATA
  ) {
    return true;
  }
  const minifiedStart = source.lastIndexOf("oS=/x/.unicode", index);
  if (
    minifiedStart >= 0 &&
    source.slice(
      minifiedStart,
      minifiedStart + CODEMIRROR_MINIFIED_METADATA.length,
    ) === CODEMIRROR_MINIFIED_METADATA
  ) {
    return true;
  }
  if (constructorStart < 0) return false;
  const constructorEnd = source.indexOf(")", constructorStart);
  if (constructorEnd < 0) return false;
  return CODEMIRROR_METADATA_CONSTRUCTORS.has(
    source.slice(constructorStart, constructorEnd + 1),
  );
}

function decodeCodePoint(value) {
  const point = Number.parseInt(value, 16);
  return Number.isInteger(point) && point <= 0x10ffff
    ? String.fromCodePoint(point)
    : null;
}

function decodeJavaScriptStringBody(body, template = false) {
  const interpolated = template
    ? body.replace(/\$\{\s*(["'])(.*?)\1\s*\}/gs, (_match, _quote, value) =>
        decodeJavaScriptStringBody(value),
      )
    : body;
  let decoded = "";
  for (let index = 0; index < interpolated.length; index += 1) {
    const character = interpolated[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const next = interpolated[index + 1];
    if (next === undefined) {
      decoded += "\\";
      continue;
    }
    if (next === "u") {
      const bracedEnd = interpolated.indexOf("}", index + 3);
      if (interpolated[index + 2] === "{" && bracedEnd > index) {
        const codePoint = decodeCodePoint(
          interpolated.slice(index + 3, bracedEnd),
        );
        if (codePoint !== null) {
          decoded += codePoint;
          index = bracedEnd;
          continue;
        }
      }
      const codePoint = decodeCodePoint(
        interpolated.slice(index + 2, index + 6),
      );
      if (codePoint !== null) {
        decoded += codePoint;
        index += 5;
        continue;
      }
    }
    if (next === "x") {
      const codePoint = decodeCodePoint(
        interpolated.slice(index + 2, index + 4),
      );
      if (codePoint !== null) {
        decoded += codePoint;
        index += 3;
        continue;
      }
    }
    const escapes = {
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      v: "\v",
      0: "\0",
    };
    if (Object.hasOwn(escapes, next)) {
      decoded += escapes[next];
    } else if (next === "\n" || next === "\r") {
      if (next === "\r" && interpolated[index + 2] === "\n") index += 1;
    } else {
      decoded += next;
    }
    index += 1;
  }
  return decoded;
}

function quotedRuntimeStrings(source) {
  const strings = [];
  for (let start = 0; start < source.length; start += 1) {
    if (source.startsWith("//", start)) {
      const lineEnd = source.indexOf("\n", start + 2);
      start = lineEnd < 0 ? source.length : lineEnd;
      continue;
    }
    if (source.startsWith("/*", start)) {
      const commentEnd = source.indexOf("*/", start + 2);
      start = commentEnd < 0 ? source.length : commentEnd + 1;
      continue;
    }
    const quote = source[start];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    let end = start + 1;
    for (; end < source.length; end += 1) {
      if (source[end] === "\\") {
        end += 1;
        continue;
      }
      if (source[end] === quote) break;
    }
    if (end >= source.length) continue;
    const body = source.slice(start + 1, end);
    const value = decodeJavaScriptStringBody(body, quote === "`");
    if (Buffer.byteLength(value, "utf8") <= MAX_FILE_BYTES) {
      strings.push({ value, start, end: end + 1 });
    }
    start = end;
  }
  return strings;
}

function decodeMarkupAndCss(source) {
  let decoded = source.replace(
    /\\([0-9a-f]{1,6})(?:\s)?/gi,
    (_match, value) => {
      return decodeCodePoint(value) ?? " ";
    },
  );
  decoded = decoded.replace(/&#x([0-9a-f]{1,8});?/gi, (_match, value) => {
    return decodeCodePoint(value) ?? " ";
  });
  decoded = decoded.replace(/&#([0-9]{1,8});?/g, (_match, value) => {
    const point = Number.parseInt(value, 10);
    return Number.isInteger(point) && point <= 0x10ffff
      ? String.fromCodePoint(point)
      : " ";
  });
  return decoded.replace(/%([0-9a-f]{2})/gi, (_match, value) =>
    String.fromCodePoint(Number.parseInt(value, 16)),
  );
}

function decodedJsonStrings(source) {
  try {
    const value = JSON.parse(source);
    const strings = [];
    const visit = (current) => {
      if (typeof current === "string") strings.push(current);
      else if (Array.isArray(current)) current.forEach(visit);
      else if (current !== null && typeof current === "object") {
        Object.entries(current).forEach(([key, child]) => {
          strings.push(key);
          visit(child);
        });
      }
    };
    visit(value);
    return strings.filter(
      (value) => Buffer.byteLength(value, "utf8") <= MAX_FILE_BYTES,
    );
  } catch {
    return [];
  }
}

function decodedEncodedLiterals(source, literals) {
  const variants = [];
  const isBoundedText = (value) => {
    if (value.length === 0 || Buffer.byteLength(value) > MAX_FILE_BYTES) {
      return false;
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value));
      return !value
        .split("")
        .some(
          (character) =>
            isDisallowedControlCodePoint(character) || character === "",
        );
    } catch {
      return false;
    }
  };
  for (const literal of literals) {
    const context = source.slice(
      Math.max(0, literal.start - 96),
      Math.min(source.length, literal.end + 96),
    );
    if (
      /\b(?:atob|Buffer\.from)\s*\(\s*["']/iu.test(context) ||
      /,\s*["']base64["']/iu.test(context)
    ) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(literal.value)) continue;
      try {
        const decoded = Buffer.from(literal.value, "base64").toString("utf8");
        if (isBoundedText(decoded)) {
          variants.push(decoded);
        }
      } catch {
        // Invalid encodings remain covered by raw source scanning.
      }
    }
    if (
      (/(?:fromhex|decodehex)\s*\(/iu.test(context) ||
        /,\s*["']hex["']/iu.test(context)) &&
      /^[0-9a-f]+$/i.test(literal.value) &&
      literal.value.length % 2 === 0
    ) {
      try {
        const decoded = Buffer.from(literal.value, "hex").toString("utf8");
        if (isBoundedText(decoded)) {
          variants.push(decoded);
        }
      } catch {
        // Invalid encodings remain covered by raw source scanning.
      }
    }
  }
  return variants;
}

function reconstructedStringVariants(source, literals) {
  const variants = [];
  for (let start = 0; start < literals.length; start += 1) {
    let value = literals[start].value;
    let end = start;
    while (end + 1 < literals.length) {
      const gap = source.slice(literals[end].end, literals[end + 1].start);
      if (!/^\s*\+\s*$/u.test(gap)) break;
      value += literals[end + 1].value;
      end += 1;
      if (Buffer.byteLength(value) > MAX_FILE_BYTES) break;
      if (end > start) variants.push(value);
    }
  }

  const joinPattern =
    /\[([\s\S]{0,4096})\]\s*\.join\s*\(\s*([\s\S]{0,256}?)\s*\)/gu;
  for (const match of source.matchAll(joinPattern)) {
    const inner = match[1] ?? "";
    const parts = quotedRuntimeStrings(inner);
    if (parts.length === 0) continue;
    const stripped = inner.replace(/["'`](?:\\.|[\s\S])*?["'`]/gu, "");
    if (/[^\s,]/u.test(stripped)) continue;
    const separatorParts = quotedRuntimeStrings(match[2] ?? "");
    const separator = separatorParts[0]?.value ?? ",";
    const value = parts.map(({ value: part }) => part).join(separator);
    if (Buffer.byteLength(value) <= MAX_FILE_BYTES) variants.push(value);
  }

  const staticValues = new Map();
  const assignmentPattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/gu;
  const evaluate = (expression) => {
    const terms = expression.split(/\s*\+\s*/u);
    let value = "";
    for (const term of terms) {
      const trimmed = term.trim();
      if (/^[A-Za-z_$][\w$]*$/u.test(trimmed)) {
        const resolved = staticValues.get(trimmed);
        if (resolved === undefined) return null;
        value += resolved;
        continue;
      }
      const termLiterals = quotedRuntimeStrings(trimmed);
      if (termLiterals.length !== 1) return null;
      value += termLiterals[0].value;
    }
    return Buffer.byteLength(value) <= MAX_FILE_BYTES ? value : null;
  };
  for (const assignment of source.matchAll(assignmentPattern)) {
    const name = assignment[1];
    const value = evaluate(assignment[2] ?? "");
    if (name === undefined || value === null) continue;
    staticValues.set(name, value);
    variants.push(value);
  }
  return variants;
}

function runtimeSourceVariants(source, relativePath) {
  const literals = quotedRuntimeStrings(source);
  const runtimeLiterals = literals.filter(({ start }) => {
    const before = source.slice(Math.max(0, start - 48), start);
    return !/(?:new\s+)?RegExp\s*\(\s*["'`]$/u.test(before);
  });
  const markupOrCss = /\.(?:css|html?)$/iu.test(relativePath);
  const variants = [
    ...runtimeLiterals.map(({ value }) => value),
    ...decodedEncodedLiterals(source, runtimeLiterals),
    ...(markupOrCss ? [decodeMarkupAndCss(source)] : []),
    ...(markupOrCss
      ? runtimeLiterals.map(({ value }) => decodeMarkupAndCss(value))
      : []),
    ...decodedJsonStrings(source),
    ...reconstructedStringVariants(source, runtimeLiterals),
  ];
  const represented = new Set();
  return variants.filter((variant) => {
    if (
      variant.length === 0 ||
      represented.has(variant) ||
      source.includes(variant)
    ) {
      return false;
    }
    represented.add(variant);
    return represented.size <= 512;
  });
}

export { runtimeSourceVariants };

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

function assertInertAssetsRemainUnreferenced(root, files) {
  const assets = [...EXACT_INERT_NON_SURFACE_SHA256.keys()].map(
    (assetPath) => ({
      assetPath,
      basename: Buffer.from(
        assetPath.slice(assetPath.lastIndexOf("/") + 1),
        "utf8",
      ),
      allowedReferences: INERT_REFERENCE_ALLOWLIST.get(assetPath),
    }),
  );
  for (const file of files) {
    const relativePath = normalizeRelativePath(root, file);
    const read = readBoundedFile(root, file);
    if (read.contents === undefined) continue;
    for (const asset of assets) {
      if (
        relativePath === asset.assetPath ||
        relativePath === "scripts/check-compliance-claims.mjs" ||
        asset.allowedReferences?.has(relativePath) === true
      ) {
        continue;
      }
      if (read.contents.includes(asset.basename)) {
        throw new Error(
          `Retired opaque asset became referenced: ${asset.assetPath} from ${relativePath}`,
        );
      }
    }
  }
}

export function scanComplianceClaims({
  root = process.cwd(),
  targets,
  requireGenerated = "none",
} = {}) {
  const failures = [];
  const defaultFiles = targets === undefined ? listDefaultClaimFiles(root) : [];
  const generatedFiles =
    targets === undefined
      ? listGeneratedClaimFiles(root, requireGenerated)
      : [];
  const candidates =
    targets === undefined
      ? [...defaultFiles, ...generatedFiles]
      : targets.flatMap((target) => filesUnder(root, target));
  const files = [...new Set(candidates.map((file) => resolve(file)))];
  const generated = new Set(generatedFiles.map((file) => resolve(file)));
  const defaultScope = targets === undefined;
  if (defaultScope) assertInertAssetsRemainUnreferenced(root, files);

  for (const file of files) {
    const relativePath = normalizeRelativePath(root, file);
    // Source-only exceptions never transfer to an explicit scan or to a path
    // named by generated deploy inventory, even when path and bytes are exact.
    const allowSourceExemption = defaultScope && !generated.has(resolve(file));
    if (allowSourceExemption && EXACT_NON_SURFACE_PATHS.has(relativePath)) {
      continue;
    }
    const read = readBoundedFile(root, file);
    if (read.failure) {
      failures.push(read.failure);
      continue;
    }
    const contents = read.contents;
    if (isFingerprintExcluded(relativePath, contents, allowSourceExemption)) {
      continue;
    }

    const binaryKind = recognizedBinaryKind(contents, relativePath);
    if (binaryKind !== null) {
      // No format decoder is implemented. Raw UTF-8 conversion is not decoded
      // extraction and cannot inspect compressed streams, archives, PDF text,
      // or pixels. Reject every recognized opaque format. Any future decoder
      // must first enforce compressed/input bytes, expanded bytes, entry count,
      // nesting depth, and normalized in-root member paths, then scan every
      // exact decoded text stream before this branch may allow that format.
      failures.push(
        unsafeFailure(
          relativePath,
          `${binaryKind} has no bounded exact text decoder`,
        ),
      );
      continue;
    }

    const unknownBinary = hasUnknownBinaryBytes(contents);
    // NUL/control bytes become separators so a claim in malformed text is
    // still reported in addition to the fail-closed unknown-binary error.
    const rawSource = contents.toString("utf8");
    const source = rawSource
      .split("")
      .map((character) =>
        isDisallowedControlCodePoint(character) ? " " : character,
      )
      .join("");
    for (const violation of findPublicClaimViolations(source)) {
      if (
        violation.label === "bidirectional control" &&
        generated.has(resolve(file)) &&
        isCodeMirrorSpecialCharacterMetadata(rawSource, violation.index)
      ) {
        continue;
      }
      failures.push({
        file: relativePath,
        line: lineAt(source, violation.index),
        label: violation.label,
        match: violation.match.replace(/\s+/g, " ").trim(),
      });
    }
    const exactCodeMirrorMetadata =
      generated.has(resolve(file)) &&
      [
        ...CODEMIRROR_METADATA_CONSTRUCTORS,
        CODEMIRROR_BUNDLE_METADATA,
        CODEMIRROR_MINIFIED_METADATA,
      ].some((metadata) => rawSource.includes(metadata));
    for (const runtimeSource of runtimeSourceVariants(
      rawSource,
      relativePath,
    )) {
      const runtimeViolations = findPublicClaimViolations(runtimeSource);
      const runtimeOnlyBidi = runtimeViolations.every(
        ({ label }) => label === "bidirectional control",
      );
      for (const violation of runtimeViolations) {
        if (exactCodeMirrorMetadata && runtimeOnlyBidi) continue;
        failures.push({
          file: relativePath,
          line: 1,
          label: violation.label,
          match: violation.match.replace(/\s+/g, " ").trim(),
        });
      }
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
