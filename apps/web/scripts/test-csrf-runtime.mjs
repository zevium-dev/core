import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testPublishableKey = `pk_test_${Buffer.from(
  "clerk.csrf-runtime.invalid$",
).toString("base64")}`;
const testSecretKey = "sk_test_csrf_runtime_not_a_secret";
const runtimeEnv = {
  ...process.env,
  NODE_ENV: "production",
  CLERK_SECRET_KEY: testSecretKey,
  VITE_BUILD_SHA: "0".repeat(40),
  VITE_CLERK_PUBLISHABLE_KEY: testPublishableKey,
  VITE_CONVEX_URL: "https://csrf-runtime.invalid.convex.cloud",
  VITE_GATEWAY_URL: "https://gateway.csrf-runtime.invalid",
};

const build = spawnSync(process.execPath, ["scripts/build.mjs"], {
  cwd: packageRoot,
  env: runtimeEnv,
  stdio: "inherit",
});
assert.equal(build.status, 0, "production Worker build failed");

const builtWrangler = JSON.parse(
  readFileSync(join(packageRoot, "dist/server/wrangler.json"), "utf8"),
);
assert.ok(
  builtWrangler.compatibility_flags?.includes("global_fetch_strictly_public"),
  "built Worker must force global fetch through the public Internet path",
);
assert.equal(builtWrangler.assets?.binding, "ASSETS");
assert.equal(
  builtWrangler.assets?.run_worker_first,
  true,
  "assets must pass through outer security boundary",
);

const assetsDir = join(packageRoot, "dist/server/assets");
const resolverFiles = readdirSync(assetsDir).filter((name) =>
  name.startsWith("__23tanstack-start-server-fn-resolver-"),
);
assert.equal(resolverFiles.length, 1, "expected one built server-fn resolver");
const resolver = readFileSync(join(assetsDir, resolverFiles[0]), "utf8");

function serverFnId(functionName) {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = resolver.match(
    new RegExp(`"([a-f0-9]{64})":\\s*\\{\\s*functionName:\\s*"${escaped}"`),
  );
  assert.ok(match, `missing built server function ${functionName}`);
  return match[1];
}

const requireAuthId = serverFnId("requireAuth_createServerFn_handler");
const fetchSpecId = serverFnId("fetchSpecFromUrl_createServerFn_handler");
const runner = spawnSync(
  process.execPath,
  [join(dirname(fileURLToPath(import.meta.url)), "csrf-runtime-runner.mjs")],
  {
    cwd: packageRoot,
    env: {
      ...runtimeEnv,
      CSRF_WORKER_URL: `${pathToFileURL(join(packageRoot, "dist/server/index.js")).href}?csrf-runtime`,
      CSRF_REQUIRE_AUTH_ID: requireAuthId,
      CSRF_FETCH_SPEC_ID: fetchSpecId,
      CSRF_TEST_SECRET_KEY: testSecretKey,
    },
    stdio: "inherit",
  },
);
assert.equal(runner.status, 0, "CSRF runtime runner failed");

const requiredSecurityHeaders = [
  "content-security-policy",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
];

function assertSecurityHeaders(
  label,
  response,
  { noStore = false, deployedHttps = true } = {},
) {
  for (const name of requiredSecurityHeaders) {
    assert.ok(response.headers.get(name), `${label} missing ${name}`);
  }
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /script-src[^;]*'nonce-[A-Za-z0-9_-]{24}'/);
  assert.ok(!csp.includes("'unsafe-eval'"), `${label} CSP permits unsafe eval`);
  assert.ok(
    !/(?:^|\s)\*(?:\s|;|$)/.test(csp),
    `${label} CSP contains broad wildcard`,
  );
  if (deployedHttps) {
    assert.equal(
      response.headers.get("strict-transport-security"),
      "max-age=31536000",
      `${label} HSTS`,
    );
    assert.ok(csp.includes("upgrade-insecure-requests"), `${label} upgrade`);
  } else {
    assert.equal(response.headers.get("strict-transport-security"), null);
    assert.ok(!csp.includes("upgrade-insecure-requests"), `${label} upgrade`);
  }
  assert.equal(response.headers.get("x-clerk-auth-reason"), null);
  assert.equal(response.headers.get("x-clerk-auth-status"), null);
  if (noStore) {
    assert.equal(
      response.headers.get("cache-control"),
      "private, no-store",
      `${label} cache policy`,
    );
  }
}

const { unstable_startWorker } = await import("wrangler");
const workerd = await unstable_startWorker({
  config: join(packageRoot, "dist/server/wrangler.json"),
  dev: { logLevel: "none" },
});
try {
  await workerd.ready;
  const clientAssets = join(packageRoot, "dist/client/assets");
  const stylesheet = readdirSync(clientAssets).find(
    (name) => name.startsWith("styles-") && name.endsWith(".css"),
  );
  assert.ok(stylesheet, "built stylesheet asset missing");

  const assetResponse = await workerd.fetch(
    `http://localhost/assets/${stylesheet}`,
  );
  assert.equal(assetResponse.status, 200);
  assertSecurityHeaders("Workerd asset", assetResponse, {
    deployedHttps: false,
  });
  assert.notEqual(
    assetResponse.headers.get("cache-control"),
    "private, no-store",
  );
  await assetResponse.body?.cancel();

  const missingAssetResponse = await workerd.fetch(
    "http://localhost/assets/security-probe-missing.js",
  );
  assert.equal(missingAssetResponse.status, 404);
  assertSecurityHeaders("Workerd missing asset", missingAssetResponse, {
    deployedHttps: false,
    noStore: true,
  });
  await missingAssetResponse.body?.cancel();
} finally {
  await workerd.dispose();
}

console.log("Built web runtime passed Workerd asset header checks");
