import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  buildSupplementalDto,
  rejectUnsafeEvidence,
  sanitizeHeaders,
  stableEvidenceHash,
} from "./sanitize-artifacts.mjs";

const execFileAsync = promisify(execFile);
const script = new URL("./sanitize-artifacts.mjs", import.meta.url).pathname;
const hashKey = "proof-hash-key-with-at-least-thirty-two-bytes";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zevium-sanitize-"));
  const source = join(root, "raw");
  const output = join(root, "safe");
  await mkdir(source);
  return { root, source, output };
}

function supplementalReport() {
  return {
    schemaVersion: 3,
    reportType: "stripe-provider-supplemental",
    acceptance: false,
    acceptanceRole: "supplemental_only",
    generatedAt: "2026-08-12T09:00:00.000Z",
    runRef: "provider-run-162",
    status: "passed",
    liveMoneyUsed: false,
    scope: "direct-stripe-primitives",
    provesZeviumLedgerCorrelation: false,
    onboardingCompleted: false,
    onboarding: {
      accountId: "acct_temporary123",
      apiSurface: "v2.core.accountLinks.create",
      hostedLinkCreated: true,
      onboardingCompleted: false,
      closed: true,
      dashboard: "express",
      appliedConfigurations: ["recipient"],
      hostedLinkOrigin: "https://connect.stripe.com",
    },
    completedAt: "2026-08-12T09:05:00.000Z",
    settlement: {
      accountId: "acct_settlement123",
      transferCapability: "active",
      payoutCapability: "active",
      fundingPaymentIntentId: "pi_funding123",
      sourceChargeId: "ch_funding123",
      grossUsdCents: 1_000,
      publisherUsdCents: 950,
      platformUsdCents: 50,
      transferId: "tr_settlement123",
      amountReversed: 950,
      payoutFundingPaymentIntentId: "pi_payoutfunding123",
      payoutFundingTransferId: "tr_payoutfunding123",
      payoutId: "po_payout123",
      payoutStatus: "paid",
    },
    compensation: {
      status: "passed",
      completedAt: "2026-08-12T09:06:00.000Z",
      onboardingAccountId: "acct_temporary123",
      onboardingClosed: true,
      settlementTransferStatus: "fully_reversed",
      payout: { status: "reversed" },
      payoutTransferStatus: "fully_reversed",
      fundingRefunds: [
        { status: "refunded", refundId: "re_funding123" },
        { status: "refunded", refundId: "re_payout123" },
      ],
    },
  };
}

function sanitizerEnv(source, output, extras = {}) {
  return {
    ...process.env,
    E2E_ARTIFACTS: source,
    E2E_EVIDENCE_HASH_KEY: hashKey,
    E2E_SANITIZED_ARTIFACTS: output,
    STRIPE_CONNECT_PROOF_KEY: "rk_test_hostile_secret",
    STRIPE_PROOF_RUN_REF: "provider-run-162",
    ...extras,
  };
}

test("writes one explicit minimal DTO and ignores every unknown artifact", async () => {
  const { source, output } = await fixture();
  const report = supplementalReport();
  await writeFile(
    join(source, "stripe-provider-proof.json"),
    JSON.stringify(report),
  );
  await writeFile(join(source, "screen.png"), "rk_test_hostile_secret");
  await writeFile(join(source, "unknown.json"), JSON.stringify(report));

  await execFileAsync(process.execPath, [script], {
    env: sanitizerEnv(source, output),
  });

  assert.deepEqual(await readdir(output), [
    "stripe-provider-supplemental.json",
  ]);
  const outputPath = join(output, "stripe-provider-supplemental.json");
  const safeText = await readFile(outputPath, "utf8");
  const safe = JSON.parse(safeText);
  assert.equal(safe.acceptance, false);
  assert.equal(safe.acceptanceRole, "supplemental_only");
  assert.equal(safe.onboarding.apiSurface, "v2.core.accountLinks.create");
  assert.match(safe.onboarding.accountHash, /^h1_[0-9a-f]{64}$/);
  assert.doesNotMatch(safeText, /acct_|tr_|pi_|ch_|re_|rk_test_/);
  assert.equal((await lstat(outputPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(output)).mode & 0o777, 0o700);
});

test("stable evidence hashes are keyed, labeled, and deterministic", () => {
  const first = stableEvidenceHash("stripe-account", "acct_example", hashKey);
  assert.equal(
    first,
    stableEvidenceHash("stripe-account", "acct_example", hashKey),
  );
  assert.notEqual(
    first,
    stableEvidenceHash("stripe-transfer", "acct_example", hashKey),
  );
  assert.notEqual(
    first,
    stableEvidenceHash("stripe-account", "acct_other", hashKey),
  );
});

test("supplemental DTO rejects false-pass and unknown report fields", () => {
  const cases = [
    (report) => {
      report.acceptance = true;
    },
    (report) => {
      report.scope = "zevium-app-path";
    },
    (report) => {
      report.onboarding.apiSurface = "v1.accountLinks.create";
    },
    (report) => {
      report.settlement.publisherUsdCents = 949;
    },
    (report) => {
      report.compensation.payoutTransferStatus = "pending";
    },
    (report) => {
      report.cookie = "session=unsafe";
    },
  ];
  for (const mutate of cases) {
    const report = supplementalReport();
    mutate(report);
    assert.throws(() => buildSupplementalDto(report, hashKey));
  }
});

test("header evidence uses exact allowlist", () => {
  assert.deepEqual(
    sanitizeHeaders(
      {
        "content-type": "application/json; charset=utf-8",
        "x-zevium-cost": "3",
        "x-zevium-request-id": "request-123",
      },
      hashKey,
    ),
    {
      "content-type": "application/json; charset=utf-8",
      "x-zevium-cost": 3,
      "x-zevium-request-id": stableEvidenceHash(
        "gateway-request",
        "request-123",
        hashKey,
      ),
    },
  );
  for (const header of [
    "authorization",
    "cookie",
    "set-cookie",
    "stripe-signature",
    "x-publisher-token",
  ]) {
    assert.throws(() => sanitizeHeaders({ [header]: "unsafe" }, hashKey));
  }
});

test("rejects exact secrets in raw and encoded forms", () => {
  const secret = "password+/=unsafe-value";
  const variants = [
    secret,
    encodeURIComponent(secret),
    encodeURIComponent(encodeURIComponent(secret)),
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("base64url"),
    Buffer.from(secret).toString("hex"),
  ];
  for (const value of variants) {
    assert.throws(() => rejectUnsafeEvidence(value, [secret]));
  }
});

test("rejects encoded credentials, cookies, client secrets, and raw ids", () => {
  const unsafeValues = [
    "Authorization: Bearer unsafe-token",
    "Authorization: Basic dXNlcjpwYXNz",
    "Set-Cookie: __session=unsafe",
    "Cookie: __session=unsafe",
    "client_secret=unsafe",
    "x-publisher-token: unsafe",
    encodeURIComponent("client_secret=unsafe"),
    encodeURIComponent(encodeURIComponent("Set-Cookie: session=unsafe")),
    Buffer.from("client_secret=unsafe").toString("base64"),
    Buffer.from("Cookie: session=unsafe").toString("base64url"),
    Buffer.from("client_secret=unsafe").toString("hex"),
    Buffer.from("Set-Cookie: session=unsafe").toString("hex").toUpperCase(),
    "rk_" + "test_restrictedvalue",
    "whsec_webhookvalue",
    "zv_test_apikeyvalue",
    "eyJheader.eyJpayload.signature",
    "https://checkout.stripe.com/c/pay/cs_test_unsafe",
    "acct_rawproviderid",
    "tr_rawproviderid",
    "evt_rawproviderid",
    "org_rawclerkid",
  ];
  for (const value of unsafeValues) {
    assert.throws(() => rejectUnsafeEvidence(value, []), value);
  }
});

test("rejects allowlisted-input symlinks and publishes no tree", async () => {
  const { root, source, output } = await fixture();
  const outside = join(root, "outside.json");
  await writeFile(outside, JSON.stringify(supplementalReport()));
  await symlink(outside, join(source, "stripe-provider-proof.json"));

  await assert.rejects(
    execFileAsync(process.execPath, [script], {
      env: sanitizerEnv(source, output),
    }),
    /real file/,
  );
  await assert.rejects(lstat(output));
});

test("rejects allowlisted special files", async (context) => {
  if (process.platform === "win32") {
    context.skip("mkfifo unavailable on Windows");
    return;
  }
  const { source, output } = await fixture();
  const fifo = join(source, "stripe-provider-proof.json");
  await execFileAsync("mkfifo", [fifo]);
  await chmod(fifo, 0o600);
  await assert.rejects(
    execFileAsync(process.execPath, [script], {
      env: sanitizerEnv(source, output),
    }),
    /real file/,
  );
  await assert.rejects(lstat(output));
});

test("rejects non-sibling output roots before replacement", async () => {
  const { root, source } = await fixture();
  const output = join(root, "nested", "safe");
  await writeFile(
    join(source, "stripe-provider-proof.json"),
    JSON.stringify(supplementalReport()),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [script], {
      env: sanitizerEnv(source, output),
    }),
    /sibling directories/,
  );
  await assert.rejects(lstat(output));
});
