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
    CLERK_SECRET_KEY: "fixture",
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
      VITE_CLERK_PUBLISHABLE_KEY: "fixture",
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
