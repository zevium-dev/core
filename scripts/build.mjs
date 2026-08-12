import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

import { applyProductionEnv } from "../apps/web/scripts/build-env.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const localEnvPath = resolve(repoRoot, "apps/web/.env.production.local");
const forbiddenArtifact = resolve(repoRoot, "apps/web/dist/server/.dev.vars");

applyProductionEnv(
  process.env,
  existsSync(localEnvPath) ? readFileSync(localEnvPath, "utf8") : "",
);

process.env.VITE_BUILD_SHA ??= execFileSync(
  "git",
  ["rev-parse", "--verify", "HEAD"],
  { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
).trim();

for (const name of [
  "CLERK_SECRET_KEY",
  "VITE_BUILD_SHA",
  "VITE_CLERK_PUBLISHABLE_KEY",
  "VITE_CONVEX_URL",
  "VITE_GATEWAY_URL",
]) {
  if (!process.env[name]) {
    throw new Error(`${name} is required for a production build`);
  }
}
if (!/^[0-9a-f]{40}$/.test(process.env.VITE_BUILD_SHA)) {
  throw new Error("VITE_BUILD_SHA must be a full lowercase Git SHA");
}

function scrubForbiddenArtifact() {
  if (existsSync(forbiddenArtifact)) unlinkSync(forbiddenArtifact);
}

scrubForbiddenArtifact();
try {
  const result = spawnSync("pnpm", ["exec", "turbo", "build"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  scrubForbiddenArtifact();
}
