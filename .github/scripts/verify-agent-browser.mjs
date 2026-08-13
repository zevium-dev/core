import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LOCK = Object.freeze({
  packageVersion: "0.27.1",
  chromeVersion: "151.0.7922.77",
  chromeSha256:
    "3ecd43f567afe5204b7673b2dd2ccf05603f41b2f62ad3bca9e691d0b3d54128",
  wrapperSha256:
    "8e382f4a5ba22f45e1e0339abfe5a55ed95a19540b16a69ee3faf31c8dc8216a",
  native: Object.freeze({
    "linux:x64": Object.freeze({
      name: "agent-browser-linux-x64",
      sha256:
        "95ff8224a971698d9df8add26f1f571027c35f9003e3067c53e54d154b5b1ea1",
    }),
  }),
});

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function exactExecutable(path, expectedDigest, name, allowSymlink = false) {
  const absolute = resolve(path);
  const real = realpathSync(absolute);
  const stat = statSync(real);
  if (
    (!allowSymlink && absolute !== real) ||
    !stat.isFile() ||
    (stat.mode & 0o111) === 0
  ) {
    throw new Error(`${name} must be exact non-symlink executable`);
  }
  if (digest(real) !== expectedDigest) {
    throw new Error(`${name} SHA-256 mismatch`);
  }
  return real;
}

export function verifyLockedBrowser({ workspace, chromePath }) {
  const packageRoot = resolve(workspace, "node_modules/agent-browser");
  const packageRealRoot = realpathSync(packageRoot);
  const packageJsonPath = join(packageRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.version !== LOCK.packageVersion) {
    throw new Error("agent-browser package version mismatch");
  }
  const wrapper = exactExecutable(
    join(packageRoot, "bin/agent-browser.js"),
    LOCK.wrapperSha256,
    "agent-browser wrapper",
    true,
  );
  const nativeLock = LOCK.native[`${process.platform}:${process.arch}`];
  if (nativeLock === undefined) {
    throw new Error(
      "runner platform has no locked agent-browser native binary",
    );
  }
  const native = exactExecutable(
    join(packageRoot, "bin", nativeLock.name),
    nativeLock.sha256,
    "agent-browser native binary",
    true,
  );
  if (
    !wrapper.startsWith(`${packageRealRoot}/`) ||
    !native.startsWith(`${packageRealRoot}/`)
  ) {
    throw new Error("agent-browser executables escaped locked package root");
  }
  const chrome = exactExecutable(
    chromePath,
    LOCK.chromeSha256,
    "Chrome for Testing",
  );
  const cliVersion = execFileSync(wrapper, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (cliVersion !== `agent-browser ${LOCK.packageVersion}`) {
    throw new Error("agent-browser CLI version mismatch");
  }
  const chromeVersion = execFileSync(chrome, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!chromeVersion.endsWith(` ${LOCK.chromeVersion}`)) {
    throw new Error("Chrome for Testing version mismatch");
  }
  return Object.freeze({
    browserExecutable: chrome,
    cli: wrapper,
    native,
    packageVersion: LOCK.packageVersion,
    chromeVersion: LOCK.chromeVersion,
  });
}

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    const match = token.match(/^--([a-z-]+)=(.+)$/);
    if (!match || Object.hasOwn(args, match[1])) {
      throw new Error(`Invalid browser verifier argument: ${token}`);
    }
    args[match[1]] = match[2];
  }
  return args;
}

export function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = verifyLockedBrowser({
    workspace: args.workspace,
    chromePath: args.chrome,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    run();
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "browser lock verification failed",
    );
    process.exitCode = 1;
  }
}

export { LOCK };
