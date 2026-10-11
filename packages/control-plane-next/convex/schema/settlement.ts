import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  billingOutcome,
  qualityOutcome,
  pricingDecision,
  fundingSlice,
} from "./common";
export const settlementTables = {
  usageEvents: defineTable({
    publicId: v.string(),
    walletId: v.id("wallets"),
    consumerOrganizationId: v.id("organizations"),
    ownerUserId: v.optional(v.string()),
    publisherOrganizationId: v.id("organizations"),
    projectId: v.id("projects"),
    specVersionId: v.id("specVersions"),
    operationId: v.string(),
    method: v.string(),
    endpoint: v.string(),
    projectName: v.string(),
    projectSlug: v.string(),
    at: v.number(),
    status: v.number(),
    latencyMs: v.number(),
    settleRefId: v.string(),
    reservationId: v.string(),
    epoch: v.number(),
    edgeSequence: v.number(),
    admissionFingerprint: v.string(),
    pricingDecision: pricingDecision,
    listedCostCredits: v.number(),
    heldCredits: v.number(),
    credits: v.number(),
    billingOutcome: billingOutcome,
    qualityOutcome: qualityOutcome,
    ambiguous: v.boolean(),
    keyId: v.optional(v.string()),
    keyFamilyId: v.optional(v.string()),
    budgetPeriod: v.optional(v.string()),
    budgetUsedBefore: v.optional(v.number()),
    budgetReservedBefore: v.optional(v.number()),
    monthlyCapCredits: v.optional(v.number()),
    freeTierLimit: v.optional(v.number()),
    freeTierUsedBefore: v.optional(v.number()),
    publisherIdempotencyKey: v.optional(v.string()),
    fundingSlices: v.array(fundingSlice),
  })
    .index("by_ref", ["settleRefId"])
    .index("by_wallet_edge", ["walletId", "epoch", "edgeSequence"])
    .index("by_org_time", ["consumerOrganizationId", "at"])
    .index("by_org_owner_time", ["consumerOrganizationId", "ownerUserId", "at"])
    .index("by_org_key_time", ["consumerOrganizationId", "keyId", "at"])
    .index("by_org_project_time", ["consumerOrganizationId", "projectId", "at"])
    .index("by_project_time", ["projectId", "at"])
    .index("by_public", ["publicId"]),
  usageRollups: defineTable(
    v.union(
      v.object({
        scope: v.union(
          v.literal("consumer"),
          v.literal("publisher"),
          v.literal("platform"),
        ),
        scopeId: v.string(),
        dimension: v.union(
          v.literal("total"),
          v.literal("member"),
          v.literal("key"),
          v.literal("project"),
          v.literal("endpoint"),
        ),
        dimensionKey: v.string(),
        shard: v.number(),
        calls: v.number(),
        grossCredits: v.number(),
        netAtoms: v.number(),
        pendingRiskAtoms: v.number(),
        reversedAtoms: v.number(),
        failedAtoms: v.number(),
        updatedAt: v.number(),
        kind: v.literal("daily"),
        day: v.string(),
        success: v.number(),
        errors4xx: v.number(),
        errors5xx: v.number(),
        latencyHistogram: v.array(v.number()),
      }),
      v.object({
        scope: v.union(
          v.literal("consumer"),
          v.literal("publisher"),
          v.literal("platform"),
        ),
        scopeId: v.string(),
        dimension: v.union(
          v.literal("total"),
          v.literal("member"),
          v.literal("key"),
          v.literal("project"),
          v.literal("endpoint"),
        ),
        dimensionKey: v.string(),
        shard: v.number(),
        calls: v.number(),
        grossCredits: v.number(),
        netAtoms: v.number(),
        pendingRiskAtoms: v.number(),
        reversedAtoms: v.number(),
        failedAtoms: v.number(),
        updatedAt: v.number(),
        kind: v.literal("lifetime"),
      }),
      v.object({
        kind: v.literal("lifetime"),
        consumerOrganizationId: v.id("organizations"),
        projectId: v.id("projects"),
        firstSuccessAt: v.number(),
        lastSuccessAt: v.number(),
        successfulCalls: v.number(),
        noticeRevision: v.number(),
        updatedAt: v.number(),
      }),
    ),
  )
    .index("by_daily", [
      "kind",
      "scope",
      "scopeId",
      "day",
      "dimension",
      "dimensionKey",
      "shard",
    ])
    .index("by_consumer_project", [
      "kind",
      "consumerOrganizationId",
      "projectId",
    ])
    .index("by_project_consumers", [
      "kind",
      "projectId",
      "consumerOrganizationId",
    ])
    .index("by_lifetime", [
      "kind",
      "scope",
      "scopeId",
      "dimension",
      "dimensionKey",
      "shard",
    ]),
  publisherEarnings: defineTable({
    publisherOrganizationId: v.id("organizations"),
    projectId: v.id("projects"),
    paymentId: v.optional(v.id("payments")),
    sourceRef: v.string(),
    day: v.string(),
    shard: v.number(),
    grossCredits: v.number(),
    platformFeeAtoms: v.number(),
    netAtoms: v.number(),
    clawedBackGrossCredits: v.number(),
    clawedBackAtoms: v.number(),
    releasedAtoms: v.number(),
    availableAt: v.number(),
    state: v.union(v.literal("pending"), v.literal("released")),
    adjustmentGeneration: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_bucket", [
      "publisherOrganizationId",
      "projectId",
      "sourceRef",
      "day",
      "shard",
    ])
    .index("by_payment", ["paymentId", "day"])
    .index("by_due", ["state", "availableAt"])
    .index("by_publisher_day", ["publisherOrganizationId", "day"]),
  publisherBalances: defineTable({
    publisherOrganizationId: v.id("organizations"),
    availableAtoms: v.number(),
    allocatedAtoms: v.number(),
    paidAtoms: v.number(),
    reversedAtoms: v.number(),
    sequence: v.number(),
    transferSequence: v.number(),
    updatedAt: v.number(),
  }).index("by_publisher", ["publisherOrganizationId"]),
  publisherLedgerEntries: defineTable({
    publisherOrganizationId: v.id("organizations"),
    refId: v.string(),
    sequence: v.number(),
    kind: v.union(
      v.literal("release"),
      v.literal("allocate"),
      v.literal("paid"),
      v.literal("failure"),
      v.literal("reversal"),
      v.literal("restoration"),
      v.literal("transfer_reversal"),
    ),
    availableDeltaAtoms: v.number(),
    allocatedDeltaAtoms: v.number(),
    paidDeltaAtoms: v.number(),
    earningId: v.optional(v.id("publisherEarnings")),
    transferId: v.optional(v.id("publisherTransfers")),
    paymentId: v.optional(v.id("payments")),
    adjustmentId: v.optional(v.id("paymentAdjustments")),
    grossReversedCredits: v.optional(v.number()),
    platformDeltaAtoms: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_ref", ["refId"])
    .index("by_publisher_sequence", ["publisherOrganizationId", "sequence"])
    .index("by_transfer", ["transferId", "sequence"])
    .index("by_adjustment", ["adjustmentId", "sequence"]),
  publisherTransfers: defineTable({
    publisherOrganizationId: v.id("organizations"),
    destination: v.string(),
    platformAccountId: v.string(),
    livemode: v.boolean(),
    currency: v.literal("usd"),
    amountCents: v.number(),
    amountAtoms: v.number(),
    reversedCents: v.number(),
    idempotencyKey: v.string(),
    requestFingerprint: v.string(),
    operationNonce: v.string(),
    stripeTransferId: v.optional(v.string()),
    status: v.union(
      v.literal("created"),
      v.literal("pending"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("reversed"),
    ),
    dispatchState: v.union(
      v.literal("prepared"),
      v.literal("dispatching"),
      v.literal("retry"),
      v.literal("reconciling"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("needs_review"),
    ),
    attempts: v.number(),
    leaseToken: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    firstAttemptAt: v.optional(v.number()),
    safeRetryUntil: v.optional(v.number()),
    nextAttemptAt: v.optional(v.number()),
    providerCursor: v.optional(v.string()),
    failureCode: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_publisher_time", ["publisherOrganizationId", "createdAt"])
    .index("by_idempotency", ["idempotencyKey"])
    .index("by_stripe", ["stripeTransferId"])
    .index("by_due", ["dispatchState", "nextAttemptAt"])
    .index("by_status", ["status", "createdAt"]),
};
