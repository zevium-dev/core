import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExclusiveEndpointTopology,
  assertLedgerEvidence,
  assertNoCompetingEventDestinations,
  assertPendingCanaryEvent,
  assertUsageEvidence,
  endpointAccepts,
  normalizeRunRef,
  requireTestStripeKey,
} from "./stripe-provider-proof-lib.mjs";

test("accepts restricted sandbox keys and rejects broad/live keys", () => {
  assert.equal(
    requireTestStripeKey({ KEY: "rk_test_restricted" }, "KEY"),
    "rk_test_restricted",
  );
  assert.throws(() =>
    requireTestStripeKey({ KEY: "sk_test_too_broad" }, "KEY"),
  );
  assert.throws(() => requireTestStripeKey({ KEY: "sk_live_nope" }, "KEY"));
  assert.throws(() => requireTestStripeKey({ KEY: "rk_live_nope" }, "KEY"));
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

function evidence(overrides = {}) {
  return {
    payment: {
      status: "partially_refunded",
      amount: 1_000,
      currency: "usd",
      grantedCredits: 100_000,
      refundedAmount: 250,
      refundedCredits: 25_000,
      reversedCredits: 25_000,
      walletReversedCredits: 24_998,
      publisherClawbackTargetCredits: 2,
    },
    wallet: { balance: 75_000, sequence: 4 },
    event: {
      stripeEventId: "evt_refund",
      eventType: "charge.refunded",
      objectId: "ch_refund",
      status: "processed",
      deliveries: 2,
      attempts: 1,
    },
    reversalJournalCredits: 24_998,
    disputeCount: 0,
    ...overrides,
  };
}

test("proves exact ledger conservation and duplicate delivery receipt", () => {
  const baseline = {
    payment: { walletReversedCredits: 0 },
    wallet: { balance: 99_998 },
  };
  assert.doesNotThrow(() =>
    assertLedgerEvidence(evidence(), {
      expectedRefundedCredits: 25_000,
      eventId: "evt_refund",
      minDeliveries: 2,
      expectedEventType: "charge.refunded",
      expectedObjectId: "ch_refund",
      baseline,
    }),
  );
});

test("rejects delayed replay, unrelated wallet writes, and broken journals", () => {
  const baseline = {
    payment: { walletReversedCredits: 0 },
    wallet: { balance: 99_998 },
  };
  assert.throws(() =>
    assertLedgerEvidence(
      evidence({ event: { ...evidence().event, deliveries: 1 } }),
      {
        expectedRefundedCredits: 25_000,
        eventId: "evt_refund",
        minDeliveries: 2,
        expectedEventType: "charge.refunded",
        expectedObjectId: "ch_refund",
        baseline,
      },
    ),
  );
  assert.throws(() =>
    assertLedgerEvidence(
      evidence({ wallet: { balance: 74_999, sequence: 4 } }),
      {
        expectedRefundedCredits: 25_000,
        eventId: "evt_refund",
        minDeliveries: 2,
        expectedEventType: "charge.refunded",
        expectedObjectId: "ch_refund",
        baseline,
      },
    ),
  );
  assert.throws(() =>
    assertLedgerEvidence(evidence({ reversalJournalCredits: 1 }), {
      expectedRefundedCredits: 25_000,
      eventId: "evt_refund",
      minDeliveries: 2,
      expectedEventType: "charge.refunded",
      expectedObjectId: "ch_refund",
      baseline,
    }),
  );
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
  const expectedCalls = [
    {
      requestId: "ui_request",
      cost: 1,
      status: 200,
      method: "GET",
      endpoint: "/get",
    },
    {
      requestId: "request_1",
      cost: 1,
      status: 200,
      method: "GET",
      endpoint: "/get",
    },
    {
      requestId: "request_2",
      cost: 1,
      status: 200,
      method: "GET",
      endpoint: "/get",
    },
  ];
  const usageProof = {
    payment: {
      organizationId: "org_consumer",
      status: "paid",
      refundedCredits: 0,
      reversedCredits: 0,
      walletReversedCredits: 0,
      publisherClawbackTargetCredits: 0,
    },
    projectSlug: "weather",
    wallet: { balance: 99_997, sequence: 5 },
    calls: expectedCalls.map((call, index) => ({
      entry: {
        refId: `settle:${call.requestId}`,
        kind: "usage_settlement",
        amount: -call.cost,
      },
      usage: {
        settleRefId: `settle:${call.requestId}`,
        credits: call.cost,
        status: call.status,
        method: call.method,
        endpoint: call.endpoint,
        organizationId: "org_consumer",
      },
      project: { slug: "weather" },
      index,
    })),
    interveningEntries: [
      {
        refId: "settle:ui_request",
        kind: "usage_settlement",
        amount: -1,
        sequence: 3,
      },
      {
        refId: "settle:request_1",
        kind: "usage_settlement",
        amount: -1,
        sequence: 4,
      },
      {
        refId: "settle:request_2",
        kind: "usage_settlement",
        amount: -1,
        sequence: 5,
      },
    ],
  };
  const baseline = { wallet: { balance: 100_000, sequence: 2 } };
  assert.doesNotThrow(() =>
    assertUsageEvidence(usageProof, expectedCalls, baseline),
  );
  assert.throws(() =>
    assertUsageEvidence(
      {
        ...usageProof,
        interveningEntries: [
          ...usageProof.interveningEntries,
          {
            refId: "admin:noise",
            kind: "admin_adjustment",
            amount: -1,
            sequence: 6,
          },
        ],
        wallet: { balance: 99_996, sequence: 6 },
      },
      expectedCalls,
      baseline,
    ),
  );
});
