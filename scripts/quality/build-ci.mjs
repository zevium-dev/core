import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
try {
  const drift = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, "check-generated-routes.mjs")],
    { cwd: repositoryRoot, stdio: "inherit", env: process.env },
  );
  if (drift.status !== 0) throw new Error("Generated drift check failed");
  const build = spawnSync("pnpm", ["--filter", "web", "build"], {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      CLERK_PUBLISHABLE_KEY: "pk_test_ZmFrZS5jbGVyay5hY2NvdW50JA",
      CLERK_SECRET_KEY: "sk_test_ZmFrZS5jbGVyay5hY2NvdW50JA",
      VITE_CONVEX_URL: "https://ci.invalid",
      VITE_GATEWAY_URL: "https://ci.invalid",
    },
  });
  if (build.status !== 0) throw new Error("Production build failed");
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
