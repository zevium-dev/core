import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const scratchRoot = resolve(packageRoot, ".tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(resolve(scratchRoot, "distribution-"));
const bundle = resolve(scratch, "zevium.mjs");
copyFileSync(resolve(packageRoot, "dist/zevium.mjs"), bundle);
const loader = resolve(scratch, "isolate.mjs");
writeFileSync(
  loader,
  `
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (result.url !== ${JSON.stringify(pathToFileURL(bundle).href)} && !result.url.startsWith("node:")) {
      throw new Error("External module resolution forbidden: " + specifier);
    }
    return result;
  }
});
if (process.env.TEST_NODE_VERSION) {
  Object.defineProperty(process.versions, "node", { value: process.env.TEST_NODE_VERSION });
}
`,
);
const env = { PATH: process.env.PATH, NODE_PATH: "", NODE_OPTIONS: "" };
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("single-file CLI distribution", () => {
  it("runs help with only the bundle and Node builtins resolvable", () => {
    expect(readFileSync(bundle, "utf8").split("\n")[0]).toBe(
      "#!/usr/bin/env node",
    );
    expect(statSync(bundle).mode & 0o111).toBe(0o111);
    const output = execFileSync(
      process.execPath,
      ["--import", loader, bundle, "--help"],
      {
        cwd: scratch,
        env,
        encoding: "utf8",
      },
    );
    expect(output).toContain("Usage: zevium <publisher> <project>");
    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, "package.json"), "utf8"),
    );
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.bin.zevium).toBe("./dist/zevium.mjs");
  });

  it("runs as an executable renamed to zevium", () => {
    writeFileSync(resolve(scratch, "package.json"), '{"type":"commonjs"}');
    const executable = resolve(scratch, "zevium");
    copyFileSync(bundle, executable);
    expect(
      execFileSync(executable, ["--help"], {
        cwd: scratch,
        env,
        encoding: "utf8",
      }),
    ).toContain("Usage: zevium");
  });

  it.each(["18.20.0", "22.20.0", "24.14.9"])(
    "rejects Node %s before starting",
    (version) => {
      const result = spawnSync(
        process.execPath,
        ["--import", loader, bundle, "--help"],
        {
          cwd: scratch,
          env: { ...env, TEST_NODE_VERSION: version },
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `zevium: Node.js 24.15.0 or newer is required; found ${version}.\n`,
      );
    },
  );

  it.each(["24.15.0", "24.16.0", "25.0.0"])("accepts Node %s", (version) => {
    expect(
      execFileSync(process.execPath, ["--import", loader, bundle, "--help"], {
        cwd: scratch,
        env: { ...env, TEST_NODE_VERSION: version },
        encoding: "utf8",
      }),
    ).toContain("Usage: zevium");
  });
});
