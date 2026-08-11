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
  await response.body?.cancel();
}

console.log("CSRF built-runtime matrix passed (9 adversarial requests)");
