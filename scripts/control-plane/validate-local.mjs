import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
mkdirSync(path.join(root, ".tmp"), { recursive: true });
const scratch = mkdtempSync(path.join(root, ".tmp/schema-"));
for (const name of [
  "convex",
  "contracts",
  "convex.json",
  "tsconfig.json",
  "package.json",
])
  cpSync(path.join(root, name), path.join(scratch, name), { recursive: true });
symlinkSync(
  path.join(root, "node_modules"),
  path.join(scratch, "node_modules"),
  "dir",
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !name.startsWith("CONVEX_") && !name.startsWith("VITE_CONVEX_"),
  ),
);
env.CONVEX_AGENT_MODE = "anonymous";
env.TMPDIR = path.join(root, ".tmp");
function run(args) {
  const result = spawnSync("pnpm", ["exec", "convex", ...args], {
    cwd: scratch,
    env,
    stdio: "inherit",
  });
  assert.equal(result.status, 0, `Local Convex ${args[0]} failed`);
}
run(["init"]);
const config = readFileSync(path.join(scratch, ".env.local"), "utf8");
assert.match(config, /^CONVEX_DEPLOYMENT=anonymous:/m);
assert.match(config, /^CONVEX_URL=http:\/\/127\.0\.0\.1:\d+\s*$/m);
assert.doesNotMatch(
  config,
  /^CONVEX_(DEPLOY_KEY|SELF_HOSTED_URL|SELF_HOSTED_ADMIN_KEY)=/m,
);
run(["env", "set", "CLERK_JWT_ISSUER_DOMAIN", "https://clerk.invalid"]);
run(["dev", "--once", "--typecheck", "enable"]);
cpSync(
  path.join(scratch, "convex/_generated"),
  path.join(root, "convex/_generated"),
  { recursive: true },
);
console.log("Canonical root schema validated on anonymous loopback backend.");
