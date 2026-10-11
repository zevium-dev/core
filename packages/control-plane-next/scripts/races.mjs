import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  symlinkSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

const base = new URL("../", import.meta.url);
const scratch = new URL("../.tmp/races/", import.meta.url);
mkdirSync(scratch, { recursive: true });
if (!existsSync(new URL("node_modules", scratch)))
  symlinkSync(
    fileURLToPath(new URL("node_modules", base)),
    new URL("node_modules", scratch),
    "dir",
  );
cpSync(new URL("../convex/", import.meta.url), new URL("convex/", scratch), {
  recursive: true,
});
cpSync(
  new URL("../contracts/", import.meta.url),
  new URL("contracts/", scratch),
  { recursive: true },
);
mkdirSync(new URL("tests/", scratch), { recursive: true });
cpSync(
  new URL("../tests/fixtures.ts", import.meta.url),
  new URL("tests/fixtures.ts", scratch),
);
const harness = readFileSync(
  new URL("../tests/claimsHarness.ts", import.meta.url),
  "utf8",
)
  .replace('"../convex/_generated/server"', '"./_generated/server"')
  .replace('"./fixtures"', '"../tests/fixtures"')
  .replace('"../convex/_generated/dataModel"', '"./_generated/dataModel"');
writeFileSync(new URL("convex/testClaims.ts", scratch), harness);
const domainHarness = readFileSync(
  new URL("../tests/domainClaimsHarness.ts", import.meta.url),
  "utf8",
)
  .replaceAll('"../convex/', '"./')
  .replace('"./fixtures"', '"../tests/fixtures"');
writeFileSync(new URL("convex/domainClaims.ts", scratch), domainHarness);
for (const name of ["convex.json", "tsconfig.json", "package.json"]) {
  cpSync(new URL(name, base), new URL(name, scratch));
}
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !name.startsWith("CONVEX_") && !name.startsWith("VITE_CONVEX_"),
  ),
);
env.CONVEX_AGENT_MODE = "anonymous";
env.CLERK_JWT_ISSUER_DOMAIN = "https://clerk.invalid";
env.TMPDIR = fileURLToPath(new URL("../.tmp/", import.meta.url));
// Scratch is always owned by this package. Still reject inherited cloud config.
const configFile = new URL(".env.local", scratch);
function assertLocal() {
  try {
    const config = readFileSync(configFile, "utf8");
    assert.doesNotMatch(
      config,
      /^CONVEX_(DEPLOY_KEY|SELF_HOSTED_URL|SELF_HOSTED_ADMIN_KEY)=/m,
    );
    assert.match(config, /^CONVEX_DEPLOYMENT=anonymous:/m);
    assert.match(config, /^CONVEX_URL=http:\/\/127\.0\.0\.1:\d+\s*$/m);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function run(args) {
  const result = spawnSync("pnpm", ["exec", "convex", ...args], {
    cwd: fileURLToPath(scratch),
    env,
    stdio: "inherit",
  });
  assert.equal(result.status, 0, `Convex ${args[0]} failed`);
}
assertLocal();
run(["init"]);
assertLocal();
run(["env", "set", "CLERK_JWT_ISSUER_DOMAIN", "https://clerk.invalid"]);
run(["dev", "--once", "--typecheck", "enable", "--run", "testClaims:races"]);

run(["run", "domainClaims:races"]);
