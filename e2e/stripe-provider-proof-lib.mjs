export const STRIPE_API_VERSION = "2026-06-24.dahlia";
export const MAX_PROVIDER_OBJECTS = 500;
export const ACCOUNTING_ATOMS_PER_CREDIT = 10_000;
export const PUBLISHER_ATOMS_PER_GROSS_CREDIT = 9_500;

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function normalizeRunRef(value) {
  const normalized = String(value ?? "")
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 80);
  invariant(normalized.length >= 8, "Stripe proof run reference is too short");
  return normalized;
}

export function requireTestStripeKey(env, name) {
  const key = env[name]?.trim();
  invariant(
    /^rk_test_[A-Za-z0-9_]+$/.test(key ?? ""),
    `${name} must be a Stripe restricted test key (rk_test_)`,
  );
  return key;
}

export function endpointAccepts(endpoint, eventType) {
  return (
    endpoint.status === "enabled" &&
    endpoint.connect !== true &&
    (endpoint.enabled_events.includes("*") ||
      endpoint.enabled_events.includes(eventType))
  );
}

export function assertExclusiveEndpointTopology({
  endpoints,
  canonicalEndpointId,
  canaryEndpointId,
  eventType,
}) {
  const subscribers = endpoints.filter((endpoint) =>
    endpointAccepts(endpoint, eventType),
  );
  const subscriberIds = new Set(subscribers.map((endpoint) => endpoint.id));
  invariant(
    subscriberIds.has(canonicalEndpointId),
    `Canonical endpoint does not subscribe to ${eventType}`,
  );
  invariant(
    subscriberIds.has(canaryEndpointId),
    `Disposable canary does not subscribe to ${eventType}`,
  );
  invariant(
    subscriberIds.size === 2,
    `${eventType} must have exactly canonical and disposable subscribers; found ${subscriberIds.size}`,
  );
  return subscribers;
}

function requireSafeCredit(value, name) {
  invariant(Number.isSafeInteger(value) && value >= 0, `${name} is invalid`);
}

export function assertLedgerEvidence(
  evidence,
  {
    expectedRefundedCredits,
    eventId,
    minDeliveries,
    maxDeliveries = Number.POSITIVE_INFINITY,
    expectedEventType,
    expectedObjectId,
    baseline = null,
  },
) {
  invariant(evidence?.payment !== null, "Convex payment receipt is missing");
  invariant(evidence?.wallet !== null, "Convex wallet is missing");
  invariant(evidence?.event !== null, "Convex Stripe event receipt is missing");
  const { payment, wallet, event, reversalJournalCredits, disputeCount } =
    evidence;
  for (const [name, value] of Object.entries({
    grantedCredits: payment.grantedCredits,
    refundedCredits: payment.refundedCredits,
    reversedCredits: payment.reversedCredits,
    walletReversedCredits: payment.walletReversedCredits,
    publisherClawbackTargetCredits: payment.publisherClawbackTargetCredits,
    walletSequence: wallet.sequence,
    reversalJournalCredits,
    deliveries: event.deliveries,
    attempts: event.attempts,
    disputeCount,
  })) {
    requireSafeCredit(value, name);
  }
  invariant(Number.isSafeInteger(wallet.balance), "walletBalance is invalid");
  invariant(payment.amount === 1_000, "Payment amount must be exactly $10");
  invariant(payment.currency === "usd", "Payment currency must be USD");
  invariant(payment.grantedCredits === 100_000, "Payment grant changed");
  invariant(
    payment.refundedAmount === expectedRefundedCredits / 100,
    "Stripe refund amount and credit projection diverged",
  );
  const expectedStatus =
    expectedRefundedCredits === 0
      ? "paid"
      : expectedRefundedCredits === payment.grantedCredits
        ? "refunded"
        : "partially_refunded";
  invariant(
    payment.status === expectedStatus,
    "Payment status projection changed",
  );
  invariant(disputeCount === 0, "Payment drill payment has unrelated disputes");
  invariant(event.stripeEventId === eventId, "Convex receipt event id changed");
  invariant(
    event.eventType === expectedEventType,
    "Convex receipt type changed",
  );
  invariant(
    event.objectId === expectedObjectId,
    "Convex receipt object changed",
  );
  invariant(event.status === "processed", "Convex event is not processed");
  invariant(
    event.deliveries >= minDeliveries,
    `Convex receipt has ${event.deliveries} deliveries; expected at least ${minDeliveries}`,
  );
  invariant(
    event.deliveries <= maxDeliveries,
    `Convex receipt has ${event.deliveries} deliveries; expected at most ${maxDeliveries}`,
  );
  invariant(
    payment.refundedCredits === expectedRefundedCredits,
    `Convex refunded ${payment.refundedCredits}; expected ${expectedRefundedCredits}`,
  );
  invariant(
    payment.reversedCredits === expectedRefundedCredits,
    "Effective payment reversal does not equal Stripe refund projection",
  );
  invariant(
    payment.walletReversedCredits + payment.publisherClawbackTargetCredits ===
      payment.reversedCredits,
    "Wallet and publisher reversal split does not conserve credits",
  );
  invariant(
    reversalJournalCredits === payment.walletReversedCredits,
    "Immutable wallet reversal journal does not match payment projection",
  );
  if (baseline !== null) {
    const expectedWallet =
      baseline.wallet.balance -
      (payment.walletReversedCredits - baseline.payment.walletReversedCredits);
    invariant(
      wallet.balance === expectedWallet,
      `Wallet changed outside exact refund reversal (${wallet.balance} != ${expectedWallet})`,
    );
  }
  assertPublisherReconciliationEvidence(evidence, {
    expectedRefundedCredits,
  });
  return evidence;
}

export function assertPublisherReconciliationEvidence(
  evidence,
  { expectedRefundedCredits },
) {
  const exposures = evidence?.exposures;
  const clawbacks = evidence?.clawbacks;
  const earnings = evidence?.earnings;
  const publishers = evidence?.publishers;
  invariant(Array.isArray(exposures), "Payment exposures are missing");
  invariant(Array.isArray(clawbacks), "Publisher clawbacks are missing");
  invariant(Array.isArray(earnings), "Publisher earning proofs are missing");
  invariant(Array.isArray(publishers), "Publisher balance proofs are missing");
  for (const rows of [exposures, clawbacks, earnings, publishers]) {
    invariant(
      rows.length <= MAX_PROVIDER_OBJECTS,
      "Publisher reconciliation evidence is unbounded",
    );
  }

  if (expectedRefundedCredits === 0) {
    invariant(exposures.length === 0, "Grant proof has refund exposures");
    invariant(clawbacks.length === 0, "Grant proof has publisher clawbacks");
    invariant(
      evidence.reconciliation === null,
      "Grant proof has publisher reconciliation work",
    );
    return evidence;
  }

  const job = evidence.reconciliation;
  invariant(job !== null, "Publisher reconciliation job is missing");
  invariant(
    job.paymentId === evidence.payment.id &&
      job.consumerOrganizationId === evidence.payment.organizationId &&
      job.status === "complete",
    `Publisher reconciliation is ${job.status ?? "missing"}`,
  );
  invariant(
    job.lastError === null &&
      Number.isSafeInteger(job.revision) &&
      job.revision > 0 &&
      Number.isSafeInteger(job.processedChunks) &&
      job.processedChunks > 0,
    "Publisher reconciliation completion is invalid",
  );
  invariant(exposures.length > 0, "Refund exposure journal is missing");

  const sourceRefs = new Set();
  let sourceAmount = 0;
  let requestedCredits = 0;
  let effectiveCredits = 0;
  let walletCredits = 0;
  let publisherCredits = 0;
  for (const exposure of exposures) {
    for (const [name, value] of Object.entries({
      sourceAmount: exposure.sourceAmount,
      requestedCredits: exposure.requestedCredits,
      effectiveCredits: exposure.effectiveCredits,
      walletCredits: exposure.walletCredits,
      publisherCredits: exposure.publisherCredits,
      appliedPublisherCredits: exposure.appliedPublisherCredits,
    })) {
      requireSafeCredit(value, `exposure.${name}`);
    }
    invariant(exposure.active === true, "Inactive refund exposure accepted");
    invariant(
      exposure.paymentId === evidence.payment.id &&
        exposure.organizationId === evidence.payment.organizationId &&
        exposure.sourceKind === "refund" &&
        exposure.sourceAmountExact === true &&
        exposure.sourceAmount > 0 &&
        exposure.requestedCredits === exposure.sourceAmount * 100 &&
        /^stripe:refund:re_[A-Za-z0-9]+$/.test(exposure.sourceRef),
      "Refund exposure source correlation is invalid",
    );
    invariant(
      !sourceRefs.has(exposure.sourceRef),
      "Refund exposure duplicated",
    );
    sourceRefs.add(exposure.sourceRef);
    sourceAmount += exposure.sourceAmount;
    requestedCredits += exposure.requestedCredits;
    invariant(
      exposure.walletCredits + exposure.publisherCredits ===
        exposure.effectiveCredits,
      "Exposure wallet/publisher split does not conserve credits",
    );
    invariant(
      exposure.appliedPublisherCredits === exposure.publisherCredits,
      "Publisher exposure reconciliation is incomplete",
    );
    effectiveCredits += exposure.effectiveCredits;
    walletCredits += exposure.walletCredits;
    publisherCredits += exposure.publisherCredits;
  }
  invariant(
    sourceAmount === evidence.payment.refundedAmount &&
      requestedCredits === evidence.payment.refundedCredits &&
      effectiveCredits === evidence.payment.reversedCredits &&
      walletCredits === evidence.payment.walletReversedCredits &&
      publisherCredits === evidence.payment.publisherClawbackTargetCredits,
    "Exposure totals do not match payment reversal",
  );
  invariant(
    publisherCredits > 0,
    "Refund proof never exercised publisher clawback",
  );

  const earningById = new Map(earnings.map((earning) => [earning.id, earning]));
  invariant(
    earningById.size === earnings.length,
    "Publisher earning evidence is duplicated",
  );
  const publisherById = new Map(
    publishers.map((publisher) => [publisher.organizationId, publisher]),
  );
  invariant(
    publisherById.size === publishers.length,
    "Publisher balance evidence is duplicated",
  );
  const clawbackIds = new Set();
  let activeClawbackCredits = 0;
  let activeClawbackAtoms = 0;
  const activeBySource = new Map();
  for (const clawback of clawbacks) {
    invariant(
      !clawbackIds.has(clawback.id),
      "Publisher clawback is duplicated",
    );
    clawbackIds.add(clawback.id);
    const restoredGrossCredits = clawback.restoredGrossCredits ?? 0;
    const restoredAtoms = clawback.restoredAtoms ?? 0;
    for (const [name, value] of Object.entries({
      grossCredits: clawback.grossCredits,
      amountAtoms: clawback.amountAtoms,
      restoredGrossCredits,
      restoredAtoms,
    })) {
      requireSafeCredit(value, `clawback.${name}`);
    }
    invariant(
      clawback.paymentId === evidence.payment.id &&
        clawback.consumerOrganizationId === evidence.payment.organizationId,
      "Publisher clawback belongs to another payment or consumer",
    );
    invariant(
      clawback.sourceKind === "refund" && sourceRefs.has(clawback.sourceRef),
      "Publisher clawback source is unrelated",
    );
    invariant(
      restoredGrossCredits === 0 &&
        restoredAtoms === 0 &&
        clawback.state === "active",
      "Active refund clawback contains restoration state",
    );
    invariant(
      clawback.amountAtoms ===
        clawback.grossCredits * PUBLISHER_ATOMS_PER_GROSS_CREDIT,
      "Publisher clawback atom split changed",
    );
    const earning = earningById.get(clawback.earningId);
    invariant(earning !== undefined, "Clawed-back earning evidence is missing");
    invariant(
      earning.publisherOrganizationId === clawback.publisherOrganizationId,
      "Clawback publisher and earning publisher differ",
    );
    invariant(
      publisherById.has(clawback.publisherOrganizationId),
      "Clawback publisher balance evidence is missing",
    );
    const netCredits = clawback.grossCredits - restoredGrossCredits;
    const netAtoms = clawback.amountAtoms - restoredAtoms;
    if (netCredits > 0) {
      invariant(clawback.state === "active", "Active clawback state changed");
    }
    activeClawbackCredits += netCredits;
    activeClawbackAtoms += netAtoms;
    activeBySource.set(
      clawback.sourceRef,
      (activeBySource.get(clawback.sourceRef) ?? 0) + netCredits,
    );
    if (clawback.journal !== null) {
      invariant(
        clawback.journal.kind === "refund_clawback" &&
          clawback.journal.refId ===
            `${clawback.sourceRef}:clawback:${clawback.id}` &&
          clawback.journal.publisherOrganizationId ===
            clawback.publisherOrganizationId &&
          clawback.journal.paymentId === evidence.payment.id &&
          clawback.journal.earningId === clawback.earningId &&
          Number.isSafeInteger(clawback.journal.sequence) &&
          clawback.journal.sequence > 0 &&
          clawback.journal.availableDeltaAtoms === -clawback.amountAtoms &&
          clawback.journal.allocatedDeltaAtoms === 0 &&
          clawback.journal.paidDeltaAtoms === 0,
        "Publisher clawback settlement journal is invalid",
      );
    } else {
      invariant(
        earning.releasedAtoms === 0 && earning.status === "pending_risk",
        "Released publisher clawback is missing settlement journal",
      );
    }
  }
  invariant(
    activeClawbackCredits === publisherCredits &&
      activeClawbackAtoms ===
        publisherCredits * PUBLISHER_ATOMS_PER_GROSS_CREDIT,
    "Publisher clawback rows do not conserve target credits",
  );
  for (const exposure of exposures) {
    invariant(
      (activeBySource.get(exposure.sourceRef) ?? 0) ===
        exposure.appliedPublisherCredits,
      "Source exposure and clawback rows diverged",
    );
  }

  for (const earning of earnings) {
    for (const [name, value] of Object.entries({
      grossCredits: earning.grossCredits,
      platformFeeAtoms: earning.platformFeeAtoms,
      publisherNetAtoms: earning.publisherNetAtoms,
      clawedBackGrossCredits: earning.clawedBackGrossCredits,
      clawedBackAtoms: earning.clawedBackAtoms,
      releasedAtoms: earning.releasedAtoms,
      activeClawbackGrossCredits: earning.activeClawbackGrossCredits,
      activeClawbackAtoms: earning.activeClawbackAtoms,
    })) {
      requireSafeCredit(value, `earning.${name}`);
    }
    invariant(
      earning.consumerOrganizationId === evidence.payment.organizationId &&
        earning.grossCredits > 0 &&
        earning.platformFeeAtoms + earning.publisherNetAtoms ===
          earning.grossCredits * ACCOUNTING_ATOMS_PER_CREDIT &&
        earning.publisherNetAtoms ===
          earning.grossCredits * PUBLISHER_ATOMS_PER_GROSS_CREDIT &&
        earning.clawedBackGrossCredits === earning.activeClawbackGrossCredits &&
        earning.clawedBackAtoms === earning.activeClawbackAtoms &&
        earning.clawedBackAtoms ===
          earning.clawedBackGrossCredits * PUBLISHER_ATOMS_PER_GROSS_CREDIT,
      "Publisher earning clawback aggregate diverged",
    );
    invariant(
      earning.clawedBackGrossCredits <= earning.grossCredits &&
        earning.clawedBackAtoms <= earning.publisherNetAtoms &&
        earning.releasedAtoms + earning.clawedBackAtoms <=
          earning.publisherNetAtoms,
      "Publisher earning conservation is invalid",
    );
  }

  for (const publisher of publishers) {
    const { balance, journalSums, derivedAggregates } = publisher;
    invariant(balance !== null, "Publisher balance is missing");
    for (const [name, value] of Object.entries({
      availableAtoms: balance.availableAtoms,
      allocatedAtoms: balance.allocatedAtoms,
      paidAtoms: balance.paidAtoms,
      pendingRiskAtoms: balance.pendingRiskAtoms,
      reversedAtoms: balance.reversedAtoms,
      failedAtoms: balance.failedAtoms,
      sequence: balance.sequence,
      journalAvailableAtoms: journalSums.availableAtoms,
      journalAllocatedAtoms: journalSums.allocatedAtoms,
      journalPaidAtoms: journalSums.paidAtoms,
      journalEntryCount: journalSums.entryCount,
      journalLastSequence: journalSums.lastSequence,
      derivedPendingRiskAtoms: derivedAggregates.pendingRiskAtoms,
      derivedReversedAtoms: derivedAggregates.reversedAtoms,
      derivedFailedAtoms: derivedAggregates.failedAtoms,
    })) {
      invariant(Number.isSafeInteger(value), `publisher.${name} is invalid`);
    }
    invariant(
      balance.availableAtoms === journalSums.availableAtoms &&
        balance.allocatedAtoms === journalSums.allocatedAtoms &&
        balance.paidAtoms === journalSums.paidAtoms &&
        balance.sequence === journalSums.entryCount &&
        balance.sequence === journalSums.lastSequence,
      "Publisher settlement journal does not materialize to balance",
    );
    invariant(
      balance.allocatedAtoms >= 0 &&
        balance.paidAtoms >= 0 &&
        balance.pendingRiskAtoms >= 0 &&
        balance.reversedAtoms >= 0 &&
        balance.failedAtoms >= 0 &&
        balance.sequence >= 0,
      "Publisher materialized balance contains invalid negative buckets",
    );
    invariant(
      balance.pendingRiskAtoms === derivedAggregates.pendingRiskAtoms &&
        balance.reversedAtoms === derivedAggregates.reversedAtoms &&
        balance.failedAtoms === derivedAggregates.failedAtoms,
      "Publisher earning/transfer aggregates do not materialize to balance",
    );
  }
  return evidence;
}

export function assertPendingCanaryEvent(event, expectedPending = 1) {
  invariant(event?.livemode === false, "Stripe event must be test mode");
  invariant(
    event.pending_webhooks === expectedPending,
    `Expected ${expectedPending} pending canary delivery; found ${event.pending_webhooks}`,
  );
}

export function eventDestinationAccepts(destination, eventType) {
  const selfEvents =
    destination.events_from === undefined ||
    destination.events_from === null ||
    destination.events_from.includes("self") ||
    destination.events_from.includes("@self");
  return (
    destination.status === "enabled" &&
    destination.type === "webhook_endpoint" &&
    destination.event_payload === "snapshot" &&
    selfEvents &&
    (destination.enabled_events.includes("*") ||
      destination.enabled_events.includes(eventType) ||
      destination.enabled_events.includes(`v1.${eventType}`))
  );
}

export function assertNoCompetingEventDestinations(destinations, eventType) {
  const subscribers = destinations.filter((destination) =>
    eventDestinationAccepts(destination, eventType),
  );
  invariant(
    subscribers.length === 0,
    `${eventType} has ${subscribers.length} competing v2 event destinations`,
  );
  return subscribers;
}

export function assertUsageEvidence(evidence, expectedCalls, baseline) {
  invariant(evidence?.payment !== null, "Usage payment projection is missing");
  invariant(evidence?.wallet !== null, "Usage wallet is missing");
  invariant(
    expectedCalls.length === 3 &&
      expectedCalls.reduce((sum, call) => sum + call.cost, 0) === 3,
    "UI, direct, and browser paid calls are required",
  );
  invariant(
    evidence.calls.length === expectedCalls.length,
    "Usage evidence call count changed",
  );
  invariant(
    evidence.interveningEntries.length === expectedCalls.length &&
      evidence.interveningEntries.length <= MAX_PROVIDER_OBJECTS,
    "Usage ledger interval contains missing or unrelated writes",
  );
  invariant(
    evidence.payment.status === "paid",
    "Payment changed before refund",
  );
  invariant(
    evidence.payment.refundedCredits === 0 &&
      evidence.payment.reversedCredits === 0 &&
      evidence.payment.walletReversedCredits === 0 &&
      evidence.payment.publisherClawbackTargetCredits === 0,
    "Payment was reversed before refund proof",
  );
  const expectedByRef = new Map();
  invariant(
    Number.isSafeInteger(baseline.wallet.balance) &&
      Number.isSafeInteger(baseline.wallet.sequence) &&
      baseline.wallet.sequence >= 0,
    "Usage baseline wallet is invalid",
  );
  for (const call of expectedCalls) {
    invariant(
      /^[A-Za-z0-9_-]{8,}$/.test(call.requestId),
      "Paid call request id is invalid",
    );
    invariant(
      Number.isSafeInteger(call.cost) && call.cost > 0,
      "Paid call cost is invalid",
    );
    invariant(call.status === 200, "Paid call did not return 200");
    const refId = `settle:${call.requestId}`;
    invariant(!expectedByRef.has(refId), "Paid call request id was reused");
    expectedByRef.set(refId, call);
  }
  const proofRefs = new Set();
  const intervalByRef = new Map(
    evidence.interveningEntries.map((entry) => [entry.refId, entry]),
  );
  for (const proof of evidence.calls) {
    const expected = expectedByRef.get(proof.entry.refId);
    invariant(expected !== undefined, "Unexpected usage settlement reference");
    invariant(
      !proofRefs.has(proof.entry.refId),
      "Usage proof row was duplicated",
    );
    proofRefs.add(proof.entry.refId);
    invariant(
      proof.entry.kind === "usage_settlement" &&
        proof.entry.amount === -expected.cost &&
        proof.entry.sequence === intervalByRef.get(proof.entry.refId)?.sequence,
      "Usage wallet entry does not match gateway cost",
    );
    invariant(
      proof.usage.settleRefId === proof.entry.refId &&
        proof.usage.credits === expected.cost &&
        proof.usage.status === expected.status &&
        proof.usage.method === expected.method &&
        proof.usage.endpoint === expected.endpoint,
      "Usage event does not match exact gateway call",
    );
    invariant(
      proof.usage.organizationId === evidence.payment.organizationId,
      "Usage charged another organization",
    );
    invariant(
      proof.project.slug === evidence.projectSlug,
      "Usage settled against another project",
    );
  }
  invariant(
    proofRefs.size === expectedByRef.size &&
      [...expectedByRef.keys()].every((refId) => proofRefs.has(refId)),
    "Exact gateway call evidence is incomplete",
  );
  let expectedBalance = baseline.wallet.balance;
  let expectedSequence = baseline.wallet.sequence;
  const intervalRefs = new Set(
    evidence.interveningEntries.map((entry) => entry.refId),
  );
  for (const refId of expectedByRef.keys()) {
    invariant(
      intervalRefs.has(refId),
      "Exact paid call is outside grant-to-usage ledger interval",
    );
  }
  for (const entry of evidence.interveningEntries) {
    invariant(
      entry.kind === "usage_settlement" && entry.amount < 0,
      "Non-usage wallet write appeared during paid journey",
    );
    invariant(expectedByRef.has(entry.refId), "Unrelated usage write appeared");
    invariant(
      entry.sequence === expectedSequence + 1,
      "Usage wallet sequence is not contiguous",
    );
    expectedSequence = entry.sequence;
    expectedBalance += entry.amount;
  }
  invariant(
    evidence.wallet.sequence === expectedSequence &&
      evidence.wallet.balance === expectedBalance,
    "Usage ledger does not materialize to wallet",
  );
  return evidence;
}

function isoMillis(value, label) {
  const milliseconds = Date.parse(value ?? "");
  invariant(
    Number.isFinite(milliseconds) &&
      typeof value === "string" &&
      new Date(milliseconds).toISOString() === value,
    `${label} is not a canonical ISO timestamp`,
  );
  return milliseconds;
}

export function assertDeploymentBinding(
  proof,
  {
    githubSha,
    mode,
    deploymentIds,
    now = Date.now(),
    maxAgeMs = 24 * 60 * 60 * 1_000,
    verificationMaxAgeMs = 60 * 60 * 1_000,
  },
) {
  invariant(
    /^[0-9a-f]{40}$/.test(githubSha ?? ""),
    "Expected Git SHA is invalid",
  );
  invariant(mode === "staging", "Payment proof must target staging mode");
  invariant(
    Number.isSafeInteger(maxAgeMs) &&
      maxAgeMs > 0 &&
      Number.isSafeInteger(verificationMaxAgeMs) &&
      verificationMaxAgeMs > 0,
    "Deployment freshness window is invalid",
  );
  invariant(
    Array.isArray(proof?.manifests) && proof.manifests.length === 3,
    "Web, gateway, and Convex deployment manifests are required",
  );
  const expectedServices = ["web", "gateway", "convex"];
  invariant(
    Object.values(deploymentIds).every((deploymentId) =>
      /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(deploymentId ?? ""),
    ),
    "Expected deployment ids are invalid",
  );
  const seen = new Set();
  const deployedTimes = [];
  for (const manifest of proof.manifests) {
    invariant(
      manifest.schemaVersion === 1 &&
        expectedServices.includes(manifest.service),
      "Deployment manifest schema or service changed",
    );
    invariant(!seen.has(manifest.service), "Deployment service is duplicated");
    seen.add(manifest.service);
    invariant(
      manifest.mode === mode,
      `${manifest.service} deployment mode changed`,
    );
    invariant(
      manifest.gitSha === githubSha,
      `${manifest.service} deployment is stale or from another SHA`,
    );
    invariant(
      manifest.deploymentId === deploymentIds[manifest.service],
      `${manifest.service} immutable deployment id changed`,
    );
    const deployedAt = isoMillis(
      manifest.deployedAt,
      `${manifest.service}.deployedAt`,
    );
    invariant(
      deployedAt <= now + 5 * 60_000,
      "Deployment timestamp is in future",
    );
    invariant(
      now - deployedAt <= maxAgeMs,
      `${manifest.service} deployment is outside freshness window`,
    );
    deployedTimes.push(deployedAt);
  }
  invariant(
    expectedServices.every((service) => seen.has(service)),
    "Deployment manifest set is incomplete",
  );
  invariant(
    new Set(Object.values(deploymentIds)).size === 3,
    "Expected deployment ids must be service-specific",
  );
  const verifiedAt = isoMillis(proof.verifiedAt, "deployment.verifiedAt");
  invariant(
    verifiedAt <= now + 5 * 60_000 && now - verifiedAt <= verificationMaxAgeMs,
    "Deployment verification is stale",
  );
  invariant(
    deployedTimes.every((deployedAt) => deployedAt <= verifiedAt),
    "Deployment manifest was generated after verification",
  );
  return proof;
}

export function assertAppPathEvidence(evidence, expected) {
  const { baseline, onboarding, transfer } = evidence ?? {};
  invariant(
    baseline && onboarding && transfer,
    "App-path evidence is incomplete",
  );
  invariant(
    baseline.organization.clerkOrgId === expected.clerkOrgId &&
      baseline.organization.id === baseline.profile.organizationId,
    "App path used wrong active organization",
  );
  invariant(
    baseline.profile.id === onboarding.profileId &&
      baseline.profile.id === transfer.local.profileId,
    "App path changed payment profile",
  );
  invariant(
    baseline.profile.stripeConnectedAccountId === expected.connectedAccountId &&
      baseline.profile.stripeConnectedAccountId ===
        onboarding.connectedAccountId &&
      baseline.profile.stripeConnectedAccountId ===
        transfer.local.stripeConnectedAccountId,
    "App path changed connected account",
  );
  invariant(
    baseline.profile.payoutsEnabled === true &&
      baseline.profile.disabledReason === null &&
      baseline.openTransferCount === 0 &&
      baseline.balance.availableAtoms >= 1_000_000_000 &&
      baseline.balance.allocatedAtoms === 0 &&
      baseline.journalSums.availableAtoms === baseline.balance.availableAtoms &&
      baseline.journalSums.allocatedAtoms === baseline.balance.allocatedAtoms &&
      baseline.journalSums.paidAtoms === baseline.balance.paidAtoms &&
      baseline.journalSums.entryCount === baseline.balance.sequence &&
      baseline.journalSums.lastSequence === baseline.balance.sequence,
    "App transfer fixture is not eligible or clean",
  );
  invariant(
    onboarding.authenticated === true &&
      onboarding.activeClerkOrgId === expected.clerkOrgId &&
      onboarding.action === "payouts.startOnboarding" &&
      onboarding.apiSurface === "v2.core.accountLinks.create" &&
      onboarding.linkOrigin === "https://connect.stripe.com" &&
      /^[0-9a-f]{64}$/.test(onboarding.linkHash ?? ""),
    "Authenticated v2 Account Links app journey is missing",
  );
  invariant(
    onboarding.provider?.accountId === onboarding.connectedAccountId &&
      onboarding.provider.dashboard === "express" &&
      onboarding.provider.transferCapability === "active" &&
      onboarding.provider.payoutCapability === "active",
    "App onboarding provider account proof is incomplete",
  );
  isoMillis(onboarding.observedAt, "appPath.onboarding.observedAt");

  invariant(
    transfer.ui.authenticated === true &&
      transfer.ui.activeClerkOrgId === expected.clerkOrgId &&
      transfer.ui.action === "payouts.initiatePublisherTransfer",
    "Authenticated transfer UI journey is missing",
  );
  isoMillis(transfer.ui.observedAt, "appPath.transfer.ui.observedAt");
  const local = transfer.local;
  const provider = transfer.provider;
  invariant(
    local.publisherOrganizationId === baseline.organization.id &&
      !baseline.transferIds.includes(local.id),
    "App transfer is stale or belongs to another publisher",
  );
  invariant(
    local.status === "succeeded" &&
      local.stripeTransferId === provider.id &&
      local.platformAccountId === expected.platformAccountId,
    "App transfer did not reach exact local success state",
  );
  invariant(
    /^[0-9a-f]{64}$/.test(local.correlationNonce ?? "") &&
      /^[0-9a-f]{64}$/.test(local.correlationHmac ?? ""),
    "App transfer HMAC material is invalid",
  );
  invariant(
    provider.livemode === false &&
      provider.amount === local.amount &&
      provider.amountReversed === 0 &&
      provider.reversed === false &&
      provider.currency === local.currency &&
      provider.destination === local.stripeConnectedAccountId &&
      provider.platformAccountId === local.platformAccountId,
    "Provider transfer facts do not match local allocation",
  );
  invariant(
    provider.metadata.publisherTransferId === local.id &&
      provider.metadata.correlationNonce === local.correlationNonce &&
      provider.metadata.correlationHmac === local.correlationHmac &&
      provider.metadata.platformAccountId === local.platformAccountId,
    "Provider transfer HMAC metadata correlation failed",
  );
  invariant(
    baseline.balance.availableAtoms ===
      local.amountAtoms + local.remainderAtoms &&
      local.amountAtoms === local.amount * 1_000_000 &&
      local.currency === "usd",
    "App transfer amount/remainder conservation failed",
  );
  const entries = transfer.settlementEntries;
  invariant(
    Array.isArray(entries) && entries.length === 2,
    "App transfer settlement journal is incomplete or unrelated",
  );
  const [allocated, succeeded] = entries;
  invariant(
    allocated.kind === "transfer_allocation" &&
      allocated.refId === `publisher:transfer:${local.id}:allocated` &&
      allocated.availableDeltaAtoms === -local.amountAtoms &&
      allocated.allocatedDeltaAtoms === local.amountAtoms &&
      allocated.paidDeltaAtoms === 0 &&
      allocated.sequence === baseline.balance.sequence + 1 &&
      succeeded.kind === "transfer_succeeded" &&
      succeeded.refId === `publisher:transfer:${local.id}:succeeded` &&
      succeeded.availableDeltaAtoms === 0 &&
      succeeded.allocatedDeltaAtoms === -local.amountAtoms &&
      succeeded.paidDeltaAtoms === local.amountAtoms &&
      succeeded.sequence === allocated.sequence + 1,
    "App transfer journal does not conserve publisher balance",
  );
  invariant(
    transfer.webhook.stripeEventId === transfer.providerEventId &&
      transfer.webhook.eventType === "transfer.created" &&
      transfer.webhook.objectId === provider.id &&
      transfer.webhook.status === "processed" &&
      transfer.webhook.deliveries >= 1,
    "Exact transfer.created webhook receipt is missing",
  );
  return evidence;
}

export function assertCompensationEvidence(compensation, appPath, refund) {
  invariant(
    compensation?.status === "complete",
    "Proof compensation is incomplete",
  );
  const local = appPath.transfer.local;
  invariant(
    compensation.provider.id === local.stripeTransferId &&
      compensation.provider.reversed === true &&
      compensation.provider.amountReversed === local.amount,
    "Provider transfer compensation is incomplete",
  );
  invariant(
    compensation.local.id === local.id &&
      compensation.local.status === "reversed" &&
      compensation.local.reversedAmount === local.amount,
    "Local transfer compensation is incomplete",
  );
  invariant(
    compensation.webhook.stripeEventId === compensation.providerEventId &&
      compensation.webhook.eventType === "transfer.reversed" &&
      compensation.webhook.objectId === local.stripeTransferId &&
      compensation.webhook.status === "processed" &&
      compensation.webhook.deliveries >= 1,
    "Exact transfer.reversed webhook receipt is missing",
  );
  const entries = compensation.settlementEntries;
  invariant(
    Array.isArray(entries) && entries.length === 3,
    "Compensation journal is incomplete or unrelated",
  );
  const reversal = entries[2];
  invariant(
    reversal.kind === "transfer_reversal" &&
      reversal.refId ===
        `publisher:transfer:${local.id}:reversed:${local.amount}` &&
      reversal.availableDeltaAtoms === local.amountAtoms &&
      reversal.allocatedDeltaAtoms === 0 &&
      reversal.paidDeltaAtoms === -local.amountAtoms &&
      reversal.sequence === entries[1].sequence + 1,
    "Transfer reversal journal does not conserve atoms",
  );
  const before = appPath.baseline.balance;
  const after = compensation.publisherBalance;
  const refundPublisher = refund?.publishers?.find(
    (publisher) =>
      publisher.organizationId === appPath.baseline.organization.id,
  );
  invariant(
    refund?.publishers?.length === 1 && refundPublisher !== undefined,
    "Compensation is not bound to exact refund publisher",
  );
  const currentClawbackAtoms = refund.clawbacks.reduce(
    (sum, clawback) =>
      sum + clawback.amountAtoms - (clawback.restoredAtoms ?? 0),
    0,
  );
  invariant(
    refundPublisher.balance.availableAtoms === local.remainderAtoms &&
      refundPublisher.balance.allocatedAtoms === before.allocatedAtoms &&
      refundPublisher.balance.paidAtoms ===
        before.paidAtoms + local.amountAtoms &&
      refundPublisher.balance.pendingRiskAtoms === before.pendingRiskAtoms &&
      refundPublisher.balance.reversedAtoms ===
        before.reversedAtoms + currentClawbackAtoms &&
      refundPublisher.balance.failedAtoms === before.failedAtoms &&
      refundPublisher.balance.sequence === entries[1].sequence,
    "Refund publisher balance includes unrelated settlement writes",
  );
  invariant(
    after.availableAtoms === before.availableAtoms &&
      after.allocatedAtoms === before.allocatedAtoms &&
      after.paidAtoms === before.paidAtoms &&
      after.pendingRiskAtoms === refundPublisher.balance.pendingRiskAtoms &&
      after.reversedAtoms === refundPublisher.balance.reversedAtoms &&
      after.failedAtoms === refundPublisher.balance.failedAtoms &&
      after.sequence === refundPublisher.balance.sequence + 1 &&
      compensation.journalSums.availableAtoms === after.availableAtoms &&
      compensation.journalSums.allocatedAtoms === after.allocatedAtoms &&
      compensation.journalSums.paidAtoms === after.paidAtoms &&
      compensation.journalSums.entryCount === after.sequence &&
      compensation.journalSums.lastSequence === after.sequence,
    "Publisher balance did not return to exact pre-transfer state",
  );
  invariant(
    compensation.payment.status === "refunded" &&
      compensation.payment.reconciliationStatus === "complete" &&
      compensation.canary.deleted === true &&
      compensation.canary.canonicalUnchanged === true &&
      /^we_[A-Za-z0-9]+$/.test(compensation.canary.canonicalEndpointId ?? ""),
    "Payment, reconciliation, or webhook canary cleanup is incomplete",
  );
  return compensation;
}

export function assertAcceptanceReport(report, expected) {
  invariant(
    report?.schemaVersion === 3 &&
      report.reportType === "zevium-stripe-acceptance" &&
      report.acceptance === true &&
      report.status === "passed",
    "Report is not passing Zevium Stripe acceptance schema v3",
  );
  invariant(
    report.run.runRef === expected.runRef &&
      report.run.githubSha === expected.githubSha &&
      report.run.mode === "staging",
    "Acceptance report run binding changed",
  );
  const startedAt = isoMillis(report.run.startedAt, "run.startedAt");
  const completedAt = isoMillis(report.run.completedAt, "run.completedAt");
  invariant(completedAt >= startedAt, "Acceptance run timestamps are inverted");
  assertDeploymentBinding(report.deployment, expected.deployment);
  assertAppPathEvidence(report.appPath, expected.appPath);
  const deploymentVerifiedAt = isoMillis(
    report.deployment.verifiedAt,
    "deployment.verifiedAt",
  );
  const checkoutVerifiedAt = isoMillis(
    report.provider.checkoutVerifiedAt,
    "provider.checkoutVerifiedAt",
  );
  const onboardingVerifiedAt = isoMillis(
    report.appPath.onboarding.provider.verifiedAt,
    "appPath.onboarding.provider.verifiedAt",
  );
  const onboardingObservedAt = isoMillis(
    report.appPath.onboarding.observedAt,
    "appPath.onboarding.observedAt",
  );
  const transferObservedAt = isoMillis(
    report.appPath.transfer.ui.observedAt,
    "appPath.transfer.ui.observedAt",
  );
  const transferVerifiedAt = isoMillis(
    report.appPath.transfer.provider.verifiedAt,
    "appPath.transfer.provider.verifiedAt",
  );
  const usageCapturedAt = isoMillis(
    report.ledger.usage.capturedAt,
    "ledger.usage.capturedAt",
  );
  const partialInitialCapturedAt = isoMillis(
    report.ledger.partial.capturedAt,
    "ledger.partial.capturedAt",
  );
  const canaryDeletedAt = isoMillis(
    report.provider.webhookCanary.canaryDeletedAt,
    "provider.webhookCanary.canaryDeletedAt",
  );
  const canonicalReplayRequestedAt = isoMillis(
    report.provider.webhookCanary.canonicalReplayRequestedAt,
    "provider.webhookCanary.canonicalReplayRequestedAt",
  );
  const partialRefundCapturedAt = isoMillis(
    report.ledger.refundBaseline.capturedAt,
    "ledger.refundBaseline.capturedAt",
  );
  const refundCapturedAt = isoMillis(
    report.ledger.refund.capturedAt,
    "ledger.refund.capturedAt",
  );
  const canaryCleanupVerifiedAt = isoMillis(
    report.compensation.canary.verifiedAt,
    "compensation.canary.verifiedAt",
  );
  const compensationCompletedAt = isoMillis(
    report.compensation.completedAt,
    "compensation.completedAt",
  );
  const orderedEvidenceTimes = [
    deploymentVerifiedAt,
    checkoutVerifiedAt,
    onboardingObservedAt,
    onboardingVerifiedAt,
    transferObservedAt,
    transferVerifiedAt,
    usageCapturedAt,
    partialInitialCapturedAt,
    canaryDeletedAt,
    canonicalReplayRequestedAt,
    partialRefundCapturedAt,
    refundCapturedAt,
    canaryCleanupVerifiedAt,
    compensationCompletedAt,
  ];
  invariant(
    orderedEvidenceTimes.every(
      (timestamp, index) =>
        timestamp >= startedAt &&
        timestamp <= completedAt &&
        (index === 0 || timestamp >= orderedEvidenceTimes[index - 1]),
    ),
    "Acceptance evidence is stale, future-dated, or out of journey order",
  );
  assertUsageEvidence(
    report.ledger.usage,
    report.ledger.usageExpected,
    report.ledger.usageBaseline,
  );
  assertLedgerEvidence(report.ledger.partial, {
    expectedRefundedCredits: 25_000,
    eventId: report.provider.partialRefundEventId,
    minDeliveries: 1,
    maxDeliveries: 1,
    expectedEventType: "charge.refunded",
    expectedObjectId: report.provider.chargeId,
    baseline: report.ledger.usage,
  });
  assertLedgerEvidence(report.ledger.refundBaseline, {
    expectedRefundedCredits: 25_000,
    eventId: report.provider.partialRefundEventId,
    minDeliveries: 2,
    maxDeliveries: 2,
    expectedEventType: "charge.refunded",
    expectedObjectId: report.provider.chargeId,
    baseline: report.ledger.partial,
  });
  assertLedgerEvidence(report.ledger.refund, {
    expectedRefundedCredits: 100_000,
    eventId: report.ledger.refund.event.stripeEventId,
    minDeliveries: 1,
    maxDeliveries: 1,
    expectedEventType: "charge.refunded",
    expectedObjectId: report.provider.chargeId,
    baseline: report.ledger.refundBaseline,
  });
  invariant(
    report.ledger.usage.payment.organizationId ===
      report.appPath.baseline.organization.id,
    "Usage/refund and app path used different organizations",
  );
  const appOrganizationId = report.appPath.baseline.organization.id;
  const usageRefs = new Set(
    report.ledger.usage.calls.map((call) => call.usage.settleRefId),
  );
  const usageProjectIds = new Set(
    report.ledger.usage.calls.map((call) => call.project.id),
  );
  const earningUsageRefs = new Set(
    report.ledger.refund.earnings.map(
      (earning) => earning.usageSettlementRefId,
    ),
  );
  invariant(
    report.ledger.refund.payment.organizationId === appOrganizationId &&
      report.ledger.usage.calls.every(
        (call) =>
          call.usage.organizationId === appOrganizationId &&
          call.project.publisherOrganizationId === appOrganizationId,
      ) &&
      report.ledger.refund.clawbacks.every(
        (clawback) =>
          clawback.consumerOrganizationId === appOrganizationId &&
          clawback.publisherOrganizationId === appOrganizationId,
      ) &&
      report.ledger.refund.earnings.every(
        (earning) =>
          earning.consumerOrganizationId === appOrganizationId &&
          earning.publisherOrganizationId === appOrganizationId &&
          usageRefs.has(earning.usageSettlementRefId) &&
          usageProjectIds.has(earning.projectId),
      ) &&
      earningUsageRefs.size === usageRefs.size &&
      [...usageRefs].every((ref) => earningUsageRefs.has(ref)) &&
      usageProjectIds.size === 1 &&
      report.ledger.refund.publishers.length === 1 &&
      report.ledger.refund.publishers[0].organizationId === appOrganizationId,
    "Consumer, project publisher, earning, and clawback org correlation changed",
  );
  const refundIds = report.provider.refundIds;
  const canary = report.provider.webhookCanary;
  invariant(
    Array.isArray(refundIds) &&
      refundIds.length === 2 &&
      new Set(refundIds).size === 2 &&
      refundIds.every((id) => /^re_[A-Za-z0-9]+$/.test(id)) &&
      report.ledger.refund.exposures.length === refundIds.length &&
      report.ledger.refund.exposures.every((exposure) =>
        refundIds.includes(exposure.sourceRef.slice("stripe:refund:".length)),
      ) &&
      report.ledger.refundBaseline.exposures.length === 1 &&
      report.ledger.refundBaseline.exposures[0].sourceRef ===
        `stripe:refund:${refundIds[0]}` &&
      report.ledger.refundBaseline.event.stripeEventId ===
        report.provider.partialRefundEventId &&
      report.ledger.refund.payment.publisherClawbackTargetCredits === 3 &&
      report.ledger.refund.payment.walletReversedCredits === 99_997 &&
      report.ledger.usageBaseline.wallet.balance === 100_000,
    "Refund exposure rows do not match exact provider refunds",
  );
  invariant(
    canary.eventId === report.provider.partialRefundEventId &&
      /^we_[A-Za-z0-9]+$/.test(canary.canaryEndpointId) &&
      /^we_[A-Za-z0-9]+$/.test(canary.canonicalEndpointId) &&
      canary.canaryEndpointId !== canary.canonicalEndpointId &&
      canary.exactPendingDeliveries === 1 &&
      canary.canonicalReceiptDeliveries === 1 &&
      Array.isArray(canary.exclusiveV1SubscriberIds) &&
      canary.exclusiveV1SubscriberIds.length === 2 &&
      new Set(canary.exclusiveV1SubscriberIds).size === 2 &&
      canary.exclusiveV1SubscriberIds.includes(canary.canaryEndpointId) &&
      canary.exclusiveV1SubscriberIds.includes(canary.canonicalEndpointId) &&
      canary.competingV2SubscriberCount === 0,
    "Refund webhook canary/replay topology correlation changed",
  );
  invariant(
    report.compensation.canary.canonicalEndpointId ===
      canary.canonicalEndpointId,
    "Canonical webhook endpoint changed during compensation",
  );
  invariant(
    report.provider.checkoutSessionId ===
      report.ledger.refund.payment.checkoutSessionId &&
      report.provider.chargeId ===
        report.ledger.refund.payment.stripeChargeId &&
      report.provider.partialRefundEventId ===
        report.ledger.refundBaseline.event.stripeEventId &&
      report.provider.refundEventId ===
        report.ledger.refund.event.stripeEventId,
    "Provider, payment, and webhook refund correlation changed",
  );
  invariant(
    report.primitives.acceptanceRole === "supplemental_only" &&
      report.primitives.requiredForAcceptance === false,
    "Direct Stripe primitives were promoted to acceptance evidence",
  );
  assertCompensationEvidence(
    report.compensation,
    report.appPath,
    report.ledger.refund,
  );
  return report;
}
