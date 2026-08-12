import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Mirror of Clerk orgs (Clerk is auth truth; app data keys off clerkOrgId)
  organizations: defineTable({
    clerkOrgId: v.string(),
    name: v.string(),
    /** Clerk identity mirror; never emitted into public routing contracts. */
    slug: v.string(),
    /** Stable, publisher-controlled public URL segment. */
    publicHandle: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    archivedAt: v.optional(v.number()),
  })
    .index("by_clerk_org", ["clerkOrgId"])
    .index("by_slug", ["slug"])
    .index("by_public_handle", ["publicHandle"]),

  // Mirror of Clerk users
  users: defineTable({
    clerkUserId: v.string(),
    name: v.string(),
    email: v.string(),
  }).index("by_clerk_user", ["clerkUserId"]),

  projects: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    status: v.union(v.literal("draft"), v.literal("published")),
    visibility: v.union(v.literal("private"), v.literal("public")),
    tags: v.array(v.string()),
  })
    .index("by_org", ["organizationId"])
    .index("by_org_slug", ["organizationId", "slug"])
    .index("by_visibility_status", ["visibility", "status"]),

  // Publisher-owned headers injected by gateway after consumer auth headers are stripped.
  // Values never return through member-facing queries after write.
  upstreamCredentials: defineTable({
    projectId: v.id("projects"),
    name: v.string(),
    // Transitional rollout: legacy plaintext rows are migrated then these
    // optional fields become required in the next schema tightening.
    ciphertext: v.optional(v.string()),
    iv: v.optional(v.string()),
    keyVersion: v.optional(v.string()),
    secret: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_name", ["projectId", "name"]),

  publishReadiness: defineTable({
    projectId: v.id("projects"),
    draftHash: v.string(),
    serverOrigin: v.string(),
    credentialRevision: v.number(),
    status: v.literal("ok"),
    testedAt: v.number(),
  }).index("by_project", ["projectId"]),

  // Mutable draft OpenAPI document per project
  specs: defineTable({
    projectId: v.id("projects"),
    draft: v.string(),
    lastSavedAt: v.number(),
  }).index("by_project", ["projectId"]),

  // Immutable published OpenAPI versions
  specVersions: defineTable({
    projectId: v.id("projects"),
    version: v.string(),
    spec: v.string(),
    publishedAt: v.number(),
    /** Set when a version is deprecated (metadata only — spec body immutable). */
    deprecatedAt: v.optional(v.number()),
    /** Scheduled hard-cutoff time (metadata only). */
    sunsetAt: v.optional(v.number()),
    /** Publisher-facing deprecation reason / migration guidance. */
    deprecationMessage: v.optional(v.string()),
  })
    .index("by_project", ["projectId"])
    .index("by_project_version", ["projectId", "version"])
    .index("by_project_published", ["projectId", "publishedAt"]),

  // One wallet per org; balance is materialized from ledger entries
  wallets: defineTable({
    organizationId: v.id("organizations"),
    balance: v.number(),
    /** Monotonic ledger version for edge checkpoint reconciliation. */
    sequence: v.number(),
    /** Transitional legacy field. Verified finance-v2 wallets require zero. */
    debtCredits: v.optional(v.number()),
  }).index("by_organization", ["organizationId"]),

  // Append-only, signed credit ledger. `amount` is never inferred from kind.
  walletEntries: defineTable({
    walletId: v.id("wallets"),
    kind: v.union(
      v.literal("payment_grant"),
      v.literal("usage_settlement"),
      v.literal("refund_reversal"),
      v.literal("dispute_reversal"),
      v.literal("refund_restoration"),
      v.literal("dispute_restoration"),
      v.literal("admin_adjustment"),
    ),
    amount: v.number(),
    /** Globally unique business id; duplicate delivery is a no-op. */
    refId: v.string(),
    /** Wallet sequence after this entry was atomically materialized. */
    sequence: v.number(),
    paymentId: v.optional(v.id("payments")),
    usageEventId: v.optional(v.id("usageEvents")),
    /** Canonical immutable settlement binding; optional only for legacy rows. */
    settlementFingerprint: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_wallet", ["walletId"])
    .index("by_wallet_sequence", ["walletId", "sequence"])
    .index("by_ref", ["refId"]),

  // Payment grants are fungible at wallet level but retain FIFO funding-lot
  // attribution so refunds consume unspent value before publisher liability.
  paymentFundingLots: defineTable({
    paymentId: v.id("payments"),
    organizationId: v.id("organizations"),
    grantedCredits: v.number(),
    availableCredits: v.number(),
    walletReversedCredits: v.optional(v.number()),
    state: v.union(v.literal("available"), v.literal("depleted")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_payment", ["paymentId"])
    .index("by_org_state_created", ["organizationId", "state", "createdAt"]),

  // One usage settlement may draw from multiple payment lots. These immutable
  // allocations cap which publisher earnings a refunded payment can claw back.
  paymentFundingAllocations: defineTable({
    paymentId: v.id("payments"),
    fundingLotId: v.id("paymentFundingLots"),
    earningId: v.id("publisherEarnings"),
    usageEventId: v.optional(v.id("usageEvents")),
    grossCredits: v.number(),
    clawedBackGrossCredits: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_payment", ["paymentId", "createdAt"])
    .index("by_earning", ["earningId"]),

  // Universal funding inventory. Every positive wallet ledger source gets a
  // lot. Non-refundable inventory is consumed before refundable FIFO lots.
  walletFundingLots: defineTable({
    walletId: v.id("wallets"),
    organizationId: v.id("organizations"),
    sourceKind: v.union(
      v.literal("stripe_payment"),
      v.literal("promotion"),
      v.literal("admin_adjustment"),
      v.literal("restoration"),
      v.literal("compaction"),
    ),
    sourceRef: v.string(),
    paymentId: v.optional(v.id("payments")),
    refundable: v.boolean(),
    grantedCredits: v.number(),
    availableCredits: v.number(),
    allocatedCredits: v.number(),
    reversedCredits: v.number(),
    /** Available inventory moved into a derived compacted lot. */
    compactedCredits: v.optional(v.number()),
    state: v.union(
      v.literal("available"),
      v.literal("depleted"),
      v.literal("compacted"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_source_ref", ["sourceRef"])
    .index("by_wallet_created", ["walletId", "createdAt"])
    .index("by_payment_created", ["paymentId", "createdAt"])
    .index("by_org_priority_state_created", [
      "organizationId",
      "refundable",
      "state",
      "createdAt",
    ])
    .index("by_payment_state_created", ["paymentId", "state", "createdAt"]),

  // Materialized queue totals make settlement preflight O(1). Lot fan-out is
  // separately hard-capped before any financial write.
  walletFundingStates: defineTable({
    walletId: v.id("wallets"),
    organizationId: v.id("organizations"),
    nonrefundableAvailableCredits: v.number(),
    refundableAvailableCredits: v.number(),
    allocatedCredits: v.number(),
    reversedCredits: v.number(),
    sequence: v.number(),
    /** Missing means legacy/unverified. Runtime accepts only `verified`. */
    migrationStatus: v.optional(
      v.union(v.literal("building"), v.literal("verified")),
    ),
    migrationJobId: v.optional(v.id("financialMigrationJobs")),
    migrationWatermarkSequence: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_wallet", ["walletId"])
    .index("by_organization", ["organizationId"]),

  // Immutable debit attribution. Missing fundingLotId / reservation_debt are
  // legacy-only shapes rejected by finance-v2 verification; new debits are
  // always fully source-backed.
  walletFundingAllocations: defineTable({
    walletId: v.id("wallets"),
    organizationId: v.id("organizations"),
    fundingLotId: v.optional(v.id("walletFundingLots")),
    paymentId: v.optional(v.id("payments")),
    walletEntryId: v.id("walletEntries"),
    usageEventId: v.optional(v.id("usageEvents")),
    earningId: v.optional(v.id("publisherEarnings")),
    kind: v.union(
      v.literal("usage"),
      v.literal("negative_adjustment"),
      v.literal("reservation_debt"),
    ),
    grossCredits: v.number(),
    clawedBackGrossCredits: v.number(),
    createdAt: v.number(),
  })
    .index("by_wallet_entry", ["walletEntryId"])
    .index("by_wallet_created", ["walletId", "createdAt"])
    .index("by_lot_created", ["fundingLotId", "createdAt"])
    .index("by_payment_created", ["paymentId", "createdAt"])
    .index("by_earning", ["earningId"]),

  // External refund/dispute debits consume payment inventory but create no
  // usage earning. This immutable journal makes migration and replay exact.
  walletFundingReversals: defineTable({
    walletId: v.id("wallets"),
    organizationId: v.id("organizations"),
    walletEntryId: v.id("walletEntries"),
    paymentId: v.id("payments"),
    grossCredits: v.number(),
    createdAt: v.number(),
  })
    .index("by_wallet_entry", ["walletEntryId"])
    .index("by_wallet_created", ["walletId", "createdAt"])
    .index("by_payment_created", ["paymentId", "createdAt"]),

  // Derived-lot lineage. Compaction changes write fan-out, never provenance.
  walletFundingLotComponents: defineTable({
    walletId: v.id("wallets"),
    compactedLotId: v.id("walletFundingLots"),
    sourceLotId: v.id("walletFundingLots"),
    grossCredits: v.number(),
    createdAt: v.number(),
  })
    .index("by_compacted_lot", ["compactedLotId", "sourceLotId"])
    .index("by_source_lot", ["sourceLotId"])
    .index("by_wallet_created", ["walletId", "createdAt"]),

  // Compact per-source/per-publisher totals. Refund reconciliation reads this
  // rollup, then advances a bounded detail journal instead of scanning history.
  fundingAllocationRollups: defineTable({
    fundingLotId: v.id("walletFundingLots"),
    paymentId: v.optional(v.id("payments")),
    publisherOrganizationId: v.optional(v.id("organizations")),
    allocatedGrossCredits: v.number(),
    clawedBackGrossCredits: v.number(),
    updatedAt: v.number(),
  })
    .index("by_lot_publisher", ["fundingLotId", "publisherOrganizationId"])
    .index("by_payment_publisher", ["paymentId", "publisherOrganizationId"]),

  // Per-call metering events (gateway → Convex, async)
  usageEvents: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    /** Denormalized display identity; missing means legacy/unverified. */
    projectName: v.optional(v.string()),
    projectSlug: v.optional(v.string()),
    endpoint: v.string(),
    method: v.string(),
    credits: v.number(),
    status: v.number(),
    latencyMs: v.number(),
    keyId: v.string(),
    at: v.number(),
    /**
     * Stable gateway settlement reference (`settle:{reservationId}`).
     * Optional solely for pre-ledger historical analytics rows; every new
     * Wallet DO ingest validates and persists it.
     */
    settleRefId: v.optional(v.string()),
    /** Provider dispatch completed but response authority was ambiguous. */
    ambiguous: v.optional(v.boolean()),
    /** Stable publisher-facing replay key, when gateway contract supplies it. */
    publisherIdempotencyKey: v.optional(v.string()),
  })
    .index("by_org", ["organizationId"])
    .index("by_project", ["projectId"])
    .index("by_org_at", ["organizationId", "at"])
    .index("by_project_at", ["projectId", "at"])
    .index("by_settlement", ["settleRefId"])
    .index("by_at", ["at"]),

  // In-app notifications (org-scoped, idempotent by refId)
  notifications: defineTable({
    clerkOrgId: v.string(),
    kind: v.union(
      v.literal("low_balance"),
      v.literal("spec_published"),
      v.literal("version_deprecated"),
      v.literal("webhook_failed"),
      v.literal("visibility_changed"),
      v.literal("transfer_failed"),
      v.literal("transfer_sent"),
    ),
    title: v.string(),
    body: v.string(),
    refId: v.string(),
    readAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_org", ["clerkOrgId", "createdAt"])
    .index("by_ref", ["refId"]),

  // Publisher webhook endpoints (one per project)
  webhookEndpoints: defineTable({
    projectId: v.id("projects"),
    url: v.string(),
    secret: v.string(),
    active: v.boolean(),
    createdAt: v.number(),
  }).index("by_project", ["projectId"]),

  // Webhook delivery log
  webhookDeliveries: defineTable({
    endpointId: v.id("webhookEndpoints"),
    event: v.string(),
    status: v.union(v.literal("pending"), v.literal("ok"), v.literal("failed")),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    payload: v.string(),
  }).index("by_endpoint", ["endpointId", "createdAt"]),

  // Per-key controls (Clerk owns the key itself; this is Zevium metadata).
  // Gateway pulls these via the internal-secret ledger sync — never per-request.
  keySettings: defineTable({
    clerkOrgId: v.string(),
    keyId: v.string(),
    /** Monthly credit cap; undefined = unlimited. Enforced by the wallet DO. */
    monthlyCapCredits: v.optional(v.number()),
    disabled: v.boolean(),
    /** Set when this key replaced another during rotation. */
    rotatedFromKeyId: v.optional(v.string()),
    /** Old key keeps working until this ms epoch (rotation grace). */
    graceUntil: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_org", ["clerkOrgId"])
    .index("by_key", ["keyId"]),

  keyRotationOperations: defineTable({
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    oldKeyId: v.string(),
    status: v.union(
      v.literal("reserved"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    newKeyId: v.optional(v.string()),
    graceUntil: v.optional(v.number()),
    failure: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_operation", ["clerkOrgId", "userId", "operationId"])
    .index("by_active_old_key", ["clerkOrgId", "oldKeyId", "status"]),

  // Catalogue semantic search (embedded on publish; Gemini text-embedding-004)
  specEmbeddings: defineTable({
    projectId: v.id("projects"),
    /** Text that was embedded (name + description + tags + endpoint summaries). */
    text: v.string(),
    embedding: v.array(v.float64()),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 768,
    }),

  // Stripe identifiers are organization-owned. No bank details are stored.
  organizationPayments: defineTable({
    organizationId: v.id("organizations"),
    stripeCustomerId: v.optional(v.string()),
    stripeConnectedAccountId: v.optional(v.string()),
    stripeConnectedAccountLivemode: v.optional(v.boolean()),
    stripePlatformAccountId: v.optional(v.string()),
    detailsSubmitted: v.boolean(),
    chargesEnabled: v.boolean(),
    payoutsEnabled: v.boolean(),
    disabledReason: v.optional(v.string()),
    requirements: v.array(v.string()),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_customer", ["stripeCustomerId"])
    .index("by_connected_account", ["stripeConnectedAccountId"]),

  // Server-issued operations make Connect provider retries durable without
  // storing Stripe's single-use onboarding URLs.
  stripeConnectOnboardingOperations: defineTable({
    organizationId: v.id("organizations"),
    operationId: v.string(),
    kind: v.union(v.literal("account_create"), v.literal("account_link")),
    status: v.union(
      v.literal("prepared"),
      v.literal("account_persisted"),
      v.literal("link_created"),
      v.literal("expired"),
      v.literal("failed"),
      v.literal("requires_reconciliation"),
    ),
    expectedLivemode: v.boolean(),
    country: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    stripeConnectedAccountId: v.optional(v.string()),
    providerExpiresAt: v.optional(v.number()),
    providerRequestFingerprint: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
    providerErrorCode: v.optional(v.string()),
    piiExpiresAt: v.optional(v.number()),
    replacementOfAccountId: v.optional(v.string()),
    reconciliationCaseId: v.optional(v.id("financeReconciliationCases")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_operation", ["operationId"])
    .index("by_organization_kind_status", ["organizationId", "kind", "status"])
    .index("by_pii_expiry", ["piiExpiresAt"]),

  // Checkout state is server-owned: browser-supplied metadata never grants.
  checkoutIntents: defineTable({
    organizationId: v.id("organizations"),
    packId: v.union(
      v.literal("pack_10"),
      v.literal("pack_50"),
      v.literal("pack_100"),
    ),
    stripePriceId: v.string(),
    amount: v.number(),
    currency: v.string(),
    credits: v.number(),
    stripeCheckoutSessionId: v.optional(v.string()),
    stripePaymentIntentId: v.optional(v.string()),
    status: v.union(
      v.literal("created"),
      v.literal("open"),
      v.literal("complete"),
      v.literal("expired"),
      v.literal("failed"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_organization", ["organizationId", "createdAt"])
    .index("by_checkout_session", ["stripeCheckoutSessionId"])
    .index("by_payment_intent", ["stripePaymentIntentId"]),

  // Durable Stripe receipt and processing state. Never store raw card data.
  paymentEvents: defineTable({
    stripeEventId: v.string(),
    stripeAccount: v.string(),
    eventType: v.string(),
    objectId: v.string(),
    status: v.union(
      v.literal("received"),
      v.literal("processing"),
      v.literal("processed"),
      v.literal("failed"),
      v.literal("ignored"),
    ),
    /** Processing attempts, not duplicate HTTP deliveries. */
    attempts: v.number(),
    deliveries: v.number(),
    lastError: v.optional(v.string()),
    receivedAt: v.number(),
    nextAttemptAt: v.optional(v.number()),
    leaseExpiresAt: v.optional(v.number()),
    processedAt: v.optional(v.number()),
    replayCount: v.optional(v.number()),
    lastReplayedAt: v.optional(v.number()),
    lastReplayedBy: v.optional(v.string()),
  })
    .index("by_stripe_event", ["stripeEventId"])
    .index("by_object", ["objectId"])
    .index("by_status_next_attempt", ["status", "nextAttemptAt"])
    .index("by_status_lease", ["status", "leaseExpiresAt"]),

  payments: defineTable({
    organizationId: v.id("organizations"),
    checkoutIntentId: v.id("checkoutIntents"),
    stripeCheckoutSessionId: v.string(),
    stripePaymentIntentId: v.optional(v.string()),
    stripeChargeId: v.optional(v.string()),
    amount: v.number(),
    currency: v.string(),
    grantedCredits: v.number(),
    refundedAmount: v.number(),
    refundedCredits: v.number(),
    /** Effective wallet reversal, capped to the immutable grant. */
    reversedCredits: v.number(),
    /** Active reversal satisfied by removing unspent payment-funded credits. */
    walletReversedCredits: v.optional(v.number()),
    /** Active reversal satisfied by clawing consumed publisher-funded credits. */
    publisherClawbackTargetCredits: v.optional(v.number()),
    /** Monotonic local reversal transition sequence; prevents cyclic ref reuse. */
    reversalSequence: v.optional(v.number()),
    /** Missing means legacy/unverified. Money mutations require `verified`. */
    financeMigrationStatus: v.optional(
      v.union(v.literal("building"), v.literal("verified")),
    ),
    /** Present only while this payment is fenced by a migration job. */
    financeMigrationJobId: v.optional(v.id("financialMigrationJobs")),
    status: v.union(
      v.literal("pending"),
      v.literal("paid"),
      v.literal("partially_refunded"),
      v.literal("refunded"),
      v.literal("disputed"),
      v.literal("dispute_won"),
      v.literal("dispute_lost"),
      v.literal("failed"),
    ),
    failureReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId", "createdAt"])
    .index("by_checkout_session", ["stripeCheckoutSessionId"])
    .index("by_payment_intent", ["stripePaymentIntentId"])
    .index("by_charge", ["stripeChargeId"]),

  // One row per Stripe dispute. Money movement is event-driven, not inferred
  // from lifecycle state: warning inquiries never withdraw wallet credits.
  paymentDisputes: defineTable({
    paymentId: v.id("payments"),
    organizationId: v.id("organizations"),
    stripeDisputeId: v.string(),
    stripeChargeId: v.string(),
    amount: v.number(),
    currency: v.string(),
    status: v.union(
      v.literal("warning_needs_response"),
      v.literal("warning_under_review"),
      v.literal("warning_closed"),
      v.literal("needs_response"),
      v.literal("under_review"),
      v.literal("won"),
      v.literal("lost"),
      v.literal("prevented"),
    ),
    creditsAtRisk: v.number(),
    fundsWithdrawn: v.boolean(),
    fundsReinstated: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_stripe_dispute", ["stripeDisputeId"])
    .index("by_payment", ["paymentId", "createdAt"])
    .index("by_organization_status", ["organizationId", "status"]),

  // Refund/dispute exposure stays source-specific. Effective targets are
  // deterministically capped to the immutable payment grant.
  paymentExposures: defineTable({
    paymentId: v.id("payments"),
    organizationId: v.id("organizations"),
    sourceKind: v.union(v.literal("refund"), v.literal("dispute")),
    sourceRef: v.string(),
    sourceAmount: v.number(),
    /** False only for legacy refund rows until Stripe supplies exact amount. */
    sourceAmountExact: v.optional(v.boolean()),
    sourceStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("requires_action"),
        v.literal("succeeded"),
        v.literal("failed"),
        v.literal("canceled"),
      ),
    ),
    migrationBackfilled: v.optional(v.boolean()),
    requestedCredits: v.number(),
    effectiveCredits: v.number(),
    walletCredits: v.number(),
    publisherCredits: v.number(),
    appliedPublisherCredits: v.number(),
    allocationCursor: v.optional(v.string()),
    active: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_source", ["sourceRef"])
    .index("by_organization_active", ["organizationId", "active"])
    .index("by_payment_active_created", ["paymentId", "active", "createdAt"])
    .index("by_payment_created", ["paymentId", "createdAt"]),

  // One durable reconciliation checkpoint per payment. Scheduled bounded
  // mutations resume it after crashes and exact-once source rows dedupe work.
  publisherReconciliationJobs: defineTable({
    paymentId: v.id("payments"),
    consumerOrganizationId: v.id("organizations"),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("complete"),
      v.literal("failed"),
    ),
    revision: v.number(),
    processedChunks: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_payment", ["paymentId"])
    .index("by_consumer_status", ["consumerOrganizationId", "status"])
    .index("by_status_updated", ["status", "updatedAt"]),

  // Each successful settlement creates exactly one immutable publisher split.
  publisherEarnings: defineTable({
    publisherOrganizationId: v.id("organizations"),
    consumerOrganizationId: v.id("organizations"),
    /** Immutable published project that earned this settlement. */
    projectId: v.optional(v.id("projects")),
    /** Denormalized display identity; missing means legacy/unverified. */
    projectName: v.optional(v.string()),
    projectSlug: v.optional(v.string()),
    usageSettlementRefId: v.string(),
    grossCredits: v.number(),
    /** Exact atom values are canonical; decimal credits are display mirrors. */
    platformFeeAtoms: v.number(),
    publisherNetAtoms: v.number(),
    platformFeeCredits: v.number(),
    netCredits: v.number(),
    clawedBackGrossCredits: v.number(),
    clawedBackAtoms: v.number(),
    releasedAtoms: v.number(),
    availableAt: v.number(),
    status: v.union(
      v.literal("pending_risk"),
      v.literal("available"),
      v.literal("allocated_to_transfer"),
      v.literal("transferred"),
      v.literal("reversed"),
      v.literal("failed"),
    ),
    transferId: v.optional(v.id("publisherTransfers")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_publisher", ["publisherOrganizationId", "createdAt"])
    .index("by_consumer", ["consumerOrganizationId", "createdAt"])
    .index("by_settlement", ["usageSettlementRefId"])
    .index("by_status_available", ["status", "availableAt"])
    .index("by_publisher_status_available", [
      "publisherOrganizationId",
      "status",
      "availableAt",
    ]),

  // Materialized publisher settlement buckets. `availableAtoms` may be
  // negative after clawing back earnings already paid; future earnings repay
  // that debt before another transfer can be prepared.
  publisherBalances: defineTable({
    publisherOrganizationId: v.id("organizations"),
    availableAtoms: v.number(),
    allocatedAtoms: v.number(),
    paidAtoms: v.number(),
    /** Canonical all-row aggregates; list pagination never changes totals. */
    pendingRiskAtoms: v.optional(v.number()),
    reversedAtoms: v.optional(v.number()),
    failedAtoms: v.optional(v.number()),
    sequence: v.number(),
    /** Missing means legacy/unverified. Runtime accepts only `verified`. */
    migrationStatus: v.optional(
      v.union(v.literal("building"), v.literal("verified")),
    ),
    migrationJobId: v.optional(v.id("financialMigrationJobs")),
    migrationWatermarkSequence: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_publisher", ["publisherOrganizationId"]),

  // Append-only settlement ledger. Bucket deltas plus sequence make every
  // payout, reversal, and clawback independently auditable and idempotent.
  publisherSettlementEntries: defineTable({
    publisherBalanceId: v.id("publisherBalances"),
    publisherOrganizationId: v.id("organizations"),
    kind: v.union(
      v.literal("earning_release"),
      v.literal("refund_clawback"),
      v.literal("dispute_clawback"),
      v.literal("refund_restoration"),
      v.literal("dispute_restoration"),
      v.literal("transfer_allocation"),
      v.literal("transfer_succeeded"),
      v.literal("transfer_failed"),
      v.literal("transfer_reversal"),
    ),
    availableDeltaAtoms: v.number(),
    allocatedDeltaAtoms: v.number(),
    paidDeltaAtoms: v.number(),
    refId: v.string(),
    sequence: v.number(),
    earningId: v.optional(v.id("publisherEarnings")),
    transferId: v.optional(v.id("publisherTransfers")),
    paymentId: v.optional(v.id("payments")),
    createdAt: v.number(),
  })
    .index("by_publisher", ["publisherOrganizationId", "sequence"])
    .index("by_transfer_sequence", ["transferId", "sequence"])
    .index("by_ref", ["refId"]),

  publisherClawbacks: defineTable({
    paymentId: v.id("payments"),
    consumerOrganizationId: v.id("organizations"),
    publisherOrganizationId: v.id("organizations"),
    earningId: v.id("publisherEarnings"),
    sourceKind: v.union(v.literal("refund"), v.literal("dispute")),
    sourceRef: v.string(),
    allocationId: v.optional(v.id("walletFundingAllocations")),
    grossCredits: v.number(),
    amountAtoms: v.number(),
    restoredGrossCredits: v.optional(v.number()),
    restoredAtoms: v.optional(v.number()),
    state: v.optional(v.union(v.literal("active"), v.literal("restored"))),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_payment", ["paymentId", "createdAt"])
    .index("by_source", ["sourceRef"])
    .index("by_source_state_created", ["sourceRef", "state", "createdAt"])
    .index("by_allocation", ["allocationId"]),

  publisherTransfers: defineTable({
    publisherOrganizationId: v.id("organizations"),
    stripeConnectedAccountId: v.string(),
    amount: v.number(),
    amountAtoms: v.number(),
    /** Snapshot only. Canonical remainder stays in publisherBalances. */
    remainderAtoms: v.number(),
    currency: v.string(),
    idempotencyKey: v.string(),
    stripeTransferId: v.optional(v.string()),
    /** Cumulative Stripe reversal snapshot in whole USD cents. */
    reversedAmount: v.optional(v.number()),
    /** Secure crash-recovery correlation; optional through staged rollout. */
    correlationNonce: v.optional(v.string()),
    correlationHmac: v.optional(v.string()),
    platformAccountId: v.optional(v.string()),
    /** Local correlation is not provider proof until a Stripe snapshot agrees. */
    correlationState: v.optional(
      v.union(
        v.literal("local_prepared"),
        v.literal("provider_verified"),
        v.literal("provider_repair_required"),
        v.literal("requires_reconciliation"),
      ),
    ),
    providerMetadataVerifiedAt: v.optional(v.number()),
    providerRequestFingerprint: v.optional(v.string()),
    providerReplayExpiresAt: v.optional(v.number()),
    providerRequestId: v.optional(v.string()),
    providerOutcome: v.optional(
      v.union(
        v.literal("created"),
        v.literal("definitive_no_side_effect"),
        v.literal("ambiguous"),
      ),
    ),
    reconciliationCaseId: v.optional(v.id("financeReconciliationCases")),
    metadataRepairVersion: v.optional(v.number()),
    /** Exact metadata parameter set used by original idempotent create. */
    providerCreateMetadataShape: v.optional(
      v.union(
        v.literal("publisher_only"),
        v.literal("correlated_v0"),
        v.literal("correlated_v1"),
      ),
    ),
    status: v.union(
      v.literal("created"),
      v.literal("pending"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("reversed"),
    ),
    failureReason: v.optional(v.string()),
    attemptedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_publisher", ["publisherOrganizationId", "createdAt"])
    .index("by_publisher_status", ["publisherOrganizationId", "status"])
    .index("by_idempotency_key", ["idempotencyKey"])
    .index("by_stripe_transfer", ["stripeTransferId"]),

  // Resumable finance-v2 rollout. One versioned checkpoint owns cursors and
  // bounded accumulators; audits are append-only proof of each verified phase.
  financialMigrationJobs: defineTable({
    migrationKey: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("verified"),
      v.literal("failed"),
    ),
    phase: v.union(
      v.literal("wallets"),
      v.literal("clawbacks"),
      v.literal("publishers"),
      v.literal("transfers"),
      v.literal("conservation"),
      v.literal("complete"),
    ),
    tableCursor: v.optional(v.string()),
    detailCursor: v.optional(v.string()),
    subphase: v.optional(v.string()),
    activeWalletId: v.optional(v.id("wallets")),
    activePaymentId: v.optional(v.id("payments")),
    activePublisherOrganizationId: v.optional(v.id("organizations")),
    activeTransferId: v.optional(v.id("publisherTransfers")),
    activeSequence: v.optional(v.number()),
    accumulatorA: v.number(),
    accumulatorB: v.number(),
    accumulatorC: v.number(),
    accumulatorD: v.optional(v.number()),
    accumulatorE: v.optional(v.number()),
    accumulatorF: v.optional(v.number()),
    /** Resumable independently recomputed conservation accumulator. */
    verificationState: v.optional(v.string()),
    rowsRead: v.number(),
    rowsWritten: v.number(),
    chunks: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_migration_key", ["migrationKey"]),

  financeReconciliationCases: defineTable({
    kind: v.union(
      v.literal("transfer"),
      v.literal("transfer_orphan"),
      v.literal("account_create"),
    ),
    status: v.union(
      v.literal("open"),
      v.literal("adopted"),
      v.literal("quarantined"),
      v.literal("resolved"),
    ),
    reason: v.string(),
    organizationId: v.optional(v.id("organizations")),
    transferId: v.optional(v.id("publisherTransfers")),
    operationId: v.optional(v.string()),
    candidateIds: v.array(v.string()),
    candidateCount: v.number(),
    providerCursor: v.optional(v.string()),
    providerRequestIds: v.array(v.string()),
    attempts: v.number(),
    resolution: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status_updated", ["status", "updatedAt"])
    .index("by_transfer", ["transferId"])
    .index("by_operation", ["operationId"]),

  connectedAccountClaims: defineTable({
    stripeConnectedAccountId: v.string(),
    organizationId: v.id("organizations"),
    livemode: v.boolean(),
    claimedAt: v.number(),
  })
    .index("by_connected_account", ["stripeConnectedAccountId"])
    .index("by_organization", ["organizationId"]),

  financialMigrationAudits: defineTable({
    migrationJobId: v.id("financialMigrationJobs"),
    phase: v.string(),
    scopeRef: v.string(),
    result: v.union(
      v.literal("checkpoint"),
      v.literal("verified"),
      v.literal("failed"),
    ),
    facts: v.string(),
    createdAt: v.number(),
  }).index("by_job_created", ["migrationJobId", "createdAt"]),

  connectedPayouts: defineTable({
    stripeConnectedAccountId: v.string(),
    stripePayoutId: v.string(),
    amount: v.number(),
    currency: v.string(),
    arrivalDate: v.optional(v.number()),
    status: v.union(
      v.literal("pending"),
      v.literal("paid"),
      v.literal("failed"),
      v.literal("canceled"),
    ),
    failureCode: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_connected_account", ["stripeConnectedAccountId", "updatedAt"])
    .index("by_connected_account_status", ["stripeConnectedAccountId", "status"])
    .index("by_stripe_payout", ["stripePayoutId"]),
});
