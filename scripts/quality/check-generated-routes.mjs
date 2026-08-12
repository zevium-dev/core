import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");

export function assertGeneratedFileFresh({
  cwd,
  file,
  command,
  args,
  env = process.env,
  stdio = "pipe",
}) {
  const path = resolve(cwd, file);
  const before = readFileSync(path);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    stdio,
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || "Generator command failed",
    );
  }
  const after = readFileSync(path);
  if (!before.equals(after)) {
    throw new Error(`${path} was stale; regenerate and commit it`);
  }
}

if (process.argv[1] === import.meta.filename) {
  try {
    assertGeneratedFileFresh({
      cwd: resolve(repositoryRoot, "apps/web"),
      file: "src/routeTree.gen.ts",
      command: "pnpm",
      args: ["build"],
      env: {
        ...process.env,
        CLERK_PUBLISHABLE_KEY: "pk_test_ZmFrZS5jbGVyay5hY2NvdW50JA",
        CLERK_SECRET_KEY: "sk_test_ZmFrZS5jbGVyay5hY2NvdW50JA",
        VITE_CONVEX_URL: "https://ci.invalid",
        VITE_GATEWAY_URL: "https://ci.invalid",
      },
      stdio: "inherit",
    });
    process.stdout.write("Generated route tree is fresh\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
