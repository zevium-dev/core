import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

import { applyProductionEnv } from "./build-env.mjs";

applyProductionEnv(process.env);

for (const name of [
  "CLERK_SECRET_KEY",
  "VITE_BUILD_SHA",
  "VITE_CLERK_PUBLISHABLE_KEY",
  "VITE_CONVEX_URL",
  "VITE_GATEWAY_URL",
]) {
  if (!process.env[name]?.trim()) {
    throw new Error(`${name} is required for a production build`);
  }
}

if (process.argv.includes("--check-env")) {
  process.stdout.write("Production build environment is complete\n");
  process.exit(0);
}

if (!/^[0-9a-f]{40}$/.test(process.env.VITE_BUILD_SHA)) {
  throw new Error("VITE_BUILD_SHA must be a full lowercase Git SHA");
}

const forbiddenArtifact = resolve(
  import.meta.dirname,
  "../dist/server/.dev.vars",
);
const viteEnv = { ...process.env };
delete viteEnv.CLERK_SECRET_KEY;
delete viteEnv.CLERK_PUBLISHABLE_KEY;

function scrubForbiddenArtifact() {
  if (existsSync(forbiddenArtifact)) unlinkSync(forbiddenArtifact);
}

scrubForbiddenArtifact();
try {
  const result = spawnSync("pnpm", ["exec", "vite", "build"], {
    env: viteEnv,
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  scrubForbiddenArtifact();
}
