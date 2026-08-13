import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { DeploymentManifest } from "../../src/manifest";

const execute = promisify(execFile);
const temporaryRoots: string[] = [];

interface DryRunOutput {
  manifest: DeploymentManifest;
  manifestDigest: string;
}

async function runRegistration(
  moduleRoot: string,
  assetRoot: string,
): Promise<DryRunOutput> {
  const { stdout } = await execute(
    process.execPath,
    [
      "--experimental-strip-types",
      "scripts/register.ts",
      "--dry-run",
      "--profile",
      "production-web",
    ],
    {
      cwd: new URL("../..", import.meta.url),
      env: {
        ...process.env,
        CLERK_SECRET_KEY: "correct-secret",
        DEPLOY_ASSET_ROOT: assetRoot,
        DEPLOY_HEAD_SHA: "a".repeat(40),
        DEPLOY_MAIN_MODULE: "index.js",
        DEPLOY_MODULE_ROOT: moduleRoot,
        GITHUB_EVENT_NAME: "workflow_run",
        GITHUB_REF: "refs/heads/develop",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9002",
        GITHUB_SHA: "c".repeat(40),
        SOURCE_RUN_ID: "8999",
      },
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as DryRunOutput;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("registration artifact inventory", () => {
  it("cryptographically changes manifest when module or asset bytes change", async () => {
    const root = await mkdtemp(join(tmpdir(), "zevium-broker-inventory-"));
    temporaryRoots.push(root);
    const moduleRoot = join(root, "modules");
    const assetRoot = join(root, "assets");
    await Promise.all([mkdir(moduleRoot), mkdir(assetRoot)]);
    await Promise.all([
      writeFile(join(moduleRoot, "index.js"), "export default {value: 1}\n"),
      writeFile(join(assetRoot, "index.html"), "<h1>first</h1>\n"),
      writeFile(join(assetRoot, ".assetsignore"), ".dev.vars\n"),
      writeFile(join(assetRoot, ".dev.vars"), "must-not-ship\n"),
    ]);

    const first = await runRegistration(moduleRoot, assetRoot);
    expect(first.manifest.schema).toBe("zevium.cloudflare-deploy/v2");
    expect(first.manifest.targets[0]?.modules).toEqual([
      expect.objectContaining({
        contentType: "application/javascript+module",
        name: "index.js",
        size: 26,
      }),
    ]);
    expect(first.manifest.targets[0]?.staticAssets).toEqual([
      expect.objectContaining({ path: "/index.html", size: 15 }),
    ]);
    expect(first.manifest.targets[0]?.staticAssets).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "/.dev.vars" })]),
    );

    await Promise.all([
      writeFile(join(moduleRoot, "index.js"), "export default {value: 2}\n"),
      writeFile(join(assetRoot, "index.html"), "<h1>second</h1>\n"),
    ]);
    const second = await runRegistration(moduleRoot, assetRoot);

    expect(second.manifestDigest).not.toBe(first.manifestDigest);
    expect(second.manifest.targets[0]?.modules[0]?.sha256).not.toBe(
      first.manifest.targets[0]?.modules[0]?.sha256,
    );
    expect(second.manifest.targets[0]?.staticAssets[0]?.sha256).not.toBe(
      first.manifest.targets[0]?.staticAssets[0]?.sha256,
    );
    expect(
      second.manifest.targets[0]?.staticAssets[0]?.cloudflareHash,
    ).not.toBe(first.manifest.targets[0]?.staticAssets[0]?.cloudflareHash);
  });

  it("rejects symlinks from signed artifact roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "zevium-broker-symlink-"));
    temporaryRoots.push(root);
    const moduleRoot = join(root, "modules");
    const assetRoot = join(root, "assets");
    await Promise.all([mkdir(moduleRoot), mkdir(assetRoot)]);
    await Promise.all([
      writeFile(join(moduleRoot, "real.js"), "export default {}\n"),
      symlink("real.js", join(moduleRoot, "index.js")),
      writeFile(join(assetRoot, "index.html"), "ok\n"),
    ]);

    await expect(runRegistration(moduleRoot, assetRoot)).rejects.toThrow(
      "artifact inventory contains symlink",
    );
  });
});
