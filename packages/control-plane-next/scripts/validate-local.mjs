import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));
// Never inherit cloud deployment credentials or select the parent's dotenv file.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !name.startsWith("CONVEX_") && !name.startsWith("VITE_CONVEX_"),
  ),
);
env.CONVEX_AGENT_MODE = "anonymous";
env.CLERK_JWT_ISSUER_DOMAIN = "https://clerk.invalid";
mkdirSync(new URL("../.tmp/", import.meta.url), { recursive: true });
env.TMPDIR = fileURLToPath(new URL("../.tmp/", import.meta.url));
function assertLocal() {
  if (existsSync(new URL("../.env", import.meta.url)))
    throw new Error("Use only the guarded package-local .env.local");
  const path = new URL("../.env.local", import.meta.url);
  if (!existsSync(path)) return;
  const contents = readFileSync(path, "utf8");
  if (
    /^CONVEX_(DEPLOY_KEY|SELF_HOSTED_URL|SELF_HOSTED_ADMIN_KEY)=/m.test(
      contents,
    )
  )
    throw new Error("Refusing deployment credential overrides");
  if (
    !/^CONVEX_DEPLOYMENT=anonymous:/m.test(contents) ||
    !/^CONVEX_URL=http:\/\/127\.0\.0\.1:\d+\s*$/m.test(contents)
  )
    throw new Error("Refusing non-anonymous or non-loopback next deployment");
}
function run(args) {
  const result = spawnSync("pnpm", ["exec", "convex", ...args], {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`Local Convex ${args[0]} failed`);
}
assertLocal();
run(["init"]);
assertLocal();
run(["env", "set", "CLERK_JWT_ISSUER_DOMAIN", "https://clerk.invalid"]);
run(["dev", "--once", "--typecheck", "enable"]);
