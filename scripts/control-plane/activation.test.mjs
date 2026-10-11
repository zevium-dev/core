import { test } from "node:test";
import assert from "node:assert/strict";
import { validateActivation } from "./validate-activation.mjs";
const ring = (value) =>
  JSON.stringify({ current: "v1", keys: { v1: value.repeat(32) } });
function fixture() {
  const convex = {
    NEXT_DEPLOYMENT_ID: "activation-fixture",
    NEXT_SNAPSHOT_KEYS: ring("s"),
    NEXT_ADMISSION_KEYS: ring("a"),
    NEXT_TRANSPORT_KEYS: ring("t"),
    GATEWAY_INTERNAL_SECRET: "g".repeat(32),
    REGISTRY_KEY_PROJECTION_HMAC_SECRET: "p".repeat(32),
    UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({
      current: "v1",
      keys: { v1: Buffer.alloc(32, 1).toString("base64") },
    }),
    CONVEX_URL: "https://fixture.convex.cloud",
    CONVEX_SITE_URL: "https://fixture.convex.site",
    NEXT_GATEWAY_URL: "https://gateway.fixture.invalid",
    NEXT_APP_ORIGIN: "https://web.fixture.invalid",
    APP_ORIGIN: "https://web.fixture.invalid",
    CLERK_JWT_ISSUER_DOMAIN: "https://clerk.fixture.invalid",
    CLERK_SECRET_KEY: ["sk", "test", "fixture"].join("_"),
    CLERK_WEBHOOK_SIGNING_SECRET: "fixture",
    ADMIN_USER_IDS: "user_fixture",
    NEXT_STRIPE_SECRET_KEY: ["sk", "test", "fixture"].join("_"),
    NEXT_STRIPE_PLATFORM_ACCOUNT_ID: "acct_fixture",
    NEXT_STRIPE_WEBHOOK_SECRET: "fixture",
    NEXT_STRIPE_CONNECT_WEBHOOK_SECRET: "fixture",
    NEXT_STRIPE_V2_WEBHOOK_SECRET: "fixture",
    NEXT_STRIPE_PRICE_PACK_10: "price_fixture10",
    NEXT_STRIPE_PRICE_PACK_50: "price_fixture50",
    NEXT_STRIPE_PRICE_PACK_100: "price_fixture100",
  };
  return {
    convex,
    worker: { ...convex },
    web: {
      ...convex,
      VITE_CONVEX_URL: convex.CONVEX_URL,
      VITE_GATEWAY_URL: convex.NEXT_GATEWAY_URL,
      VITE_CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.fixture.invalid$").toString("base64")}`,
    },
  };
}
test("accepts matching independent test-mode destinations without provider calls", () =>
  assert.deepEqual(validateActivation(fixture()), []));
test("refuses cross-deployment, reused keys, retired authority, and live payment configuration", () => {
  for (const mutate of [
    (c) => (c.worker.NEXT_DEPLOYMENT_ID = "other"),
    (c) => (c.worker.CONVEX_SITE_URL = "https://other.convex.site"),
    (c) => (c.convex.NEXT_ADMISSION_KEYS = c.convex.NEXT_SNAPSHOT_KEYS),
    (c) => (c.convex.NEXT_STRIPE_SECRET_KEY = "live-mode-forbidden"),
    (c) => (c.worker.X402_ENABLED = "true"),
    (c) => (c.convex.NEXT_CARD_FEE_ENABLED = "true"),
    (c) => (c.convex.NEXT_ADMISSION_SECRET = "retired"),
  ]) {
    const c = fixture();
    mutate(c);
    assert.ok(validateActivation(c).length);
  }
});
test("never includes secret values in diagnostics", () => {
  const c = fixture();
  c.convex.NEXT_TRANSPORT_KEYS = "private-malformed-value";
  assert.ok(
    !validateActivation(c).join(" ").includes("private-malformed-value"),
  );
});

test("uses runtime strict keyrings including own-key membership", () => {
  for (const name of [
    "NEXT_SNAPSHOT_KEYS",
    "NEXT_ADMISSION_KEYS",
    "NEXT_TRANSPORT_KEYS",
    "UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS",
  ]) {
    for (const bad of [
      { current: "toString", keys: {} },
      { current: "constructor", keys: {} },
      { current: "__proto__", keys: {} },
      { ...JSON.parse(fixture().convex[name]), extra: true },
      { current: "missing", keys: { v1: "x".repeat(32) } },
      { current: "v1", keys: { v1: "short" } },
    ]) {
      const c = fixture();
      c.convex[name] = c.worker[name] = JSON.stringify(bad);
      assert.ok(
        validateActivation(c).includes(
          `${name} must contain a valid versioned keyring`,
        ),
      );
    }
  }
});

test("rejects mismatched Clerk instance, key mode and malformed encoded hosts", () => {
  for (const pk of [
    `pk_test_${Buffer.from("other.fixture.invalid$").toString("base64")}`,
    `pk_live_${Buffer.from("clerk.fixture.invalid$").toString("base64")}`,
    `pk_test_${Buffer.from("clerk.fixture.invalid").toString("base64")}`,
    "pk_test_invalid!",
  ]) {
    const c = fixture();
    c.web.VITE_CLERK_PUBLISHABLE_KEY = pk;
    assert.ok(
      validateActivation(c).some((e) => e.startsWith("Clerk publishable key")),
    );
  }
  const c = fixture();
  c.convex.CLERK_SECRET_KEY = c.web.CLERK_SECRET_KEY = "malformed";
  assert.ok(
    validateActivation(c).some((e) => e.startsWith("Clerk publishable key")),
  );
});

test("retains the credential encryption version and canonical base64 constraints", () => {
  for (const [id, value] of [
    ["invalid version", Buffer.alloc(32, 1).toString("base64")],
    ["v1", Buffer.alloc(32, 1).toString("base64").replace(/=+$/, "")],
    ["v1", Buffer.alloc(33, 1).toString("base64")],
  ]) {
    const c = fixture();
    c.convex.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({
      current: id,
      keys: { [id]: value },
    });
    assert.ok(
      validateActivation(c).includes(
        "UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS must contain a valid versioned keyring",
      ),
    );
  }
});
