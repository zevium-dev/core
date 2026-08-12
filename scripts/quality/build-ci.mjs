import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { assertNoExecutableArtifacts } from "./tracked-tree.mjs";

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
  run(process.execPath, [
    resolve(import.meta.dirname, "check-generated-routes.mjs"),
  ]);
  run("pnpm", ["--filter", "web", "build"], {
    ...process.env,
    CLERK_PUBLISHABLE_KEY: clerkPublicFixture,
    CLERK_SECRET_KEY: clerkSecretFixture,
    VITE_CONVEX_URL: "https://ci.invalid",
    VITE_GATEWAY_URL: "https://ci.invalid",
  });
  assertNoExecutableArtifacts(resolve(repositoryRoot, "apps/web/dist"));
  for (const generated of [
    resolve(repositoryRoot, "convex/_generated"),
    resolve(repositoryRoot, "apps/web/src/routeTree.gen.ts"),
  ]) {
    assertNoExecutableArtifacts(generated);
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
