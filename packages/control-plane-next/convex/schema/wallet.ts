import { defineTable } from "convex/server";
import { v } from "convex/values";
import { jobState, lotState, sourceKind } from "./common";
const walletEntryFields = {
  walletId: v.id("wallets"),
  refId: v.string(),
  sequence: v.number(),
  balanceAfter: v.number(),
  createdAt: v.number(),
  immutableFingerprint: v.string(),
};
const paymentAdjustmentFields = {
  paymentId: v.id("payments"),
  providerSourceRef: v.string(),
  principalCents: v.number(),
  feeCents: v.number(),
  requestedCredits: v.number(),
  effectiveCredits: v.number(),
  fundsWithdrawn: v.boolean(),
  fundsReinstated: v.boolean(),
  revision: v.number(),
  appliedWalletCredits: v.number(),
  appliedPublisherCredits: v.number(),
  cursor: v.optional(v.string()),
  closeId: v.optional(v.string()),
  closeGeneration: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
};
export const walletTables = {
  wallets: defineTable({
    ownerKey: v.string(),
    balance: v.number(),
    sequence: v.number(),
    promoCredits: v.number(),
    epoch: v.number(),
    gateState: v.union(
      v.literal("open"),
      v.literal("closing"),
      v.literal("closed"),
    ),
    gateRevision: v.number(),
    settledThroughEdgeSequence: v.number(),
    nextExpiryAt: v.optional(v.number()),
    owner: v.object({
      kind: v.literal("org"),
      organizationId: v.id("organizations"),
      clerkOrgId: v.string(),
    }),
    close: v.optional(
      v.object({
        id: v.string(),
        requestedAt: v.number(),
        reason: v.union(
          v.literal("refund"),
          v.literal("dispute"),
          v.literal("expiry"),
          v.literal("archive"),
          v.literal("admin"),
          v.literal("dust_merge"),
        ),
        edgeFinalSequence: v.optional(v.number()),
        settledThrough: v.optional(v.number()),
        ackAt: v.optional(v.number()),
        ackFingerprint: v.optional(v.string()),
        abandoned: v.optional(v.boolean()),
        command: v.optional(
          v.object({ credits: v.number(), fingerprint: v.string() }),
        ),
      }),
    ),
  })
    .index("by_owner", ["ownerKey"])
    .index("by_gate", ["gateState"])
    .index("by_expiry", ["nextExpiryAt"]),
  walletEntries: defineTable(
    v.union(
      v.object({
        ...walletEntryFields,
        kind: v.union(v.literal("grant"), v.literal("promo")),
        amount: v.number(),
        lotId: v.id("fundingLots"),
        originLotId: v.id("fundingLots"),
        paymentId: v.optional(v.id("payments")),
      }),
      v.object({
        ...walletEntryFields,
        kind: v.literal("usage"),
        amount: v.number(),
        usageEventId: v.id("usageEvents"),
      }),
      v.object({
        ...walletEntryFields,
        kind: v.union(v.literal("reversal"), v.literal("restoration")),
        amount: v.number(),
        lotId: v.id("fundingLots"),
        originLotId: v.id("fundingLots"),
        paymentId: v.optional(v.id("payments")),
        requestFingerprint: v.optional(v.string()),
        closeId: v.optional(v.string()),
        adjustment: v.union(
          v.object({
            kind: v.literal("payment"),
            id: v.id("paymentAdjustments"),
          }),
          // Admin adjustments are canonical immutable per-source journal facts.
          v.object({ kind: v.literal("admin"), ref: v.string() }),
        ),
      }),
      v.object({
        ...walletEntryFields,
        kind: v.literal("lot_move"),
        fromLotId: v.id("fundingLots"),
        toLotId: v.id("fundingLots"),
        originLotId: v.id("fundingLots"),
        sourceRef: v.string(),
        paymentId: v.optional(v.id("payments")),
        movedCredits: v.number(),
        reason: v.literal("dust_merge"),
        mergeId: v.string(),
        amount: v.literal(0),
      }),
      v.object({
        ...walletEntryFields,
        kind: v.literal("expiry"),
        amount: v.number(),
        lotId: v.id("fundingLots"),
        originLotId: v.id("fundingLots"),
        breakageCredits: v.number(),
      }),
    ),
  )
    .index("by_ref", ["refId"])
    .index("by_wallet_sequence", ["walletId", "sequence"])
    .index("by_payment", ["paymentId", "sequence"])
    .index("by_move_source", ["originLotId", "sequence"])
    .index("by_merge", ["mergeId", "sequence"])
    .index("by_admin_adjustment", [
      "walletId",
      "adjustment.kind",
      "adjustment.ref",
      "sequence",
    ]),
  fundingLots: defineTable({
    // Filled with own ID before the creating mutation commits; Convex cannot index _id directly.
    orderKey: v.optional(v.id("fundingLots")),
    walletId: v.id("wallets"),
    sourceRef: v.string(),
    sourceKind: sourceKind,
    paymentId: v.optional(v.id("payments")),
    grantedCredits: v.number(),
    movedInCredits: v.number(),
    movedOutCredits: v.number(),
    remainingCredits: v.number(),
    consumedCredits: v.number(),
    reversedCredits: v.number(),
    expiredCredits: v.number(),
    refundable: v.boolean(),
    priority: v.number(),
    createdAt: v.number(),
    // Writers must parse lotCompatibility: "never" or `at:${expiresAt}`.
    expiryClass: v.string(),
    expiresAt: v.optional(v.number()),
    state: lotState,
    merge: v.optional(
      v.object({
        id: v.string(),
        toLotId: v.id("fundingLots"),
        state: v.union(
          v.literal("pending"),
          v.literal("moving"),
          v.literal("complete"),
        ),
        cursor: v.optional(v.string()),
        generation: v.number(),
      }),
    ),
  })
    .index("by_source", ["sourceRef"])
    .index("by_spend", [
      "walletId",
      "state",
      "priority",
      "createdAt",
      "orderKey",
    ])
    .index("by_payment", ["paymentId"])
    .index("by_merge_target", [
      "walletId",
      "expiryClass",
      "sourceKind",
      "refundable",
      "priority",
      "state",
      "createdAt",
      "orderKey",
    ])
    .index("by_merge_due", ["merge.state"])
    .index("by_expiry", ["state", "expiresAt"]),
  fundingLotSources: defineTable({
    walletId: v.id("wallets"),
    lotId: v.id("fundingLots"),
    originLotId: v.id("fundingLots"),
    sourceRef: v.string(),
    paymentId: v.optional(v.id("payments")),
    sourceCreatedAt: v.number(),
    creditsIn: v.number(),
    creditsOut: v.number(),
    remainingCredits: v.number(),
    consumedCredits: v.number(),
    reversedCredits: v.number(),
    expiredCredits: v.number(),
    state: lotState,
  })
    .index("by_lot_origin", ["lotId", "originLotId"])
    .index("by_lot_spend", ["lotId", "state", "sourceCreatedAt", "originLotId"])
    .index("by_origin", ["originLotId", "lotId"])
    .index("by_payment", ["paymentId", "lotId"]),
  checkoutIntents: defineTable({
    organizationId: v.id("organizations"),
    packId: v.union(
      v.literal("pack_10"),
      v.literal("pack_50"),
      v.literal("pack_100"),
    ),
    credits: v.number(),
    creditFaceValueCents: v.number(),
    processingFeeQuotedCents: v.number(),
    totalCents: v.number(),
    currency: v.literal("usd"),
    feePolicyVersion: v.string(),
    feeQuoteExpiresAt: v.number(),
    stripeCreditPriceId: v.string(),
    feeLinePriceId: v.optional(v.string()),
    stripeCustomerId: v.string(),
    sessionId: v.optional(v.string()),
    paymentIntentId: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("open"),
      v.literal("paid"),
      v.literal("expired"),
      v.literal("failed"),
    ),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_org_time", ["organizationId", "createdAt"])
    .index("by_payment_intent", ["paymentIntentId"]),
  payments: defineTable({
    walletId: v.id("wallets"),
    rail: v.literal("stripe"),
    providerPaymentRef: v.string(),
    checkoutIntentId: v.optional(v.id("checkoutIntents")),
    stripeChargeId: v.optional(v.string()),
    providerAccount: v.string(),
    livemode: v.boolean(),
    currency: v.literal("usd"),
    creditFaceValueCents: v.number(),
    processingFeeChargedCents: v.number(),
    processingFeeActualCents: v.optional(v.number()),
    processingFeeVarianceCents: v.optional(v.number()),
    feePolicyVersion: v.string(),
    refundFeePolicy: v.literal("full_paid_amount"),
    amountPaidCents: v.number(),
    credits: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("paid"),
      v.literal("failed"),
      v.literal("partially_refunded"),
      v.literal("refunded"),
      v.literal("disputed"),
    ),
    refundedCredits: v.number(),
    disputedCredits: v.number(),
    effectiveReversedCredits: v.number(),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    reconciliation: v.object({
      state: jobState,
      targetCredits: v.number(),
      walletReversedCredits: v.number(),
      publisherTargetCredits: v.number(),
      cursor: v.optional(v.string()),
      generation: v.number(),
      nextAttemptAt: v.optional(v.number()),
    }),
  })
    .index("by_provider", ["rail", "providerAccount", "providerPaymentRef"])
    .index("by_charge", ["stripeChargeId"])
    .index("by_wallet_time", ["walletId", "createdAt"])
    .index("by_reconcile", [
      "reconciliation.state",
      "reconciliation.nextAttemptAt",
    ]),
  paymentAdjustments: defineTable(
    v.union(
      v.object({
        ...paymentAdjustmentFields,
        kind: v.literal("refund"),
        status: v.union(
          v.literal("pending"),
          v.literal("requires_action"),
          v.literal("succeeded"),
          v.literal("failed"),
          v.literal("canceled"),
        ),
      }),
      v.object({
        ...paymentAdjustmentFields,
        kind: v.literal("dispute"),
        status: v.union(v.literal("open"), v.literal("won"), v.literal("lost")),
      }),
    ),
  )
    .index("by_source", ["kind", "providerSourceRef"])
    .index("by_payment", ["paymentId", "createdAt"]),
  webhookReceipts: defineTable({
    provider: v.union(v.literal("stripe"), v.literal("clerk")),
    account: v.string(),
    eventId: v.string(),
    payloadHash: v.optional(v.string()),
    eventType: v.string(),
    objectId: v.string(),
    sourceTimestamp: v.number(),
    receivedAt: v.number(),
    state: jobState,
    attempts: v.number(),
    deliveries: v.number(),
    leaseToken: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    nextAttemptAt: v.optional(v.number()),
    processedAt: v.optional(v.number()),
    errorCode: v.optional(v.string()),
    facts: v.optional(
      v.union(
        v.object({
          kind: v.literal("clerk_delete"),
          clerkId: v.string(),
          deletedAt: v.number(),
        }),
        v.object({
          kind: v.literal("dispute_movement"),
          disputeId: v.string(),
          movement: v.union(
            v.literal("withdrawal"),
            v.literal("reinstatement"),
          ),
          amountCents: v.number(),
          currency: v.literal("usd"),
        }),
      ),
    ),
  })
    .index("by_event", ["provider", "account", "eventId"])
    .index("by_due", ["state", "nextAttemptAt"])
    .index("by_lease", ["state", "leaseUntil"])
    .index("by_object", ["provider", "account", "objectId", "sourceTimestamp"]),
};
