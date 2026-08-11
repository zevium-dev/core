import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { applyProductionEnv } from "./build-env.mjs";

const localProductionEnv = new URL("../.env.production.local", import.meta.url);
if (existsSync(localProductionEnv)) {
  applyProductionEnv(process.env, readFileSync(localProductionEnv, "utf8"));
} else {
  applyProductionEnv(process.env);
}

for (const name of [
  "CLERK_SECRET_KEY",
  "VITE_CLERK_PUBLISHABLE_KEY",
  "VITE_CONVEX_URL",
  "VITE_GATEWAY_URL",
]) {
  if (!process.env[name]) {
    throw new Error(`${name} is required for a production build`);
  }
}

const result = spawnSync("pnpm", ["exec", "vite", "build"], {
  env: process.env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
