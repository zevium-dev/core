import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const clerkPublicFixture = ["pk", "test", "ZmFrZS5jbGVyay5hY2NvdW50JA"].join(
    "_",
  );
  const clerkSecretFixture = ["sk", "test", "ZmFrZS5jbGVyay5hY2NvdW50JA"].join(
    "_",
  );
  run("pnpm", ["--filter", "@zevium/cli", "build"]);
  run("pnpm", ["--filter", "web", "build"], {
    ...process.env,
    CLERK_PUBLISHABLE_KEY: clerkPublicFixture,
    CLERK_SECRET_KEY: clerkSecretFixture,
    VITE_BUILD_SHA: "0".repeat(40),
    VITE_CONVEX_URL: "https://ci.invalid",
    VITE_GATEWAY_URL: "https://ci.invalid",
  });
  assert.deepEqual(
    readFileSync(
      resolve(repositoryRoot, "apps/web/dist/client/cli/zevium.mjs"),
    ),
    readFileSync(resolve(repositoryRoot, "packages/cli/dist/zevium.mjs")),
    "Web download must match the standalone CLI bundle",
  );
  run("pnpm", ["--filter", "web", "test:csrf-runtime", "--skip-build"]);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
