import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";

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
// Cloudflare's Vite adapter may materialize local secrets for preview. That
// file is never a deploy input and must not enter CI artifacts.
rmSync(new URL("../dist/server/.dev.vars", import.meta.url), { force: true });
// Retired raster PWA assets remain in older checkouts but are not referenced by
// current manifest. Never carry opaque, non-decodable files into deploy input.
for (const name of ["favicon.ico", "logo192.png", "logo512.png"]) {
  rmSync(new URL(`../dist/client/${name}`, import.meta.url), { force: true });
}
process.exit(result.status ?? 1);
