#!/usr/bin/env node

import { createHmac } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import {
  assertAcceptanceReport,
  invariant,
  normalizeRunRef,
} from "./stripe-provider-proof-lib.mjs";

const sourceRoot = resolve(
  process.env.E2E_ARTIFACTS ?? new URL("./artifacts", import.meta.url).pathname,
);
const outputRoot = resolve(
  process.env.E2E_SANITIZED_ARTIFACTS ??
    new URL("./artifacts-sanitized", import.meta.url).pathname,
);
const stagingRoot = `${outputRoot}.tmp-${process.pid}`;
const INPUT_ALLOWLIST = Object.freeze({
  "payment-proof-report.json": {
    output: "payment-proof-report.json",
    map: buildAcceptanceDto,
  },
  "stripe-provider-proof.json": {
    output: "stripe-provider-supplemental.json",
    map: buildSupplementalDto,
  },
});
const HEADER_ALLOWLIST = new Set([
  "content-type",
  "x-zevium-cost",
  "x-zevium-request-id",
]);
const exactSecrets = [
  process.env.CONVEX_DEPLOY_KEY,
  process.env.E2E_API_KEY,
  process.env.E2E_EMAIL,
  process.env.E2E_EVIDENCE_HASH_KEY,
  process.env.E2E_OTP,
  process.env.E2E_PASSWORD,
  process.env.STRIPE_CHECKOUT_PROOF_KEY,
  process.env.STRIPE_CONNECT_PROOF_KEY,
  process.env.STRIPE_WEBHOOK_ADMIN_KEY,
].filter((value) => typeof value === "string" && value.length >= 4);

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function exactKeys(value, keys, label) {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    invariant(allowed.has(key), `${label}.${key} is not allowlisted`);
  }
}

function evidenceHashKey() {
  const key = process.env.E2E_EVIDENCE_HASH_KEY;
  invariant(
    typeof key === "string" && key.length >= 32,
    "E2E_EVIDENCE_HASH_KEY must contain at least 32 bytes",
  );
  return key;
}

export function stableEvidenceHash(label, value, key = evidenceHashKey()) {
  invariant(
    typeof value === "string" && value.length > 0,
    `${label} evidence id is missing`,
  );
  return `h1_${createHmac("sha256", key)
    .update(label)
    .update("\0")
    .update(value)
    .digest("hex")}`;
}

export function sanitizeHeaders(headers, key = evidenceHashKey()) {
  const result = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    invariant(
      HEADER_ALLOWLIST.has(name),
      `Header ${rawName} is not allowlisted`,
    );
    invariant(typeof rawValue === "string", `Header ${rawName} is invalid`);
    if (name === "content-type") {
      invariant(
        /^application\/json(?:;\s*charset=utf-8)?$/i.test(rawValue),
        "Content-Type evidence changed",
      );
      result[name] = rawValue.toLowerCase();
    } else if (name === "x-zevium-cost") {
      invariant(/^[1-9][0-9]*$/.test(rawValue), "Cost header is invalid");
      result[name] = Number(rawValue);
    } else {
      result[name] = stableEvidenceHash("gateway-request", rawValue, key);
    }
  }
  return result;
}

function deploymentExpectation() {
  const maxAgeSeconds = Number(
    process.env.ZEVIUM_DEPLOYMENT_MAX_AGE_SECONDS ?? "86400",
  );
  return {
    githubSha: process.env.GITHUB_SHA,
    mode: process.env.ZEVIUM_DEPLOYMENT_MODE,
    deploymentIds: {
      web: process.env.ZEVIUM_WEB_DEPLOYMENT_ID,
      gateway: process.env.ZEVIUM_GATEWAY_DEPLOYMENT_ID,
      convex: process.env.ZEVIUM_CONVEX_DEPLOYMENT_ID,
    },
    maxAgeMs: maxAgeSeconds * 1_000,
    verificationMaxAgeMs: 60 * 60 * 1_000,
  };
}

function acceptanceExpectation() {
  return {
    runRef: normalizeRunRef(process.env.STRIPE_PROOF_RUN_REF),
    githubSha: process.env.GITHUB_SHA,
    deployment: deploymentExpectation(),
    appPath: {
      clerkOrgId: process.env.E2E_PUBLISHER_CLERK_ORG_ID,
      connectedAccountId: process.env.STRIPE_CONNECT_SETTLEMENT_ACCOUNT_ID,
      platformAccountId: process.env.STRIPE_CONNECT_PLATFORM_ACCOUNT_ID,
    },
  };
}

export function buildAcceptanceDto(report, key = evidenceHashKey()) {
  exactKeys(
    report,
    [
      "schemaVersion",
      "reportType",
      "acceptance",
      "status",
      "run",
      "deployment",
      "appPath",
      "ledger",
      "provider",
      "compensation",
      "primitives",
    ],
    "report",
  );
  assertAcceptanceReport(report, acceptanceExpectation());
  const local = report.appPath.transfer.local;
  const provider = report.appPath.transfer.provider;
  const refund = report.ledger.refund;
  return {
    schemaVersion: 3,
    reportType: report.reportType,
    acceptance: true,
    status: "passed",
    run: {
      runRefHash: stableEvidenceHash("run-ref", report.run.runRef, key),
      githubSha: report.run.githubSha,
      mode: report.run.mode,
      startedAt: report.run.startedAt,
      completedAt: report.run.completedAt,
    },
    deployment: {
      verifiedAt: report.deployment.verifiedAt,
      manifests: report.deployment.manifests.map((manifest) => ({
        service: manifest.service,
        mode: manifest.mode,
        gitSha: manifest.gitSha,
        deploymentIdHash: stableEvidenceHash(
          `${manifest.service}-deployment`,
          manifest.deploymentId,
          key,
        ),
        deployedAt: manifest.deployedAt,
      })),
    },
    appPath: {
      authenticated: true,
      activeOrganizationHash: stableEvidenceHash(
        "clerk-organization",
        report.appPath.baseline.organization.clerkOrgId,
        key,
      ),
      profileHash: stableEvidenceHash(
        "convex-payment-profile",
        report.appPath.baseline.profile.id,
        key,
      ),
      onboarding: {
        action: report.appPath.onboarding.action,
        apiSurface: report.appPath.onboarding.apiSurface,
        connectedAccountHash: stableEvidenceHash(
          "stripe-account",
          report.appPath.onboarding.connectedAccountId,
          key,
        ),
        linkOrigin: report.appPath.onboarding.linkOrigin,
        linkHash: stableEvidenceHash(
          "stripe-account-link",
          report.appPath.onboarding.linkHash,
          key,
        ),
        observedAt: report.appPath.onboarding.observedAt,
      },
      transfer: {
        action: report.appPath.transfer.ui.action,
        localTransferHash: stableEvidenceHash(
          "convex-publisher-transfer",
          local.id,
          key,
        ),
        providerTransferHash: stableEvidenceHash(
          "stripe-transfer",
          provider.id,
          key,
        ),
        connectedAccountHash: stableEvidenceHash(
          "stripe-account",
          local.stripeConnectedAccountId,
          key,
        ),
        platformAccountHash: stableEvidenceHash(
          "stripe-account",
          local.platformAccountId,
          key,
        ),
        correlationNonceHash: stableEvidenceHash(
          "transfer-nonce",
          local.correlationNonce,
          key,
        ),
        correlationHmacHash: stableEvidenceHash(
          "transfer-hmac",
          local.correlationHmac,
          key,
        ),
        amount: local.amount,
        currency: local.currency,
        localStatus: local.status,
        providerMetadataExact: true,
        settlementJournalEntries:
          report.appPath.transfer.settlementEntries.length,
        webhook: {
          eventHash: stableEvidenceHash(
            "stripe-event",
            report.appPath.transfer.webhook.stripeEventId,
            key,
          ),
          eventType: report.appPath.transfer.webhook.eventType,
          status: report.appPath.transfer.webhook.status,
          deliveries: report.appPath.transfer.webhook.deliveries,
        },
        observedAt: report.appPath.transfer.ui.observedAt,
      },
    },
    ledger: {
      usage: {
        organizationHash: stableEvidenceHash(
          "convex-organization",
          report.ledger.usage.payment.organizationId,
          key,
        ),
        projectHash: stableEvidenceHash(
          "project-slug",
          report.ledger.usage.projectSlug,
          key,
        ),
        calls: report.ledger.usage.calls.map((call) => ({
          requestHash: stableEvidenceHash(
            "gateway-request",
            call.usage.settleRefId,
            key,
          ),
          cost: call.usage.credits,
          status: call.usage.status,
          method: call.usage.method,
          endpoint: call.usage.endpoint,
        })),
      },
      refund: {
        paymentHash: stableEvidenceHash(
          "convex-payment",
          refund.payment.id,
          key,
        ),
        eventHash: stableEvidenceHash(
          "stripe-event",
          refund.event.stripeEventId,
          key,
        ),
        checkoutSessionHash: stableEvidenceHash(
          "stripe-checkout-session",
          refund.payment.checkoutSessionId,
          key,
        ),
        chargeHash: stableEvidenceHash(
          "stripe-charge",
          refund.payment.stripeChargeId,
          key,
        ),
        providerRefundHashes: report.provider.refundIds
          .map((refundId) => stableEvidenceHash("stripe-refund", refundId, key))
          .sort(),
        exposureSourceHashes: refund.exposures
          .map((exposure) =>
            stableEvidenceHash(
              "stripe-refund",
              exposure.sourceRef.slice("stripe:refund:".length),
              key,
            ),
          )
          .sort(),
        status: refund.payment.status,
        refundedCredits: refund.payment.refundedCredits,
        reversedCredits: refund.payment.reversedCredits,
        walletReversedCredits: refund.payment.walletReversedCredits,
        publisherClawbackCredits: refund.payment.publisherClawbackTargetCredits,
        reconciliationStatus: refund.reconciliation.status,
        reconciliationRevision: refund.reconciliation.revision,
        processedChunks: refund.reconciliation.processedChunks,
        exposureCount: refund.exposures.length,
        clawbackCount: refund.clawbacks.length,
        earningCount: refund.earnings.length,
        publisherCount: refund.publishers.length,
        exposureConserved: true,
        clawbackConserved: true,
        earningAtomsConserved: true,
        journalAtomsConserved: true,
        publisherBalancesConserved: true,
        walletConserved: true,
        webhookReplay: {
          eventHash: stableEvidenceHash(
            "stripe-event",
            report.provider.webhookCanary.eventId,
            key,
          ),
          canonicalEndpointHash: stableEvidenceHash(
            "stripe-webhook-endpoint",
            report.provider.webhookCanary.canonicalEndpointId,
            key,
          ),
          canaryEndpointHash: stableEvidenceHash(
            "stripe-webhook-endpoint",
            report.provider.webhookCanary.canaryEndpointId,
            key,
          ),
          exactPendingDeliveries:
            report.provider.webhookCanary.exactPendingDeliveries,
          canonicalDeliveriesBeforeReplay:
            report.provider.webhookCanary.canonicalReceiptDeliveries,
          canonicalDeliveriesAfterReplay:
            report.ledger.refundBaseline.event.deliveries,
          exclusiveV1SubscriberCount:
            report.provider.webhookCanary.exclusiveV1SubscriberIds.length,
          competingV2SubscriberCount:
            report.provider.webhookCanary.competingV2SubscriberCount,
          canaryDeletedAt: report.provider.webhookCanary.canaryDeletedAt,
          canonicalReplayRequestedAt:
            report.provider.webhookCanary.canonicalReplayRequestedAt,
        },
      },
    },
    compensation: {
      status: report.compensation.status,
      providerTransferHash: stableEvidenceHash(
        "stripe-transfer",
        report.compensation.provider.id,
        key,
      ),
      localTransferHash: stableEvidenceHash(
        "convex-publisher-transfer",
        report.compensation.local.id,
        key,
      ),
      providerReversed: report.compensation.provider.reversed,
      localStatus: report.compensation.local.status,
      amountReversed: report.compensation.provider.amountReversed,
      reversalWebhookHash: stableEvidenceHash(
        "stripe-event",
        report.compensation.webhook.stripeEventId,
        key,
      ),
      publisherBalanceRestored: true,
      paymentStatus: report.compensation.payment.status,
      reconciliationStatus: report.compensation.payment.reconciliationStatus,
      canaryDeleted: report.compensation.canary.deleted,
      canonicalWebhookUnchanged: report.compensation.canary.canonicalUnchanged,
      completedAt: report.compensation.completedAt,
    },
    primitives: {
      acceptanceRole: "supplemental_only",
      requiredForAcceptance: false,
    },
  };
}

export function buildSupplementalDto(report, key = evidenceHashKey()) {
  exactKeys(
    report,
    [
      "schemaVersion",
      "reportType",
      "acceptance",
      "acceptanceRole",
      "generatedAt",
      "runRef",
      "status",
      "liveMoneyUsed",
      "scope",
      "provesZeviumLedgerCorrelation",
      "onboardingCompleted",
      "onboarding",
      "completedAt",
      "settlement",
      "compensation",
    ],
    "supplementalReport",
  );
  invariant(
    report.schemaVersion === 3 &&
      report.reportType === "stripe-provider-supplemental" &&
      report.acceptance === false &&
      report.acceptanceRole === "supplemental_only" &&
      report.scope === "direct-stripe-primitives" &&
      report.provesZeviumLedgerCorrelation === false &&
      report.status === "passed" &&
      report.onboardingCompleted === false &&
      report.onboarding?.apiSurface === "v2.core.accountLinks.create" &&
      report.onboarding.hostedLinkCreated === true &&
      report.onboarding.onboardingCompleted === false &&
      report.onboarding.closed === true &&
      report.settlement?.grossUsdCents === 1_000 &&
      report.settlement.publisherUsdCents === 950 &&
      report.settlement.platformUsdCents === 50 &&
      report.settlement.amountReversed === 950 &&
      report.settlement.payoutStatus === "paid" &&
      report.compensation?.status === "passed" &&
      report.compensation.onboardingClosed === true &&
      report.compensation.settlementTransferStatus === "fully_reversed" &&
      report.compensation.payoutTransferStatus === "fully_reversed" &&
      Array.isArray(report.compensation.fundingRefunds) &&
      report.compensation.fundingRefunds.length === 2 &&
      report.compensation.fundingRefunds.every(
        (refund) => refund.status === "refunded",
      ),
    "Direct provider report is not completed supplemental evidence",
  );
  return {
    schemaVersion: 3,
    reportType: report.reportType,
    acceptance: false,
    acceptanceRole: "supplemental_only",
    scope: report.scope,
    status: report.status,
    runRefHash: stableEvidenceHash("run-ref", report.runRef, key),
    generatedAt: report.generatedAt,
    completedAt: report.completedAt,
    onboarding: {
      apiSurface: report.onboarding.apiSurface,
      accountHash: stableEvidenceHash(
        "stripe-account",
        report.onboarding.accountId,
        key,
      ),
      hostedLinkCreated: report.onboarding.hostedLinkCreated,
      closed: report.onboarding.closed,
    },
    settlement: {
      accountHash: stableEvidenceHash(
        "stripe-account",
        report.settlement.accountId,
        key,
      ),
      transferHash: stableEvidenceHash(
        "stripe-transfer",
        report.settlement.transferId,
        key,
      ),
      grossUsdCents: report.settlement.grossUsdCents,
      publisherUsdCents: report.settlement.publisherUsdCents,
      platformUsdCents: report.settlement.platformUsdCents,
      amountReversed: report.settlement.amountReversed,
      payoutStatus: report.settlement.payoutStatus,
    },
    compensation: {
      status: report.compensation.status,
      onboardingClosed: report.compensation.onboardingClosed,
      settlementTransferStatus: report.compensation.settlementTransferStatus,
      payoutTransferStatus: report.compensation.payoutTransferStatus,
      fundingRefundStatuses: report.compensation.fundingRefunds.map(
        (refund) => refund.status,
      ),
    },
  };
}

function secretVariants(secret) {
  const values = new Set([
    secret,
    encodeURIComponent(secret),
    encodeURIComponent(encodeURIComponent(secret)),
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("base64url"),
    Buffer.from(secret).toString("hex"),
  ]);
  return [...values].filter((value) => value.length >= 4);
}

function decodedViews(source) {
  const views = new Set([source]);
  let frontier = [source];
  for (let depth = 0; depth < 3 && frontier.length > 0; depth += 1) {
    const next = [];
    for (const view of frontier) {
      try {
        const decoded = decodeURIComponent(view);
        if (!views.has(decoded)) {
          views.add(decoded);
          next.push(decoded);
        }
      } catch {
        // Invalid percent encoding stays covered by original scan.
      }
      for (const token of view.match(/[A-Za-z0-9+/_=-]{12,}/g) ?? []) {
        try {
          const decoded = Buffer.from(token, "base64").toString("utf8");
          if (
            /^[\x09\x0a\x0d\x20-\x7e]+$/.test(decoded) &&
            !views.has(decoded)
          ) {
            views.add(decoded);
            next.push(decoded);
          }
        } catch {
          // Non-base64 token stays covered by original scan.
        }
      }
      for (const token of view.match(/(?:[0-9a-fA-F]{2}){8,}/g) ?? []) {
        try {
          const decoded = Buffer.from(token, "hex").toString("utf8");
          if (
            /^[\x09\x0a\x0d\x20-\x7e]+$/.test(decoded) &&
            !views.has(decoded)
          ) {
            views.add(decoded);
            next.push(decoded);
          }
        } catch {
          // Non-hex token stays covered by original scan.
        }
      }
    }
    frontier = next;
  }
  return views;
}

export function rejectUnsafeEvidence(source, secrets = exactSecrets) {
  for (const secret of secrets) {
    for (const variant of secretVariants(secret)) {
      invariant(
        !source.includes(variant),
        "Sanitized evidence contains exact secret material",
      );
    }
  }
  const unsafe = [
    /(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+/i,
    /whsec_[A-Za-z0-9_]+/i,
    /zv_(?:test|live)_[A-Za-z0-9_-]+/i,
    /\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:basic|bearer)\b/i,
    /\b(?:set[-_% ]?cookie|cookie|client[-_% ]?secret|x[-_% ]?publisher[-_% ]?token)\s*[:=]/i,
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
    /https:\/\/checkout\.stripe\.com\//i,
    /\b(?:org|user|sess|acct|tr|evt|cs_test|pi|ch|re|we|po|price)_[A-Za-z0-9_]+\b/,
  ];
  for (const view of decodedViews(source)) {
    for (const pattern of unsafe) {
      invariant(
        !pattern.test(view),
        `Sanitized evidence matched forbidden credential pattern ${pattern}`,
      );
    }
  }
}

async function readAllowedInput(name) {
  const path = resolve(sourceRoot, name);
  invariant(
    isWithin(sourceRoot, path),
    "Evidence input escaped source directory",
  );
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  invariant(
    metadata.isFile() && !metadata.isSymbolicLink(),
    `${name} must be a real file`,
  );
  invariant(metadata.size <= 2_000_000, `${name} exceeds 2 MB limit`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  invariant(sourceRoot !== outputRoot, "Raw and sanitized roots must differ");
  invariant(
    dirname(sourceRoot) === dirname(outputRoot),
    "Raw and sanitized roots must be sibling directories",
  );
  invariant(
    !isWithin(sourceRoot, outputRoot) && !isWithin(outputRoot, sourceRoot),
    "Raw and sanitized roots cannot contain each other",
  );
  const sourceMetadata = await lstat(sourceRoot);
  invariant(
    sourceMetadata.isDirectory() && !sourceMetadata.isSymbolicLink(),
    "Artifact source must be a real directory",
  );
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  let written = 0;
  try {
    for (const [input, config] of Object.entries(INPUT_ALLOWLIST)) {
      const raw = await readAllowedInput(input);
      if (raw === null) continue;
      const dto = config.map(raw);
      const serialized = `${JSON.stringify(dto, null, 2)}\n`;
      rejectUnsafeEvidence(serialized);
      const destination = resolve(stagingRoot, config.output);
      invariant(
        isWithin(stagingRoot, destination),
        "Evidence output escaped staging directory",
      );
      await writeFile(destination, serialized, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(destination, 0o600);
      written += 1;
    }
    invariant(written > 0, "No allowlisted proof report was found");
    await rm(outputRoot, { recursive: true, force: true });
    await rename(stagingRoot, outputRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(`minimal evidence DTOs written to ${outputRoot}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
) {
  await main();
}
