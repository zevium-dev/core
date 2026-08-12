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
const workerModule = await import(
  `${pathToFileURL(join(packageRoot, "dist/server/index.js")).href}?csrf-runtime`
);
const worker = workerModule.default;
assert.equal(
  typeof worker?.fetch,
  "function",
  "built Worker fetch export missing",
);

const executionContext = {
  passThroughOnException() {},
  waitUntil() {},
};

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

async function invoke(id, init = {}) {
  return await worker.fetch(
    new Request(`https://www.zevium.dev/_serverFn/${id}`, init),
    {},
    executionContext,
  );
}

async function assertForbidden(label, id, init) {
  const secret = process.env.CLERK_SECRET_KEY;
  delete process.env.CLERK_SECRET_KEY;
  try {
    const response = await invoke(id, init);
    assert.equal(response.status, 403, `${label} must be rejected`);
    assertSecurityHeaders(label, response, { noStore: true });
    assert.equal(await response.text(), "Forbidden", `${label} response body`);
  } finally {
    if (secret === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = secret;
  }
}

await assertForbidden("cross-site", requireAuthId, {
  headers: {
    "Sec-Fetch-Site": "cross-site",
    Origin: "https://www.zevium.dev",
    "x-tsr-serverFn": "true",
  },
});
await assertForbidden("same-site", requireAuthId, {
  headers: {
    "Sec-Fetch-Site": "same-site",
    Origin: "https://www.zevium.dev",
    "x-tsr-serverFn": "true",
  },
});
await assertForbidden("foreign Origin", requireAuthId, {
  headers: {
    Origin: "https://attacker.example",
    "x-tsr-serverFn": "true",
  },
});
await assertForbidden("foreign Referer prefix", requireAuthId, {
  headers: {
    Referer: "https://www.zevium.dev.attacker.example/form",
    "x-tsr-serverFn": "true",
  },
});
await assertForbidden("missing provenance", requireAuthId, {
  headers: { "x-tsr-serverFn": "true" },
});
await assertForbidden("headerless form POST", fetchSpecId, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: "url=https%3A%2F%2Fexample.com%2Fopenapi.json",
});

process.env.CLERK_SECRET_KEY = testSecretKey;
for (const [label, headers] of [
  ["same-origin Sec-Fetch-Site", { "Sec-Fetch-Site": "same-origin" }],
  ["same-origin Origin", { Origin: "https://www.zevium.dev" }],
  ["same-origin Referer", { Referer: "https://www.zevium.dev/app/projects" }],
]) {
  const response = await invoke(requireAuthId, {
    headers: { ...headers, "x-tsr-serverFn": "true" },
  });
  assert.notEqual(response.status, 403, `${label} must pass CSRF`);
  assert.notEqual(response.status, 500, `${label} must reach Clerk cleanly`);
  assertSecurityHeaders(label, response, { noStore: true });
  await response.body?.cancel();
}

async function invokePath(path, init) {
  return await worker.fetch(
    new Request(`https://www.zevium.dev${path}`, init),
    {},
    executionContext,
  );
}

const documentResponse = await invokePath("/");
assertSecurityHeaders("document", documentResponse, { noStore: true });
const documentCsp = documentResponse.headers.get("content-security-policy");
const documentNonce = documentCsp.match(/'nonce-([A-Za-z0-9_-]{24})'/)?.[1];
assert.ok(documentNonce, "document CSP nonce missing");
const documentBody = await documentResponse.text();
assert.match(documentBody, new RegExp(`nonce=["']${documentNonce}["']`));
const scriptTags = [...documentBody.matchAll(/<script\b[^>]*>/gi)].map(
  (match) => match[0],
);
assert.ok(scriptTags.length > 0, "document scripts missing");
for (const tag of scriptTags) {
  assert.match(
    tag,
    new RegExp(`nonce=["']${documentNonce}["']`),
    `document contains executable script without matching nonce: ${tag.slice(0, 120)}`,
  );
}

const redirectResponse = await invokePath("/app");
assert.ok(
  redirectResponse.status >= 300 && redirectResponse.status < 400,
  `protected route must redirect, got ${redirectResponse.status}`,
);
assertSecurityHeaders("redirect", redirectResponse, { noStore: true });
await redirectResponse.body?.cancel();

for (const [label, path] of [
  ["auth callback", "/sign-in/sso-callback"],
  ["not found", "/definitely-not-a-route"],
]) {
  const response = await invokePath(path);
  assertSecurityHeaders(label, response, { noStore: true });
  await response.body?.cancel();
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
  assert.notEqual(assetResponse.headers.get("cache-control"), "private, no-store");
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

console.log(
  "Built web runtime passed 9 CSRF requests plus document/redirect/auth/error and Workerd asset headers",
);
