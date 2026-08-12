export const STRIPE_API_VERSION = "2026-06-24.dahlia";
export const MAX_PROVIDER_OBJECTS = 500;

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
  invariant(expectedCalls.length > 0, "Expected paid calls are missing");
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
  for (const proof of evidence.calls) {
    const expected = expectedByRef.get(proof.entry.refId);
    invariant(expected !== undefined, "Unexpected usage settlement reference");
    invariant(
      proof.entry.kind === "usage_settlement" &&
        proof.entry.amount === -expected.cost,
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
