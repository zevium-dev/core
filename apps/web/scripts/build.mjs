import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const localProductionEnv = new URL("../.env.production.local", import.meta.url);
if (existsSync(localProductionEnv)) {
  for (const line of readFileSync(localProductionEnv, "utf8").split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;

    const name = line.slice(0, separator);
    if (process.env[name] !== undefined) continue;

    const rawValue = line.slice(separator + 1);
    process.env[name] =
      rawValue.startsWith('"') && rawValue.endsWith('"')
        ? JSON.parse(rawValue)
        : rawValue;
  }
}

process.env.VITE_CLERK_PUBLISHABLE_KEY ??= process.env.CLERK_PUBLISHABLE_KEY;

for (const name of [
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
