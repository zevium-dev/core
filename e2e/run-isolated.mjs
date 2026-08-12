#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SYSTEM_ENV = [
  "CI",
  "HOME",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
];

export const ISOLATED_ENV_ALLOWLISTS = Object.freeze({
  browser: [...SYSTEM_ENV, "AGENT_BROWSER_SESSION"],
  provider: [
    ...SYSTEM_ENV,
    "E2E_BASE_URL",
    "PAYMENT_DRILL_STATE",
    "STRIPE_CHECKOUT_PROOF_KEY",
    "STRIPE_CONNECT_PLATFORM_ACCOUNT_ID",
    "STRIPE_CONNECT_PROOF_KEY",
    "STRIPE_CONNECT_SETTLEMENT_ACCOUNT_ID",
    "STRIPE_PROOF_RUN_REF",
    "STRIPE_PROVIDER_REPORT",
    "STRIPE_WEBHOOK_ADMIN_KEY",
    "STRIPE_WEBHOOK_CANARY_URL",
    "STRIPE_WEBHOOK_ENDPOINT_ID",
    "STRIPE_WEBHOOK_ENDPOINT_URL",
  ],
  ledger: [
    ...SYSTEM_ENV,
    "CONVEX_DEPLOY_KEY",
    "E2E_BASE_URL",
    "E2E_PUBLISHER_CLERK_ORG_ID",
    "GATEWAY_URL",
    "GITHUB_SHA",
    "PAYMENT_DRILL_STATE",
    "PAYMENT_PROOF_REPORT",
    "STRIPE_CONNECT_PLATFORM_ACCOUNT_ID",
    "STRIPE_CONNECT_SETTLEMENT_ACCOUNT_ID",
    "STRIPE_PROOF_RUN_REF",
    "ZEVIUM_CONVEX_DEPLOYMENT_ID",
    "ZEVIUM_DEPLOYMENT_MAX_AGE_SECONDS",
    "ZEVIUM_DEPLOYMENT_MODE",
    "ZEVIUM_GATEWAY_DEPLOYMENT_ID",
    "ZEVIUM_WEB_DEPLOYMENT_ID",
  ],
  state: [
    ...SYSTEM_ENV,
    "PAYMENT_DRILL_STATE",
    "PAYMENT_PROOF_REPORT",
    "STRIPE_PROOF_RUN_REF",
  ],
});

export function buildIsolatedEnv(mode, source = process.env) {
  const allowed = ISOLATED_ENV_ALLOWLISTS[mode];
  if (!allowed) throw new Error(`Unknown isolated environment mode: ${mode}`);
  /** @type {NodeJS.ProcessEnv} */
  const result = {};
  for (const name of allowed) {
    if (typeof source[name] === "string") result[name] = source[name];
  }
  return result;
}

async function main() {
  const [mode, separator, command, ...args] = process.argv.slice(2);
  if (separator !== "--" || !command) {
    throw new Error(
      "Usage: run-isolated.mjs <browser|provider|ledger|state> -- <command> [args...]",
    );
  }
  const child = spawn(command, args, {
    env: buildIsolatedEnv(mode),
    shell: false,
    stdio: "inherit",
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Isolated subprocess ended by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  process.exitCode = exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
