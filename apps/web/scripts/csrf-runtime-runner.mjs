import assert from "node:assert/strict";

const workerUrl = process.env.CSRF_WORKER_URL;
const requireAuthId = process.env.CSRF_REQUIRE_AUTH_ID;
const fetchSpecId = process.env.CSRF_FETCH_SPEC_ID;
const testSecretKey = process.env.CSRF_TEST_SECRET_KEY;
assert.ok(workerUrl, "CSRF_WORKER_URL missing");
assert.ok(requireAuthId, "CSRF_REQUIRE_AUTH_ID missing");
assert.ok(fetchSpecId, "CSRF_FETCH_SPEC_ID missing");
assert.ok(testSecretKey, "CSRF_TEST_SECRET_KEY missing");

const workerModule = await import(workerUrl);
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

console.log(
  "Built web runtime passed 9 CSRF requests plus document/redirect/auth/error headers",
);
