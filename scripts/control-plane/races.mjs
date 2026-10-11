import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const base = new URL("../../", import.meta.url);
// Match CI's clean database on every invocation; retain failed runs for diagnosis.
mkdirSync(new URL("../../.tmp/", import.meta.url), { recursive: true });
const scratch = pathToFileURL(
  mkdtempSync(fileURLToPath(new URL("../../.tmp/races-", import.meta.url))) +
    "/",
);
console.log("Disposable anonymous race deployment:", fileURLToPath(scratch));
if (!existsSync(new URL("node_modules", scratch)))
  symlinkSync(
    fileURLToPath(new URL("node_modules", base)),
    new URL("node_modules", scratch),
    "dir",
  );
cpSync(new URL("../../convex/", import.meta.url), new URL("convex/", scratch), {
  recursive: true,
});
cpSync(
  new URL("../../contracts/", import.meta.url),
  new URL("contracts/", scratch),
  { recursive: true },
);
mkdirSync(new URL("tests/", scratch), { recursive: true });
cpSync(
  new URL("../../tests/fixtures.ts", import.meta.url),
  new URL("tests/fixtures.ts", scratch),
);
// Test workers are driven explicitly; production cron jobs must not race fixture cleanup.
writeFileSync(
  new URL("convex/crons.ts", scratch),
  'import { cronJobs } from "convex/server"; export default cronJobs();\n',
);
const harness = readFileSync(
  new URL("../../tests/claimsHarness.ts", import.meta.url),
  "utf8",
)
  .replace('"../convex/_generated/server"', '"./_generated/server"')
  .replace('"./fixtures"', '"../tests/fixtures"')
  .replace('"../convex/_generated/dataModel"', '"./_generated/dataModel"');
writeFileSync(new URL("convex/testClaims.ts", scratch), harness);
const domainHarness = readFileSync(
  new URL("../../tests/domainClaimsHarness.ts", import.meta.url),
  "utf8",
)
  .replaceAll('"../convex/', '"./')
  .replace('"./fixtures"', '"../tests/fixtures"');
writeFileSync(new URL("convex/domainClaims.ts", scratch), domainHarness);
cpSync(
  new URL("../../tests/moneyFixtures.ts", import.meta.url),
  new URL("tests/moneyFixtures.ts", scratch),
);
const moneyHarness = readFileSync(
  new URL("../../tests/moneyRacesHarness.ts", import.meta.url),
  "utf8",
)
  .replaceAll('"../convex/', '"./')
  .replace('"./moneyFixtures"', '"../tests/moneyFixtures"');
writeFileSync(new URL("convex/moneyRaces.ts", scratch), moneyHarness);
for (const name of ["financeFixtures.ts", "measureDb.ts"])
  cpSync(
    new URL(`../../tests/${name}`, import.meta.url),
    new URL(`tests/${name}`, scratch),
  );
const financeHarness = readFileSync(
  new URL("../../tests/financeRacesHarness.ts", import.meta.url),
  "utf8",
)
  .replaceAll('"../convex/', '"./')
  .replace('"./financeFixtures"', '"../tests/financeFixtures"')
  .replace('"./moneyFixtures"', '"../tests/moneyFixtures"')
  .replace('"./measureDb"', '"../tests/measureDb"');
writeFileSync(new URL("convex/financeRaces.ts", scratch), financeHarness);
const readHarness = readFileSync(
  new URL("../../tests/readRacesHarness.ts", import.meta.url),
  "utf8",
)
  .replaceAll('"../convex/', '"./')
  .replaceAll("'../convex/", "'./");
writeFileSync(new URL("convex/readRaces.ts", scratch), readHarness);
const edgeHarness = readFileSync(
  new URL("../../tests/edgeHarness.ts", import.meta.url),
  "utf8",
)
  .replaceAll('"../convex/', '"./')
  .replace('"./moneyFixtures"', '"../tests/moneyFixtures"')
  .replace('"./financeFixtures"', '"../tests/financeFixtures"');
writeFileSync(new URL("convex/edgeHarness.ts", scratch), edgeHarness);
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
env.TMPDIR = fileURLToPath(new URL("../../.tmp/", import.meta.url));
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
const browserIssuer =
  process.env.CUTOVER_BROWSER === "1"
    ? process.env.CUTOVER_CLERK_ISSUER
    : undefined;
if (browserIssuer) {
  const issuer = new URL(browserIssuer);
  assert.equal(issuer.origin, browserIssuer);
  assert.equal(issuer.protocol, "https:");
}
run([
  "env",
  "set",
  "CLERK_JWT_ISSUER_DOMAIN",
  browserIssuer ?? "https://clerk.invalid",
]);
run(["env", "set", "NEXT_DEPLOYMENT_ID", "next-fixture"]);
run([
  "env",
  "set",
  "NEXT_ADMISSION_KEYS",
  JSON.stringify({
    current: "k1",
    keys: { k1: "test-only-secret-never-use-in-production" },
  }),
]);
run([
  "env",
  "set",
  "NEXT_STRIPE_SECRET_KEY",
  ["sk", "test", "fixture"].join("_"),
]);
run(["env", "set", "NEXT_STRIPE_PLATFORM_ACCOUNT_ID", "acct_fixture"]);
run(["dev", "--once", "--typecheck", "enable"]);
if (!process.env.NEXT_EDGE_ONLY) {
  run(["run", "readRaces:queryCache"]);
  run(["run", "testClaims:races"]);

  run(["run", "domainClaims:races"]);

  run(["run", "moneyRaces:races"]);

  run(["run", "financeRaces:races"]);

  // Split the measurement driver across actions; the 10,001-bucket job spans over 1,250 transactions.
  function result(args) {
    const child = spawnSync("pnpm", ["exec", "convex", "run", ...args], {
      cwd: fileURLToPath(scratch),
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    assert.equal(child.status, 0, `Convex ${args[0]} failed`);
    return JSON.parse(child.stdout);
  }
  let progress = result(["financeRaces:largeStart"]);
  for (let batch = 0; !progress.done && batch < 8; batch++) {
    progress = result(["financeRaces:largeBatch", JSON.stringify(progress)]);
    console.log("PR4 10001-bucket local reconciliation", progress);
  }
  assert.equal(progress.done, true, "Large reconciliation failed to finish");
  // Scale fixtures deliberately synthesize earnings outside ordinary usage.
  // Run the paired conservation audit on its own fresh anonymous deployment.
  const paired = spawnSync(
    "pnpm",
    ["exec", "node", "scripts/control-plane/races.mjs"],
    {
      cwd: fileURLToPath(base),
      env: { ...env, NEXT_EDGE_ONLY: "1" },
      stdio: "inherit",
    },
  );
  assert.equal(paired.status, 0, "Isolated paired acceptance failed");
  process.exit(0);
}
const edgeRing = JSON.stringify({
  current: "k1",
  keys: { k1: "test-only-secret-never-use-in-production" },
});
for (const key of [
  "NEXT_SNAPSHOT_KEYS",
  "NEXT_ADMISSION_KEYS",
  "NEXT_TRANSPORT_KEYS",
])
  run(["env", "set", key, edgeRing]);
run([
  "env",
  "set",
  "GATEWAY_INTERNAL_SECRET",
  "test-only-internal-secret-never-production",
]);
const edge = spawnSync(
  "pnpm",
  [
    "--filter",
    "@zevium/gateway",
    "exec",
    "node",
    "scripts/next-acceptance.mjs",
  ],
  {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...env, NEXT_TEST_SCRATCH: fileURLToPath(scratch) },
    stdio: "inherit",
  },
);
assert.equal(edge.status, 0, "Paired Worker/Convex acceptance failed");
