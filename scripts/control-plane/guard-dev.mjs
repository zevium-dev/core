import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

const refusal =
  "Refusing Convex dev: select an anonymous/local backend or an activated deployment with NEXT_DEPLOYMENT_ID. See .agents/notes/architecture/convex-activation.md. Never mark a legacy target merely to bypass this guard.";

export function isLocalDeployment(value) {
  return /^(anonymous|local):[A-Za-z0-9_-]+$/.test(value ?? "");
}

export function guardDev(env, readMarker) {
  // Deploy keys can override CONVEX_DEPLOYMENT, including an anonymous selector.
  // Ordinary dev must not accidentally inherit production/preview credentials.
  if (env.CONVEX_DEPLOY_KEY || env.CONVEX_DEPLOYMENT_TOKEN)
    throw new Error(
      `${refusal} Unset deployment credentials before ordinary dev.`,
    );
  if (env.CONVEX_SELF_HOSTED_URL || env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
    const url = new URL(env.CONVEX_SELF_HOSTED_URL);
    if (
      !env.CONVEX_DEPLOYMENT &&
      env.CONVEX_SELF_HOSTED_ADMIN_KEY &&
      ["http:", "https:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      return;
    throw new Error(refusal);
  }
  if (isLocalDeployment(env.CONVEX_DEPLOYMENT)) return;
  if (!/^dev:[A-Za-z0-9_-]+$/.test(env.CONVEX_DEPLOYMENT ?? ""))
    throw new Error(refusal);
  const result = readMarker();
  if (result.status !== 0 || !result.stdout?.trim()) throw new Error(refusal);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    // Same precedence as Convex: process environment, .env.local, then .env.
    for (const file of [".env.local", ".env"])
      if (existsSync(file)) loadEnvFile(file);
    guardDev(process.env, () =>
      spawnSync(
        "pnpm",
        ["exec", "convex", "env", "get", "NEXT_DEPLOYMENT_ID"],
        {
          env: process.env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        },
      ),
    );
    console.log("Convex dev target passed cutover guard.");
  } catch {
    console.error(refusal);
    process.exitCode = 1;
  }
}
