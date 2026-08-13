import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { ISOLATED_ENV_ALLOWLISTS, buildIsolatedEnv } from "./run-isolated.mjs";

const execFileAsync = promisify(execFile);
const runner = new URL("./run-isolated.mjs", import.meta.url).pathname;
const hostile = {
  PATH: process.env.PATH ?? "/usr/bin",
  HOME: process.env.HOME ?? "/tmp",
  AGENT_BROWSER_SESSION: "proof-browser",
  CONVEX_DEPLOY_KEY: "prod:deployment|admin-secret",
  E2E_API_KEY: "zv_test_browser-key",
  E2E_EMAIL: "proof@example.com",
  E2E_OTP: "424242",
  E2E_PASSWORD: "browser-password",
  STRIPE_CHECKOUT_PROOF_KEY: "rk_test_checkout-secret",
  STRIPE_CONNECT_PROOF_KEY: "rk_test_connect-secret",
  STRIPE_WEBHOOK_ADMIN_KEY: "rk_test_webhook-secret",
  STRIPE_SECRET_KEY: "sk_test_runtime-secret",
};

test("browser subprocess receives no financial or admin secret", () => {
  assert.deepEqual(buildIsolatedEnv("browser", hostile), {
    HOME: hostile.HOME,
    PATH: hostile.PATH,
    AGENT_BROWSER_SESSION: "proof-browser",
  });
});

test("provider and ledger environments are mutually isolated", () => {
  const provider = buildIsolatedEnv("provider", hostile);
  const ledger = buildIsolatedEnv("ledger", hostile);
  assert.equal(
    provider.STRIPE_CHECKOUT_PROOF_KEY,
    hostile.STRIPE_CHECKOUT_PROOF_KEY,
  );
  assert.equal(
    provider.STRIPE_CONNECT_PROOF_KEY,
    hostile.STRIPE_CONNECT_PROOF_KEY,
  );
  assert.equal(provider.CONVEX_DEPLOY_KEY, undefined);
  assert.equal(provider.E2E_PASSWORD, undefined);
  assert.equal(ledger.CONVEX_DEPLOY_KEY, hostile.CONVEX_DEPLOY_KEY);
  assert.equal(ledger.STRIPE_CHECKOUT_PROOF_KEY, undefined);
  assert.equal(ledger.E2E_PASSWORD, undefined);
});

test("every subprocess drops out-of-scope credential classes", () => {
  const forbidden = {
    browser: [
      "CONVEX_DEPLOY_KEY",
      "E2E_API_KEY",
      "E2E_EMAIL",
      "E2E_OTP",
      "E2E_PASSWORD",
      "STRIPE_CHECKOUT_PROOF_KEY",
      "STRIPE_CONNECT_PROOF_KEY",
      "STRIPE_WEBHOOK_ADMIN_KEY",
      "STRIPE_SECRET_KEY",
    ],
    provider: [
      "CONVEX_DEPLOY_KEY",
      "E2E_API_KEY",
      "E2E_EMAIL",
      "E2E_OTP",
      "E2E_PASSWORD",
      "STRIPE_SECRET_KEY",
    ],
    ledger: [
      "E2E_API_KEY",
      "E2E_EMAIL",
      "E2E_OTP",
      "E2E_PASSWORD",
      "STRIPE_CHECKOUT_PROOF_KEY",
      "STRIPE_CONNECT_PROOF_KEY",
      "STRIPE_WEBHOOK_ADMIN_KEY",
      "STRIPE_SECRET_KEY",
    ],
    state: [
      "CONVEX_DEPLOY_KEY",
      "E2E_API_KEY",
      "E2E_EMAIL",
      "E2E_OTP",
      "E2E_PASSWORD",
      "STRIPE_CHECKOUT_PROOF_KEY",
      "STRIPE_CONNECT_PROOF_KEY",
      "STRIPE_WEBHOOK_ADMIN_KEY",
      "STRIPE_SECRET_KEY",
    ],
  };
  for (const [mode, names] of Object.entries(forbidden)) {
    const isolated = buildIsolatedEnv(mode, hostile);
    for (const name of names) assert.equal(isolated[name], undefined);
  }
});

test("every mode uses explicit names instead of prefixes", () => {
  for (const names of Object.values(ISOLATED_ENV_ALLOWLISTS)) {
    assert.equal(new Set(names).size, names.length);
    assert(names.every((name) => /^[A-Z][A-Z0-9_]+$/.test(name)));
  }
  assert.equal(
    buildIsolatedEnv("browser", { STRIPE_EVIL: "leak" }).STRIPE_EVIL,
    undefined,
  );
});

test("CLI launches child with filtered browser environment", async () => {
  const program =
    "process.stdout.write(JSON.stringify({convex:process.env.CONVEX_DEPLOY_KEY,stripe:process.env.STRIPE_CONNECT_PROOF_KEY,password:process.env.E2E_PASSWORD,session:process.env.AGENT_BROWSER_SESSION}))";
  const { stdout } = await execFileAsync(
    process.execPath,
    [runner, "browser", "--", process.execPath, "-e", program],
    { env: { ...process.env, ...hostile } },
  );
  assert.deepEqual(JSON.parse(stdout), { session: "proof-browser" });
});
