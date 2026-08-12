import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    env,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

try {
  run(process.execPath, [
    resolve(import.meta.dirname, "check-generated-routes.mjs"),
  ]);
  run("pnpm", ["--filter", "web", "build"], {
    ...process.env,
    CLERK_PUBLISHABLE_KEY: "pk_test_ZmFrZS5jbGVyay5hY2NvdW50JA",
    CLERK_SECRET_KEY: "sk_test_ZmFrZS5jbGVyay5hY2NvdW50JA",
    VITE_CONVEX_URL: "https://ci.invalid",
    VITE_GATEWAY_URL: "https://ci.invalid",
  });
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
