import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAcceptanceDto,
  stableEvidenceHash,
} from "./sanitize-artifacts.mjs";
import {
  assertAcceptanceReport,
  assertExclusiveEndpointTopology,
  assertLedgerEvidence,
  assertNoCompetingEventDestinations,
  assertPendingCanaryEvent,
  assertUsageEvidence,
  endpointAccepts,
  normalizeRunRef,
  requireTestStripeKey,
} from "./stripe-provider-proof-lib.mjs";

const RUN_REF = "proof-run-162";
const GITHUB_SHA = "a".repeat(40);
const CLERK_ORG_ID = "org_publisher123";
const ORGANIZATION_ID = "organization_doc_123";
const PROFILE_ID = "payment_profile_doc_123";
const CONNECTED_ACCOUNT_ID = "acct_settlement123";
const PLATFORM_ACCOUNT_ID = "acct_platform123";
const PAYMENT_ID = "payment_doc_123";
const CHECKOUT_SESSION_ID = "cs_test_checkout123";
const CHARGE_ID = "ch_checkout123";
const PARTIAL_REFUND_EVENT_ID = "evt_partialrefund123";
const REFUND_EVENT_ID = "evt_refund123";
const TRANSFER_ID = "publisher_transfer_doc_123";
const STRIPE_TRANSFER_ID = "tr_app123";
const PUBLISHER_ORGANIZATION_ID = "publisher_org_doc_123";
const PROJECT_ID = "project_doc_123";
const EARNING_ID = "publisher_earning_doc_123";
const CORRELATION_NONCE = "b".repeat(64);
const CORRELATION_HMAC = "c".repeat(64);
const TIMESTAMPS = Object.freeze({
  started: "2026-08-12T09:55:00.000Z",
  deployed: "2026-08-12T09:50:00.000Z",
  deploymentVerified: "2026-08-12T09:56:00.000Z",
  checkoutVerified: "2026-08-12T09:57:00.000Z",
  onboardingObserved: "2026-08-12T09:58:00.000Z",
  onboardingVerified: "2026-08-12T09:59:00.000Z",
  transferObserved: "2026-08-12T10:00:00.000Z",
  transferVerified: "2026-08-12T10:01:00.000Z",
  usageCaptured: "2026-08-12T10:02:00.000Z",
  partialInitialCaptured: "2026-08-12T10:02:15.000Z",
  canaryDeleted: "2026-08-12T10:02:20.000Z",
  canonicalReplayRequested: "2026-08-12T10:02:21.000Z",
  partialRefundCaptured: "2026-08-12T10:02:30.000Z",
  refundCaptured: "2026-08-12T10:03:00.000Z",
  canaryCleanupVerified: "2026-08-12T10:03:30.000Z",
  compensationCompleted: "2026-08-12T10:04:00.000Z",
  completed: "2026-08-12T10:05:00.000Z",
});

function expectedCalls() {
  return [
    {
      requestId: "ui_request_123",
      cost: 1,
      status: 200,
      method: "GET",
      endpoint: "/get",
    },
    {
      requestId: "direct_request_123",
      cost: 1,
      status: 200,
      method: "GET",
      endpoint: "/get",
    },
    {
      requestId: "browser_request_123",
      cost: 1,
      status: 200,
      method: "GET",
      endpoint: "/get",
    },
  ];
}

function usageEvidence() {
  const calls = expectedCalls();
  return {
    capturedAt: TIMESTAMPS.usageCaptured,
    payment: {
      organizationId: ORGANIZATION_ID,
      status: "paid",
      refundedCredits: 0,
      reversedCredits: 0,
      walletReversedCredits: 0,
      publisherClawbackTargetCredits: 0,
    },
    projectSlug: "weather",
    wallet: { balance: 99_997, sequence: 5 },
    calls: calls.map((call, index) => ({
      entry: {
        refId: `settle:${call.requestId}`,
        kind: "usage_settlement",
        amount: -call.cost,
        sequence: index + 3,
      },
      usage: {
        settleRefId: `settle:${call.requestId}`,
        credits: call.cost,
        status: call.status,
        method: call.method,
        endpoint: call.endpoint,
        organizationId: ORGANIZATION_ID,
      },
      project: {
        id: PROJECT_ID,
        slug: "weather",
        publisherOrganizationId: ORGANIZATION_ID,
      },
      index,
    })),
    interveningEntries: calls.map((call, index) => ({
      refId: `settle:${call.requestId}`,
      kind: "usage_settlement",
      amount: -call.cost,
      sequence: index + 3,
    })),
  };
}

function refundEvidence({
  refundedCredits = 25_000,
  walletReversedCredits = 24_998,
  publisherCredits = 2,
  walletBalance = 75_000,
  status = "partially_refunded",
  capturedAt = TIMESTAMPS.refundCaptured,
  eventId = REFUND_EVENT_ID,
  refundId = "re_refund123",
} = {}) {
  const sourceRef = `stripe:refund:${refundId}`;
  const publisherAtoms = publisherCredits * 9_500;
  return {
    capturedAt,
    payment: {
      id: PAYMENT_ID,
      organizationId: ORGANIZATION_ID,
      checkoutSessionId: CHECKOUT_SESSION_ID,
      stripeChargeId: CHARGE_ID,
      status,
      amount: 1_000,
      currency: "usd",
      grantedCredits: 100_000,
      refundedAmount: refundedCredits / 100,
      refundedCredits,
      reversedCredits: refundedCredits,
      walletReversedCredits,
      publisherClawbackTargetCredits: publisherCredits,
    },
    wallet: { balance: walletBalance, sequence: 6 },
    event: {
      stripeEventId: eventId,
      eventType: "charge.refunded",
      objectId: CHARGE_ID,
      status: "processed",
      deliveries: 2,
      attempts: 1,
    },
    reversalJournalCredits: walletReversedCredits,
    disputeCount: 0,
    reconciliation: {
      paymentId: PAYMENT_ID,
      consumerOrganizationId: ORGANIZATION_ID,
      status: "complete",
      revision: 1,
      processedChunks: 1,
      lastError: null,
    },
    exposures: [
      {
        id: "exposure_doc_123",
        paymentId: PAYMENT_ID,
        organizationId: ORGANIZATION_ID,
        sourceKind: "refund",
        sourceRef,
        sourceAmount: refundedCredits / 100,
        sourceAmountExact: true,
        requestedCredits: refundedCredits,
        effectiveCredits: refundedCredits,
        walletCredits: walletReversedCredits,
        publisherCredits,
        appliedPublisherCredits: publisherCredits,
        active: true,
      },
    ],
    clawbacks: [
      {
        id: "clawback_doc_123",
        paymentId: PAYMENT_ID,
        consumerOrganizationId: ORGANIZATION_ID,
        publisherOrganizationId: PUBLISHER_ORGANIZATION_ID,
        earningId: EARNING_ID,
        sourceKind: "refund",
        sourceRef,
        grossCredits: publisherCredits,
        amountAtoms: publisherAtoms,
        restoredGrossCredits: 0,
        restoredAtoms: 0,
        state: "active",
        journal: null,
      },
    ],
    earnings: [
      {
        id: EARNING_ID,
        publisherOrganizationId: PUBLISHER_ORGANIZATION_ID,
        consumerOrganizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        usageSettlementRefId: "settle:ui_request_123",
        grossCredits: publisherCredits,
        platformFeeAtoms: publisherCredits * 500,
        publisherNetAtoms: publisherAtoms,
        clawedBackGrossCredits: publisherCredits,
        clawedBackAtoms: publisherAtoms,
        releasedAtoms: 0,
        status: "pending_risk",
        activeClawbackGrossCredits: publisherCredits,
        activeClawbackAtoms: publisherAtoms,
      },
    ],
    publishers: [
      {
        organizationId: PUBLISHER_ORGANIZATION_ID,
        balance: {
          availableAtoms: 0,
          allocatedAtoms: 0,
          paidAtoms: 0,
          pendingRiskAtoms: 0,
          reversedAtoms: publisherAtoms,
          failedAtoms: 0,
          sequence: 0,
        },
        journalSums: {
          availableAtoms: 0,
          allocatedAtoms: 0,
          paidAtoms: 0,
          entryCount: 0,
          lastSequence: 0,
        },
        derivedAggregates: {
          pendingRiskAtoms: 0,
          reversedAtoms: publisherAtoms,
          failedAtoms: 0,
        },
      },
    ],
  };
}

function appPathEvidence() {
  const baselineBalance = {
    availableAtoms: 1_100_000_000,
    allocatedAtoms: 0,
    paidAtoms: 0,
    pendingRiskAtoms: 0,
    reversedAtoms: 0,
    failedAtoms: 0,
    sequence: 8,
  };
  const allocated = {
    kind: "transfer_allocation",
    availableDeltaAtoms: -1_100_000_000,
    allocatedDeltaAtoms: 1_100_000_000,
    paidDeltaAtoms: 0,
    sequence: 9,
    refId: `publisher:transfer:${TRANSFER_ID}:allocated`,
  };
  const succeeded = {
    kind: "transfer_succeeded",
    availableDeltaAtoms: 0,
    allocatedDeltaAtoms: -1_100_000_000,
    paidDeltaAtoms: 1_100_000_000,
    sequence: 10,
    refId: `publisher:transfer:${TRANSFER_ID}:succeeded`,
  };
  return {
    baseline: {
      organization: {
        id: ORGANIZATION_ID,
        clerkOrgId: CLERK_ORG_ID,
      },
      profile: {
        id: PROFILE_ID,
        organizationId: ORGANIZATION_ID,
        stripeConnectedAccountId: CONNECTED_ACCOUNT_ID,
        payoutsEnabled: true,
        disabledReason: null,
      },
      balance: baselineBalance,
      journalSums: {
        availableAtoms: baselineBalance.availableAtoms,
        allocatedAtoms: baselineBalance.allocatedAtoms,
        paidAtoms: baselineBalance.paidAtoms,
        entryCount: baselineBalance.sequence,
        lastSequence: baselineBalance.sequence,
      },
      transferIds: ["publisher_transfer_old_123"],
      openTransferCount: 0,
    },
    onboarding: {
      authenticated: true,
      activeClerkOrgId: CLERK_ORG_ID,
      action: "payouts.startOnboarding",
      apiSurface: "v2.core.accountLinks.create",
      profileId: PROFILE_ID,
      connectedAccountId: CONNECTED_ACCOUNT_ID,
      linkOrigin: "https://connect.stripe.com",
      linkHash: "d".repeat(64),
      observedAt: TIMESTAMPS.onboardingObserved,
      provider: {
        accountId: CONNECTED_ACCOUNT_ID,
        dashboard: "express",
        transferCapability: "active",
        payoutCapability: "active",
        verifiedAt: TIMESTAMPS.onboardingVerified,
      },
    },
    transfer: {
      ui: {
        authenticated: true,
        activeClerkOrgId: CLERK_ORG_ID,
        action: "payouts.initiatePublisherTransfer",
        observedAt: TIMESTAMPS.transferObserved,
      },
      local: {
        id: TRANSFER_ID,
        profileId: PROFILE_ID,
        publisherOrganizationId: ORGANIZATION_ID,
        stripeConnectedAccountId: CONNECTED_ACCOUNT_ID,
        amount: 1_100,
        amountAtoms: 1_100_000_000,
        remainderAtoms: 0,
        currency: "usd",
        stripeTransferId: STRIPE_TRANSFER_ID,
        reversedAmount: 0,
        correlationNonce: CORRELATION_NONCE,
        correlationHmac: CORRELATION_HMAC,
        platformAccountId: PLATFORM_ACCOUNT_ID,
        status: "succeeded",
      },
      provider: {
        id: STRIPE_TRANSFER_ID,
        livemode: false,
        amount: 1_100,
        amountReversed: 0,
        reversed: false,
        currency: "usd",
        destination: CONNECTED_ACCOUNT_ID,
        platformAccountId: PLATFORM_ACCOUNT_ID,
        metadata: {
          publisherTransferId: TRANSFER_ID,
          correlationNonce: CORRELATION_NONCE,
          correlationHmac: CORRELATION_HMAC,
          platformAccountId: PLATFORM_ACCOUNT_ID,
        },
        verifiedAt: TIMESTAMPS.transferVerified,
      },
      providerEventId: "evt_transfercreated123",
      settlementEntries: [allocated, succeeded],
      webhook: {
        stripeEventId: "evt_transfercreated123",
        eventType: "transfer.created",
        objectId: STRIPE_TRANSFER_ID,
        status: "processed",
        deliveries: 1,
        attempts: 1,
      },
    },
  };
}

function acceptanceReport() {
  const appPath = appPathEvidence();
  const usage = usageEvidence();
  const refund = refundEvidence({
    refundedCredits: 100_000,
    walletReversedCredits: 99_997,
    publisherCredits: 3,
    walletBalance: 0,
    status: "refunded",
  });
  refund.event.deliveries = 1;
  const partialRefund = refundEvidence({
    refundedCredits: 25_000,
    walletReversedCredits: 24_997,
    publisherCredits: 3,
    walletBalance: 75_000,
    status: "partially_refunded",
    capturedAt: TIMESTAMPS.partialRefundCaptured,
    eventId: PARTIAL_REFUND_EVENT_ID,
    refundId: "re_partial123",
  });
  const partialInitial = structuredClone(partialRefund);
  partialInitial.capturedAt = TIMESTAMPS.partialInitialCaptured;
  partialInitial.event.deliveries = 1;
  const fullRefundSource = "stripe:refund:re_partial123";
  refund.exposures = [
    {
      ...refund.exposures[0],
      sourceRef: fullRefundSource,
      sourceAmount: 250,
      requestedCredits: 25_000,
      effectiveCredits: 25_000,
      walletCredits: 24_997,
      publisherCredits: 3,
      appliedPublisherCredits: 3,
    },
    {
      ...refund.exposures[0],
      id: "exposure_doc_remaining_123",
      sourceRef: "stripe:refund:re_remaining123",
      sourceAmount: 750,
      requestedCredits: 75_000,
      effectiveCredits: 75_000,
      walletCredits: 75_000,
      publisherCredits: 0,
      appliedPublisherCredits: 0,
    },
  ];
  refund.clawbacks = expectedCalls().map((call, index) => ({
    ...refund.clawbacks[0],
    id: `clawback_doc_${index}`,
    earningId: `publisher_earning_doc_${index}`,
    sourceRef: fullRefundSource,
    grossCredits: 1,
    amountAtoms: 9_500,
  }));
  refund.earnings = expectedCalls().map((call, index) => ({
    ...refund.earnings[0],
    id: `publisher_earning_doc_${index}`,
    publisherOrganizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    usageSettlementRefId: `settle:${call.requestId}`,
    grossCredits: 1,
    platformFeeAtoms: 500,
    publisherNetAtoms: 9_500,
    clawedBackGrossCredits: 1,
    clawedBackAtoms: 9_500,
    activeClawbackGrossCredits: 1,
    activeClawbackAtoms: 9_500,
  }));
  for (const clawback of refund.clawbacks) {
    clawback.publisherOrganizationId = ORGANIZATION_ID;
  }
  refund.publishers = [
    {
      organizationId: ORGANIZATION_ID,
      balance: {
        availableAtoms: 0,
        allocatedAtoms: 0,
        paidAtoms: 1_100_000_000,
        pendingRiskAtoms: 0,
        reversedAtoms: 28_500,
        failedAtoms: 0,
        sequence: 10,
      },
      journalSums: {
        availableAtoms: 0,
        allocatedAtoms: 0,
        paidAtoms: 1_100_000_000,
        entryCount: 10,
        lastSequence: 10,
      },
      derivedAggregates: {
        pendingRiskAtoms: 0,
        reversedAtoms: 28_500,
        failedAtoms: 0,
      },
    },
  ];
  const reversal = {
    kind: "transfer_reversal",
    availableDeltaAtoms: 1_100_000_000,
    allocatedDeltaAtoms: 0,
    paidDeltaAtoms: -1_100_000_000,
    sequence: 11,
    refId: `publisher:transfer:${TRANSFER_ID}:reversed:1100`,
  };
  const deploymentIds = {
    web: "web-deployment-123",
    gateway: "gateway-deployment-123",
    convex: "convex-deployment-123",
  };
  return {
    schemaVersion: 3,
    reportType: "zevium-stripe-acceptance",
    acceptance: true,
    status: "passed",
    run: {
      runRef: RUN_REF,
      githubSha: GITHUB_SHA,
      mode: "staging",
      startedAt: TIMESTAMPS.started,
      completedAt: TIMESTAMPS.completed,
    },
    deployment: {
      verifiedAt: TIMESTAMPS.deploymentVerified,
      manifests: Object.entries(deploymentIds).map(
        ([service, deploymentId]) => ({
          schemaVersion: 1,
          service,
          mode: "staging",
          gitSha: GITHUB_SHA,
          deploymentId,
          deployedAt: TIMESTAMPS.deployed,
        }),
      ),
    },
    appPath,
    ledger: {
      usageExpected: expectedCalls(),
      usageBaseline: { wallet: { balance: 100_000, sequence: 2 } },
      usage,
      partial: partialInitial,
      refundBaseline: partialRefund,
      refund,
    },
    provider: {
      checkoutSessionId: CHECKOUT_SESSION_ID,
      chargeId: CHARGE_ID,
      partialRefundEventId: PARTIAL_REFUND_EVENT_ID,
      refundEventId: REFUND_EVENT_ID,
      refundIds: ["re_partial123", "re_remaining123"],
      checkoutVerifiedAt: TIMESTAMPS.checkoutVerified,
      webhookCanary: {
        eventId: PARTIAL_REFUND_EVENT_ID,
        canaryEndpointId: "we_canary123",
        canonicalEndpointId: "we_canonical123",
        exactPendingDeliveries: 1,
        canonicalReceiptDeliveries: 1,
        exclusiveV1SubscriberIds: ["we_canonical123", "we_canary123"],
        competingV2SubscriberCount: 0,
        canaryDeletedAt: TIMESTAMPS.canaryDeleted,
        canonicalReplayRequestedAt: TIMESTAMPS.canonicalReplayRequested,
      },
    },
    compensation: {
      status: "complete",
      provider: {
        id: STRIPE_TRANSFER_ID,
        reversed: true,
        amountReversed: 1_100,
      },
      providerEventId: "evt_transferreversed123",
      local: {
        ...appPath.transfer.local,
        status: "reversed",
        reversedAmount: 1_100,
      },
      webhook: {
        stripeEventId: "evt_transferreversed123",
        eventType: "transfer.reversed",
        objectId: STRIPE_TRANSFER_ID,
        status: "processed",
        deliveries: 1,
        attempts: 1,
      },
      settlementEntries: [...appPath.transfer.settlementEntries, reversal],
      publisherBalance: {
        ...appPath.baseline.balance,
        reversedAtoms: 28_500,
        sequence: 11,
      },
      journalSums: {
        availableAtoms: appPath.baseline.balance.availableAtoms,
        allocatedAtoms: appPath.baseline.balance.allocatedAtoms,
        paidAtoms: appPath.baseline.balance.paidAtoms,
        entryCount: 11,
        lastSequence: 11,
      },
      payment: {
        status: "refunded",
        reconciliationStatus: "complete",
      },
      canary: {
        deleted: true,
        canonicalUnchanged: true,
        canonicalEndpointId: "we_canonical123",
        verifiedAt: TIMESTAMPS.canaryCleanupVerified,
      },
      completedAt: TIMESTAMPS.compensationCompleted,
    },
    primitives: {
      acceptanceRole: "supplemental_only",
      requiredForAcceptance: false,
    },
  };
}

function acceptanceExpectation() {
  return {
    runRef: RUN_REF,
    githubSha: GITHUB_SHA,
    deployment: {
      githubSha: GITHUB_SHA,
      mode: "staging",
      deploymentIds: {
        web: "web-deployment-123",
        gateway: "gateway-deployment-123",
        convex: "convex-deployment-123",
      },
      now: Date.parse(TIMESTAMPS.completed),
      maxAgeMs: 60 * 60 * 1_000,
      verificationMaxAgeMs: 60 * 60 * 1_000,
    },
    appPath: {
      clerkOrgId: CLERK_ORG_ID,
      connectedAccountId: CONNECTED_ACCOUNT_ID,
      platformAccountId: PLATFORM_ACCOUNT_ID,
    },
  };
}

function freshAcceptanceReport() {
  const report = acceptanceReport();
  const ordered = [
    "deployed",
    "started",
    "deploymentVerified",
    "checkoutVerified",
    "onboardingObserved",
    "onboardingVerified",
    "transferObserved",
    "transferVerified",
    "usageCaptured",
    "partialInitialCaptured",
    "canaryDeleted",
    "canonicalReplayRequested",
    "partialRefundCaptured",
    "refundCaptured",
    "canaryCleanupVerified",
    "compensationCompleted",
    "completed",
  ];
  let serialized = JSON.stringify(report);
  const completedAt = Date.now();
  ordered.forEach((name, index) => {
    const fresh = new Date(
      completedAt - (ordered.length - index - 1) * 60_000,
    ).toISOString();
    serialized = serialized.replaceAll(TIMESTAMPS[name], fresh);
  });
  return JSON.parse(serialized);
}

test("acceptance sanitizer emits keyed minimal DTO without raw identities", () => {
  const report = freshAcceptanceReport();
  const hashKey = "payment-proof-dedicated-hash-key-123456";
  const environment = {
    E2E_PUBLISHER_CLERK_ORG_ID: CLERK_ORG_ID,
    GITHUB_SHA,
    STRIPE_CONNECT_PLATFORM_ACCOUNT_ID: PLATFORM_ACCOUNT_ID,
    STRIPE_CONNECT_SETTLEMENT_ACCOUNT_ID: CONNECTED_ACCOUNT_ID,
    STRIPE_PROOF_RUN_REF: RUN_REF,
    ZEVIUM_CONVEX_DEPLOYMENT_ID: "convex-deployment-123",
    ZEVIUM_DEPLOYMENT_MAX_AGE_SECONDS: "3600",
    ZEVIUM_DEPLOYMENT_MODE: "staging",
    ZEVIUM_GATEWAY_DEPLOYMENT_ID: "gateway-deployment-123",
    ZEVIUM_WEB_DEPLOYMENT_ID: "web-deployment-123",
  };
  const previous = new Map(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, environment);
  try {
    const dto = buildAcceptanceDto(report, hashKey);
    assert.equal(
      dto.ledger.refund.paymentHash,
      stableEvidenceHash("convex-payment", PAYMENT_ID, hashKey),
    );
    assert.equal(
      dto.appPath.onboarding.apiSurface,
      "v2.core.accountLinks.create",
    );
    assert.equal(dto.ledger.refund.reconciliationStatus, "complete");
    const serialized = JSON.stringify(dto);
    for (const rawId of [
      RUN_REF,
      CLERK_ORG_ID,
      ORGANIZATION_ID,
      PROFILE_ID,
      CONNECTED_ACCOUNT_ID,
      PLATFORM_ACCOUNT_ID,
      PAYMENT_ID,
      CHECKOUT_SESSION_ID,
      CHARGE_ID,
      TRANSFER_ID,
      STRIPE_TRANSFER_ID,
    ]) {
      assert.equal(serialized.includes(rawId), false, `leaked ${rawId}`);
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("accepts restricted sandbox keys and rejects broad/live keys", () => {
  const key = (scope, mode, suffix) => `${scope}_${mode}_${suffix}`;
  assert.equal(
    requireTestStripeKey({ KEY: key("rk", "test", "restricted") }, "KEY"),
    key("rk", "test", "restricted"),
  );
  assert.throws(() =>
    requireTestStripeKey({ KEY: key("sk", "test", "too_broad") }, "KEY"),
  );
  assert.throws(() =>
    requireTestStripeKey({ KEY: key("sk", "live", "nope") }, "KEY"),
  );
  assert.throws(() =>
    requireTestStripeKey({ KEY: key("rk", "live", "nope") }, "KEY"),
  );
});

test("normalizes bounded stable provider run references", () => {
  assert.equal(normalizeRunRef("31556580011/rerun"), "31556580011-rerun");
  assert.equal(normalizeRunRef("x".repeat(100)).length, 80);
  assert.throws(() => normalizeRunRef("tiny"));
});

test("requires exclusive canonical and disposable refund subscribers", () => {
  const canonical = {
    id: "we_canonical",
    status: "enabled",
    enabled_events: ["charge.refunded"],
  };
  const canary = {
    id: "we_canary",
    status: "enabled",
    enabled_events: ["charge.refunded"],
  };
  assert(endpointAccepts(canonical, "charge.refunded"));
  assert.equal(
    assertExclusiveEndpointTopology({
      endpoints: [canonical, canary],
      canonicalEndpointId: canonical.id,
      canaryEndpointId: canary.id,
      eventType: "charge.refunded",
    }).length,
    2,
  );
  assert.throws(() =>
    assertExclusiveEndpointTopology({
      endpoints: [
        canonical,
        canary,
        { id: "we_wildcard", status: "enabled", enabled_events: ["*"] },
      ],
      canonicalEndpointId: canonical.id,
      canaryEndpointId: canary.id,
      eventType: "charge.refunded",
    }),
  );
});

test("proves exact ledger and completed publisher reconciliation", () => {
  const baseline = {
    payment: { walletReversedCredits: 0 },
    wallet: { balance: 99_998 },
  };
  assert.doesNotThrow(() =>
    assertLedgerEvidence(refundEvidence(), {
      expectedRefundedCredits: 25_000,
      eventId: REFUND_EVENT_ID,
      minDeliveries: 2,
      expectedEventType: "charge.refunded",
      expectedObjectId: CHARGE_ID,
      baseline,
    }),
  );
});

test("rejects pending/failed reconciliation and every conservation break", () => {
  const baseline = {
    payment: { walletReversedCredits: 0 },
    wallet: { balance: 99_998 },
  };
  const assertRejected = (mutate) => {
    const evidence = refundEvidence();
    mutate(evidence);
    assert.throws(() =>
      assertLedgerEvidence(evidence, {
        expectedRefundedCredits: 25_000,
        eventId: REFUND_EVENT_ID,
        minDeliveries: 2,
        expectedEventType: "charge.refunded",
        expectedObjectId: CHARGE_ID,
        baseline,
      }),
    );
  };
  for (const status of ["pending", "running", "failed"]) {
    assertRejected((evidence) => {
      evidence.reconciliation.status = status;
    });
  }
  assertRejected((evidence) => {
    evidence.exposures[0].appliedPublisherCredits = 1;
  });
  assertRejected((evidence) => {
    evidence.clawbacks[0].paymentId = "unrelated_payment";
  });
  assertRejected((evidence) => {
    evidence.earnings[0].clawedBackAtoms -= 1;
  });
  assertRejected((evidence) => {
    evidence.publishers[0].balance.reversedAtoms -= 1;
  });
  assertRejected((evidence) => {
    evidence.reversalJournalCredits -= 1;
  });
});

test("pending count is accepted only after exclusive topology proof", () => {
  assert.doesNotThrow(() =>
    assertPendingCanaryEvent({ livemode: false, pending_webhooks: 1 }),
  );
  assert.throws(() =>
    assertPendingCanaryEvent({ livemode: false, pending_webhooks: 0 }),
  );
  assert.throws(() =>
    assertPendingCanaryEvent({ livemode: false, pending_webhooks: 2 }),
  );
});

test("rejects competing v2 snapshot event destinations", () => {
  assert.doesNotThrow(() =>
    assertNoCompetingEventDestinations(
      [
        {
          status: "enabled",
          type: "webhook_endpoint",
          event_payload: "thin",
          events_from: ["self"],
          enabled_events: ["v1.charge.refunded"],
        },
      ],
      "charge.refunded",
    ),
  );
  assert.throws(() =>
    assertNoCompetingEventDestinations(
      [
        {
          status: "enabled",
          type: "webhook_endpoint",
          event_payload: "snapshot",
          events_from: ["self"],
          enabled_events: ["v1.charge.refunded"],
        },
      ],
      "charge.refunded",
    ),
  );
});

test("proves exact gateway requests through contiguous usage ledger", () => {
  const proof = usageEvidence();
  const baseline = { wallet: { balance: 100_000, sequence: 2 } };
  assert.doesNotThrow(() =>
    assertUsageEvidence(proof, expectedCalls(), baseline),
  );
  proof.interveningEntries.push({
    refId: "admin:noise",
    kind: "admin_adjustment",
    amount: -1,
    sequence: 6,
  });
  proof.wallet = { balance: 99_996, sequence: 6 };
  assert.throws(() => assertUsageEvidence(proof, expectedCalls(), baseline));
});

test("complete acceptance report proves exact fresh app/provider/ledger path", () => {
  assert.doesNotThrow(() =>
    assertAcceptanceReport(acceptanceReport(), acceptanceExpectation()),
  );
});

const falsePassCases = [
  [
    "stale deployment",
    (report) => {
      report.deployment.manifests[0].deployedAt = "2026-08-10T09:50:00.000Z";
    },
  ],
  [
    "wrong SHA",
    (report) => {
      report.deployment.manifests[1].gitSha = "f".repeat(40);
    },
  ],
  [
    "wrong deployment id",
    (report) => {
      report.deployment.manifests[2].deploymentId = "convex-deployment-stale";
    },
  ],
  [
    "wrong mode",
    (report) => {
      report.deployment.manifests[0].mode = "preview";
    },
  ],
  [
    "direct primitives promoted",
    (report) => {
      report.primitives.requiredForAcceptance = true;
    },
  ],
  [
    "direct primitives masquerade as acceptance",
    (report) => {
      report.reportType = "stripe-provider-supplemental";
      report.acceptance = false;
    },
  ],
  [
    "wrong active organization",
    (report) => {
      report.appPath.baseline.organization.clerkOrgId = "org_unrelated123";
    },
  ],
  [
    "wrong profile",
    (report) => {
      report.appPath.onboarding.profileId = "payment_profile_unrelated";
    },
  ],
  [
    "partial UI journey",
    (report) => {
      report.appPath.transfer.ui.authenticated = false;
    },
  ],
  [
    "partial onboarding API proof",
    (report) => {
      delete report.appPath.onboarding.provider;
    },
  ],
  [
    "v1 account links",
    (report) => {
      report.appPath.onboarding.apiSurface = "v1.accountLinks.create";
    },
  ],
  [
    "wrong provider transfer",
    (report) => {
      report.appPath.transfer.provider.id = "tr_unrelated123";
    },
  ],
  [
    "wrong provider platform",
    (report) => {
      report.appPath.transfer.provider.platformAccountId = "acct_unrelated123";
    },
  ],
  [
    "wrong HMAC metadata",
    (report) => {
      report.appPath.transfer.provider.metadata.correlationHmac = "e".repeat(
        64,
      );
    },
  ],
  [
    "unrelated webhook",
    (report) => {
      report.appPath.transfer.webhook.objectId = "tr_unrelated123";
    },
  ],
  [
    "unrelated usage organization",
    (report) => {
      report.ledger.usage.calls[0].usage.organizationId = "organization_other";
    },
  ],
  [
    "pending reconciliation",
    (report) => {
      report.ledger.refund.reconciliation.status = "pending";
    },
  ],
  [
    "failed reconciliation",
    (report) => {
      report.ledger.refund.reconciliation.status = "failed";
    },
  ],
  [
    "unrelated clawback",
    (report) => {
      report.ledger.refund.clawbacks[0].consumerOrganizationId =
        "organization_other";
    },
  ],
  [
    "unrelated refund source",
    (report) => {
      report.provider.refundIds[0] = "re_unrelated123";
    },
  ],
  [
    "unrelated refund webhook canary",
    (report) => {
      report.provider.webhookCanary.eventId = "evt_unrelated123";
    },
  ],
  [
    "stale app evidence",
    (report) => {
      report.appPath.onboarding.observedAt = "2026-08-11T09:58:00.000Z";
    },
  ],
  [
    "pending compensation",
    (report) => {
      report.compensation.status = "pending";
    },
  ],
  [
    "partial compensation",
    (report) => {
      report.compensation.provider.amountReversed = 1_099;
    },
  ],
];

for (const [name, mutate] of falsePassCases) {
  test(`rejects adversarial false pass: ${name}`, () => {
    const report = acceptanceReport();
    mutate(report);
    assert.throws(() =>
      assertAcceptanceReport(report, acceptanceExpectation()),
    );
  });
}
