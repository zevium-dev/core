import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const fundingProvenanceSlice = v.object({
  sourceRef: v.string(),
  paymentId: v.optional(v.id("payments")),
  grossCredits: v.number(),
});

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
    /** Clerk deletion tombstone. Financial, audit, and project rows remain intact. */
    archivedAt: v.optional(v.number()),
    /** Last accepted Clerk organization event timestamp (ms), for stale-event rejection. */
    lastClerkEventAt: v.optional(v.number()),
    /** Materialized unread total. Optional until the bounded backfill completes. */
    unreadNotificationCount: v.optional(v.number()),
    /** True when legacy backfill observed at least 100 unread rows. */
    unreadNotificationCountCapped: v.optional(v.boolean()),
  })
    .index("by_clerk_org", ["clerkOrgId"])
    .index("by_slug", ["slug"])
    .index("by_public_handle", ["publicHandle"]),

  /** Durable delete-before-create guard for out-of-order Clerk webhooks. */
  organizationTombstones: defineTable({
    clerkOrgId: v.string(),
    organizationId: v.optional(v.id("organizations")),
    publisherHandle: v.optional(v.string()),
    operationId: v.optional(v.string()),
    sourceRevision: v.number(),
    archivedAt: v.number(),
  })
    .index("by_clerk_org", ["clerkOrgId"])
    .index("by_handle", ["publisherHandle"]),

  /** Durable Svix receipt prevents replay and stale organization mirror writes. */
  clerkWebhookReceipts: defineTable({
    svixId: v.string(),
    eventType: v.string(),
    eventTimestamp: v.number(),
    status: v.union(
      v.literal("received"),
      v.literal("processing"),
      v.literal("processed"),
      v.literal("ignored_stale"),
    ),
    attempts: v.number(),
    lastAttemptAt: v.number(),
    receivedAt: v.number(),
    processedAt: v.optional(v.number()),
  }).index("by_svix_id", ["svixId"]),

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
    qualityStatus: v.optional(
      v.union(
        v.literal("active"),
        v.literal("suspended"),
        v.literal("recovering"),
      ),
    ),
    qualitySuspendedAt: v.optional(v.number()),
    qualitySuspensionReason: v.optional(v.string()),
    qualityRecoveryPasses: v.optional(v.number()),
    deprecationStartedAt: v.optional(v.number()),
    sunsetAt: v.optional(v.number()),
    deprecationMessage: v.optional(v.string()),
    /** Explicit state keeps completed retirements out of scheduled indexes. */
    retirementState: v.optional(
      v.union(v.literal("scheduled"), v.literal("retired")),
    ),
    /** Monotonic schedule generation; stale fanout jobs fail closed. */
    retirementRevision: v.optional(v.number()),
    /** Final cutoff retained after sunsetAt leaves the active-work index. */
    retirementCutoffAt: v.optional(v.number()),
    /** Audit tombstone after sunset cleanup; project row remains immutable history. */
    publicationGeneration: v.optional(v.number()),
    desiredVisibility: v.optional(
      v.union(v.literal("private"), v.literal("public")),
    ),
    retiredAt: v.optional(v.number()),
    deletionState: v.optional(
      v.union(v.literal("tombstoned"), v.literal("cleaned")),
    ),
  })
    .index("by_org", ["organizationId"])
    .index("by_status", ["status"])
    .index("by_org_status", ["organizationId", "status"])
    .index("by_org_slug", ["organizationId", "slug"])
    .index("by_visibility_status", ["visibility", "status"])
    .index("by_sunset", ["sunsetAt"])
    .index("by_retirement_state_sunset", ["retirementState", "sunsetAt"]),

  /**
   * Permanent public URL reservations. Rows start on first publish and gain
   * retiredAt on archive. Handle ownership and each org-scoped slug stay bound.
   */
  publicRouteTombstones: defineTable({
    routeKey: v.optional(v.string()),
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    publisherHandle: v.string(),
    projectSlug: v.string(),
    operationId: v.optional(v.string()),
    publicationGeneration: v.optional(v.number()),
    sourceRevision: v.optional(v.number()),
    reservedAt: v.number(),
    retiredAt: v.optional(v.number()),
  })
    .index("by_project", ["projectId"])
    .index("by_org_slug", ["organizationId", "projectSlug"])
    .index("by_public_url", ["publisherHandle", "projectSlug"])
    .index("by_handle", ["publisherHandle"]),

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
    // v2 envelope is purpose/resource-bound with AES-GCM AAD. Legacy envelope
    // remains during staged rollout so previous release can still roll back.
    sealedCiphertext: v.optional(v.string()),
    sealedIv: v.optional(v.string()),
    sealedKeyVersion: v.optional(v.string()),
    sealedVersion: v.optional(v.literal("v2")),
    secret: v.optional(v.string()),
    /** Strictly monotonic per-row revision. Wall-clock equality cannot hide writes. */
    revision: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_name", ["projectId", "name"]),

  publishReadiness: defineTable({
    projectId: v.id("projects"),
    draftHash: v.string(),
    /** Optional-first migration: legacy rows retain these until backfill. */
    serverOrigin: v.optional(v.string()),
    credentialRevision: v.optional(v.number()),
    healthCheckUrl: v.optional(v.string()),
    healthCheckMethod: v.optional(v.union(v.literal("GET"), v.literal("HEAD"))),
    /** Hash of every credential identity + revision; deletion changes it. */
    credentialFingerprint: v.optional(v.string()),
    status: v.literal("ok"),
    testedAt: v.number(),
  }).index("by_project", ["projectId"]),

  // Credential-free, DNS-pinned scheduled checks for the latest published spec.
  qualityProbeTargets: defineTable({
    projectId: v.id("projects"),
    specVersionId: v.id("specVersions"),
    /** Optional-first generation fence for targets created before rollout. */
    publicationGeneration: v.optional(v.number()),
    url: v.string(),
    method: v.union(v.literal("GET"), v.literal("HEAD")),
    enabled: v.boolean(),
    nextProbeAt: v.number(),
    leaseId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_due", ["enabled", "nextProbeAt"])
    // Optional-first lease expiry index lets old workers be reclaimed without
    // waiting for their deliberately future nextProbeAt.
    .index("by_lease_expiry", ["enabled", "leaseExpiresAt"]),

  qualityProbeResults: defineTable({
    projectId: v.id("projects"),
    specVersionId: v.id("specVersions"),
    publicationGeneration: v.optional(v.number()),
    executionId: v.string(),
    checkedAt: v.number(),
    outcome: v.union(
      v.literal("healthy"),
      v.literal("http_error"),
      v.literal("timeout"),
      v.literal("dns_error"),
      v.literal("tls_error"),
      v.literal("network_error"),
      v.literal("blocked_target"),
    ),
    statusCode: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
  })
    .index("by_execution", ["executionId"])
    .index("by_project_checked", ["projectId", "checkedAt"])
    .index("by_project_version_checked", [
      "projectId",
      "specVersionId",
      "checkedAt",
    ]),

  // One query-ready truth row per project; derived only from stored samples.
  qualitySnapshots: defineTable({
    projectId: v.id("projects"),
    specVersionId: v.id("specVersions"),
    reachabilitySampleSize: v.number(),
    reachabilityResponseCount: v.number(),
    reachabilityPercent: v.optional(v.number()),
    reachabilityLatencyP50Ms: v.optional(v.number()),
    insufficientReachabilityData: v.boolean(),
    apiSampleSize: v.number(),
    apiSuccessCount: v.number(),
    apiSuccessRatePercent: v.optional(v.number()),
    apiLatencyP50Ms: v.optional(v.number()),
    insufficientApiData: v.boolean(),
    lastProbeOutcome: v.optional(
      v.union(
        v.literal("healthy"),
        v.literal("http_error"),
        v.literal("timeout"),
        v.literal("dns_error"),
        v.literal("tls_error"),
        v.literal("network_error"),
        v.literal("blocked_target"),
      ),
    ),
    lastProbedAt: v.optional(v.number()),
    publishedAt: v.number(),
    updatedAt: v.number(),
  }).index("by_project", ["projectId"]),

  // Privacy-minimized real gateway outcomes. No consumer, key, endpoint,
  // payload, raw status, or request metadata is retained.
  gatewayQualitySamples: defineTable({
    projectId: v.id("projects"),
    specVersionId: v.id("specVersions"),
    refId: v.string(),
    outcome: v.union(
      v.literal("success"),
      v.literal("client_error"),
      v.literal("server_error"),
      v.literal("network_error"),
    ),
    latencyMs: v.number(),
    at: v.number(),
  })
    .index("by_ref", ["refId"])
    .index("by_project_at", ["projectId", "at"])
    .index("by_project_version_at", ["projectId", "specVersionId", "at"]),

  qualityIncidents: defineTable({
    projectId: v.id("projects"),
    specVersionId: v.id("specVersions"),
    /** Optional-first immutable version label for N+1-free public history. */
    specVersion: v.optional(v.string()),
    openedAt: v.number(),
    closedAt: v.optional(v.number()),
    status: v.union(
      v.literal("open"),
      v.literal("resolved"),
      v.literal("superseded"),
    ),
    startedByExecutionId: v.string(),
    resolvedByExecutionId: v.optional(v.string()),
    failureCount: v.number(),
    lastOutcome: v.union(
      v.literal("healthy"),
      v.literal("http_error"),
      v.literal("timeout"),
      v.literal("dns_error"),
      v.literal("tls_error"),
      v.literal("network_error"),
      v.literal("blocked_target"),
    ),
    reason: v.string(),
    /** Legacy capture. Recovery uses projects.desiredVisibility, never this field. */
    restoreVisibility: v.optional(
      v.union(v.literal("private"), v.literal("public")),
    ),
    threshold: v.number(),
    windowSize: v.number(),
    suspendedAt: v.optional(v.number()),
    recoveryPasses: v.number(),
    restoredAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_project_opened", ["projectId", "openedAt"])
    .index("by_project_status", ["projectId", "status"])
    .index("by_project_version_status", [
      "projectId",
      "specVersionId",
      "status",
    ]),

  listingSubscriptions: defineTable({
    consumerOrganizationId: v.id("organizations"),
    projectId: v.id("projects"),
    active: v.boolean(),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_consumer_project", ["consumerOrganizationId", "projectId"])
    .index("by_consumer_active", ["consumerOrganizationId", "active"])
    .index("by_project_active", ["projectId", "active"]),

  // Transactional count avoids table scans on publisher/status surfaces.
  listingSubscriptionAggregates: defineTable({
    projectId: v.id("projects"),
    count: v.number(),
    updatedAt: v.number(),
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
    /** Canonical immutable settlement payload binding for replay conflict checks. */
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
    /** Exact roots backing currently available inventory. Optional for rollout. */
    availableProvenance: v.optional(v.array(fundingProvenanceSlice)),
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
    /** Exact root slices consumed by this immutable debit. */
    provenance: v.optional(v.array(fundingProvenanceSlice)),
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
    /** Exact payment-root slices removed by this immutable reversal. */
    provenance: v.optional(v.array(fundingProvenanceSlice)),
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
    /** Public opaque row identity; Convex document ids never cross member APIs. */
    publicId: v.optional(v.string()),
    organizationId: v.id("organizations"),
    /** Server-derived Clerk user that owned key at settlement time. */
    ownerUserId: v.optional(v.string()),
    /** Immutable publisher scope, separate from mutable project ownership. */
    publisherOrganizationId: v.optional(v.id("organizations")),
    projectId: v.id("projects"),
    /** Immutable published contract selected by gateway. */
    specVersionId: v.optional(v.id("specVersions")),
    specVersion: v.optional(v.string()),
    operationId: v.optional(v.string()),
    /** Denormalized display identity; missing means legacy/unverified. */
    projectName: v.optional(v.string()),
    projectSlug: v.optional(v.string()),
    endpoint: v.string(),
    method: v.string(),
    listedCostCredits: v.optional(v.number()),
    freeTierLimit: v.optional(v.number()),
    freeTierUsedBefore: v.optional(v.number()),
    pricingDecision: v.optional(
      v.union(
        v.literal("listed_price"),
        v.literal("free_tier"),
        v.literal("zero_price"),
      ),
    ),
    credits: v.number(),
    status: v.number(),
    latencyMs: v.number(),
    keyId: v.string(),
    keyFamilyId: v.optional(v.string()),
    monthlyCapCredits: v.optional(v.number()),
    budgetPeriod: v.optional(v.string()),
    budgetUsedBefore: v.optional(v.number()),
    budgetReservedBefore: v.optional(v.number()),
    budgetReservationCredits: v.optional(v.number()),
    at: v.number(),
    reservationId: v.optional(v.string()),
    settlementIdentityVersion: v.optional(v.literal(2)),
    /**
     * Stable gateway settlement reference (`settle:{reservationId}`).
     * Optional solely for pre-ledger historical analytics rows; every new
     * Wallet DO ingest validates and persists it.
     */
    settleRefId: v.optional(v.string()),
    billingOutcome: v.optional(
      v.union(v.literal("settled"), v.literal("refunded"), v.literal("free")),
    ),
    qualityOutcome: v.optional(
      v.union(
        v.literal("success"),
        v.literal("client_error"),
        v.literal("server_error"),
        v.literal("network_error"),
      ),
    ),
    /** Provider dispatch completed but response authority was ambiguous. */
    ambiguous: v.optional(v.boolean()),
    /** Stable publisher-facing replay key, when gateway contract supplies it. */
    publisherIdempotencyKey: v.optional(v.string()),
  })
    .index("by_org", ["organizationId"])
    .index("by_project", ["projectId"])
    .index("by_org_at", ["organizationId", "at"])
    .index("by_org_owner_at", ["organizationId", "ownerUserId", "at"])
    .index("by_org_project_at", ["organizationId", "projectId", "at"])
    .index("by_org_owner_project_at", [
      "organizationId",
      "ownerUserId",
      "projectId",
      "at",
    ])
    .index("by_org_key_at", ["organizationId", "keyId", "at"])
    .index("by_org_owner_key_at", [
      "organizationId",
      "ownerUserId",
      "keyId",
      "at",
    ])
    .index("by_org_project_key_at", [
      "organizationId",
      "projectId",
      "keyId",
      "at",
    ])
    .index("by_org_owner_project_key_at", [
      "organizationId",
      "ownerUserId",
      "projectId",
      "keyId",
      "at",
    ])
    .index("by_org_project_settlement", [
      "organizationId",
      "projectId",
      "settleRefId",
    ])
    .index("by_org_project_billing_settlement", [
      "organizationId",
      "projectId",
      "billingOutcome",
      "settleRefId",
    ])
    .index("by_org_endpoint_at", ["organizationId", "endpoint", "at"])
    .index("by_org_endpoint_method_at", [
      "organizationId",
      "endpoint",
      "method",
      "at",
    ])

    .index("by_project_at", ["projectId", "at"])
    .index("by_settlement", ["settleRefId"])
    .index("by_at", ["at"]),

  /** First successful use. Not a plan/subscription; only lifecycle eligibility. */
  projectConsumerEntitlements: defineTable({
    projectId: v.id("projects"),
    consumerOrganizationId: v.id("organizations"),
    firstUsedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_project_consumer", ["projectId", "consumerOrganizationId"])
    .index("by_consumer", ["consumerOrganizationId", "projectId"]),

  reviews: defineTable({
    projectId: v.id("projects"),
    consumerOrganizationId: v.id("organizations"),
    rating: v.number(),
    body: v.optional(v.string()),
    active: v.boolean(),
    hidden: v.boolean(),
    createdBy: v.string(),
    updatedBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    /** Immutable timestamp + unique random id, used for stable keyset paging. */
    sortKey: v.string(),
    responseBody: v.optional(v.string()),
    responseUpdatedAt: v.optional(v.number()),
    projectName: v.optional(v.string()),
    publisherName: v.optional(v.string()),
    openReportCount: v.optional(v.number()),
    latestReportReason: v.optional(v.string()),
    latestReportAt: v.optional(v.number()),
    latestModerationAction: v.optional(
      v.union(v.literal("hidden"), v.literal("restored")),
    ),
    latestModerationReason: v.optional(v.string()),
    latestModerationAt: v.optional(v.number()),
    /**
     * Monotonic fence between a moderation decision and reports created after
     * that decision. Optional while legacy rows are treated as generation 0.
     */
    moderationGeneration: v.optional(v.number()),
    /** Optional-first content/state fence for moderation queue intents. */
    contentRevision: v.optional(v.number()),
  })
    .index("by_consumer_project", ["consumerOrganizationId", "projectId"])
    .index("by_project_sort", ["projectId", "sortKey"])
    .index("by_project_visible", ["projectId", "active", "hidden", "sortKey"])
    .index("by_active_hidden_sort", ["active", "hidden", "sortKey"])
    .index("by_hidden_sort", ["hidden", "sortKey"])
    .index("by_report_count_sort", ["openReportCount", "sortKey"]),

  reviewEdits: defineTable({
    reviewId: v.id("reviews"),
    actorUserId: v.string(),
    action: v.union(
      v.literal("created"),
      v.literal("edited"),
      v.literal("withdrawn"),
      v.literal("reactivated"),
    ),
    previousRating: v.optional(v.number()),
    previousBody: v.optional(v.string()),
    rating: v.optional(v.number()),
    body: v.optional(v.string()),
    at: v.number(),
  }).index("by_review", ["reviewId", "at"]),

  reviewReports: defineTable({
    reviewId: v.id("reviews"),
    reporterUserId: v.string(),
    reporterOrganizationId: v.optional(v.id("organizations")),
    reason: v.string(),
    status: v.union(v.literal("open"), v.literal("resolved")),
    createdAt: v.number(),
    sortKey: v.string(),
    /** Generation copied from the review when this report was opened. */
    moderationGeneration: v.optional(v.number()),
    resolvedAt: v.optional(v.number()),
    resolvedBy: v.optional(v.string()),
  })
    .index("by_review_status", ["reviewId", "status", "sortKey"])
    .index("by_review_status_generation", [
      "reviewId",
      "status",
      "moderationGeneration",
      "sortKey",
    ])
    .index("by_reporter_review", ["reporterUserId", "reviewId"])
    .index("by_reporter_org_review", ["reporterOrganizationId", "reviewId"])
    .index("by_reporter_org_created", ["reporterOrganizationId", "createdAt"])
    .index("by_status", ["status", "sortKey"]),

  reviewReportThreads: defineTable({
    reviewId: v.id("reviews"),
    openCount: v.number(),
    latestReason: v.string(),
    latestReportedAt: v.number(),
    latestSortKey: v.string(),
    /** Immutable while thread remains open; stable moderation cursor. */
    queueSortKey: v.string(),
    rating: v.number(),
    body: v.optional(v.string()),
    active: v.boolean(),
    hidden: v.boolean(),
    reviewCreatedAt: v.number(),
    projectName: v.string(),
    publisherName: v.string(),
    responseBody: v.optional(v.string()),
    responseUpdatedAt: v.optional(v.number()),
    /** Optional-first current review fences mirrored into the queue snapshot. */
    moderationGeneration: v.optional(v.number()),
    contentRevision: v.optional(v.number()),
    status: v.union(v.literal("open"), v.literal("resolved")),
    updatedAt: v.number(),
  })
    .index("by_review", ["reviewId"])
    .index("by_status_sort", ["status", "queueSortKey"]),

  reviewAggregates: defineTable({
    projectId: v.id("projects"),
    count: v.number(),
    ratingSum: v.number(),
    oneStar: v.number(),
    twoStar: v.number(),
    threeStar: v.number(),
    fourStar: v.number(),
    fiveStar: v.number(),
    updatedAt: v.number(),
  }).index("by_project", ["projectId"]),

  publisherReviewResponses: defineTable({
    reviewId: v.id("reviews"),
    body: v.string(),
    createdBy: v.string(),
    updatedBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_review", ["reviewId"]),

  publisherReviewResponseEdits: defineTable({
    responseId: v.id("publisherReviewResponses"),
    actorUserId: v.string(),
    previousBody: v.optional(v.string()),
    body: v.string(),
    at: v.number(),
  }).index("by_response", ["responseId", "at"]),

  reviewModerationActions: defineTable({
    reviewId: v.id("reviews"),
    action: v.union(v.literal("hidden"), v.literal("restored")),
    reason: v.string(),
    actorUserId: v.string(),
    at: v.number(),
    sortKey: v.string(),
    rating: v.optional(v.number()),
    body: v.optional(v.string()),
    projectName: v.optional(v.string()),
    publisherName: v.optional(v.string()),
    active: v.optional(v.boolean()),
    hidden: v.optional(v.boolean()),
    reviewCreatedAt: v.optional(v.number()),
    responseBody: v.optional(v.string()),
    responseUpdatedAt: v.optional(v.number()),
    reportCount: v.optional(v.number()),
    latestReportReason: v.optional(v.string()),
    latestReportAt: v.optional(v.number()),
  })
    .index("by_review", ["reviewId", "at"])
    .index("by_review_sort", ["reviewId", "sortKey"])
    .index("by_actor", ["actorUserId", "at"])
    .index("by_sort", ["sortKey"]),

  /** First successful use. Not a plan/subscription; only lifecycle eligibility. */
  notifications: defineTable({
    clerkOrgId: v.string(),
    kind: v.union(
      v.literal("low_balance"),
      v.literal("spec_published"),
      v.literal("version_deprecated"),
      v.literal("project_retirement"),
      v.literal("webhook_failed"),
      v.literal("visibility_changed"),
      v.literal("transfer_failed"),
      v.literal("transfer_sent"),
      v.literal("quality_suspended"),
      v.literal("quality_restored"),
    ),
    title: v.string(),
    body: v.string(),
    refId: v.string(),
    /** Optional safe, typed destination for catalogue lifecycle notices. */
    publisherHandle: v.optional(v.string()),
    projectSlug: v.optional(v.string()),
    readAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_org", ["clerkOrgId", "createdAt"])
    .index("by_org_read", ["clerkOrgId", "readAt", "createdAt"])
    .index("by_ref", ["refId"]),

  // Publisher webhook endpoints (one per project)
  webhookEndpoints: defineTable({
    projectId: v.id("projects"),
    url: v.string(),
    // Transitional rollout mirrors upstreamCredentials: legacy plaintext is
    // removed by migrateSecurityRollout before these become required.
    ciphertext: v.optional(v.string()),
    iv: v.optional(v.string()),
    keyVersion: v.optional(v.string()),
    sealedCiphertext: v.optional(v.string()),
    sealedIv: v.optional(v.string()),
    sealedKeyVersion: v.optional(v.string()),
    sealedVersion: v.optional(v.literal("v2")),
    secret: v.optional(v.string()),
    /** Current signing-secret generation. Legacy rows are generation 1. */
    secretVersion: v.optional(v.number()),
    /** Current generation can be revealed once, then only rotation reveals again. */
    secretRevealedAt: v.optional(v.number()),
    /** One prior encrypted generation survives only for bounded retry grace. */
    previousCiphertext: v.optional(v.string()),
    previousIv: v.optional(v.string()),
    previousKeyVersion: v.optional(v.string()),
    previousSealedCiphertext: v.optional(v.string()),
    previousSealedIv: v.optional(v.string()),
    previousSealedKeyVersion: v.optional(v.string()),
    previousSealedVersion: v.optional(v.literal("v2")),
    previousSecretVersion: v.optional(v.number()),
    previousValidUntil: v.optional(v.number()),
    active: v.boolean(),
    /** Inactive tombstone retained while delivery rows retire in pages. */
    retiringAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_project", ["projectId"]),

  // Webhook delivery log
  webhookDeliveries: defineTable({
    endpointId: v.id("webhookEndpoints"),
    /** Immutable signing generation selected when delivery is enqueued. */
    secretVersion: v.optional(v.number()),
    event: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("delivering"),
      v.literal("ok"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    leaseToken: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    payload: v.string(),
  }).index("by_endpoint", ["endpointId", "createdAt"]),

  /** Resumable bounded cleanup; project tombstone remains accounting parent. */
  projectCleanupJobs: defineTable({
    projectId: v.id("projects"),
    phase: v.union(
      v.literal("quality_results"),
      v.literal("quality_samples"),
      v.literal("incidents"),
      v.literal("subscriptions"),
      v.literal("reviews"),
      v.literal("spec_versions"),
      v.literal("credentials"),
      v.literal("webhook_deliveries"),
      v.literal("webhook_endpoint"),
      v.literal("finished"),
    ),
    batchesCompleted: v.number(),
    updatedAt: v.number(),
  }).index("by_project", ["projectId"]),

  // Per-key controls (Clerk owns the key itself; this is Zevium metadata).
  // Gateway pulls these via the internal-secret ledger sync — never per-request.
  keySettings: defineTable({
    clerkOrgId: v.string(),
    // Transitional optional only for pre-policy rows. Member queries and all
    // writes ignore unclaimed rows until Clerk-backed broker verifies owner.
    ownerUserId: v.optional(v.string()),
    keyId: v.string(),
    /** Display metadata stamped by authenticated key creation/rotation. */
    keyName: v.optional(v.string()),
    subjectUserId: v.optional(v.string()),
    budgetId: v.optional(v.string()),
    budgetRevision: v.optional(v.number()),
    secretSha256: v.optional(v.string()),
    lifecycle: v.optional(
      v.union(
        v.literal("active"),
        v.literal("grace"),
        v.literal("disabled"),
        v.literal("revoked"),
      ),
    ),
    expiresAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),

    /** Stable across rotations; settlement identity never follows mutable keys. */
    keyFamilyId: v.optional(v.string()),
    /** False means Clerk key was observed but never provisioned by Zevium. */
    managed: v.optional(v.boolean()),
    /** Monthly credit cap; undefined = unlimited. Enforced by the wallet DO. */
    monthlyCapCredits: v.optional(v.number()),
    disabled: v.boolean(),
    /** Set when this key replaced another during rotation. */
    rotatedFromKeyId: v.optional(v.string()),
    /** Old key keeps working until this ms epoch (rotation grace). */
    graceUntil: v.optional(v.number()),
    /** Transitional deny state when legacy raw material cannot be re-hashed. */
    rotationRequiredAt: v.optional(v.number()),
    membershipRevokedAt: v.optional(v.number()),
    /**
     * Monotonic edge-revocation revision. Bumped on every disable/revoke so the
     * wallet DO can apply immediate fail-closed state without waiting for sync.
     */
    edgeRevision: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_org", ["clerkOrgId"])
    .index("by_owner", ["clerkOrgId", "ownerUserId"])
    .index("by_owner_status", ["clerkOrgId", "ownerUserId", "disabled"])
    .index("by_family", ["clerkOrgId", "ownerUserId", "keyFamilyId"])
    .index("by_key", ["keyId"]),

  /** Denormalized, bounded public catalogue/search projection. */
  catalogueListings: defineTable({
    projectId: v.id("projects"),
    clerkOrgId: v.string(),
    publisherHandle: v.string(),
    orgName: v.string(),
    name: v.string(),
    sortName: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    tags: v.array(v.string()),
    tagText: v.string(),
    searchText: v.string(),
    publishedAt: v.number(),
    pricingValid: v.boolean(),
    minCost: v.number(),
    maxCost: v.number(),
    endpointCount: v.number(),
    hasFreeTier: v.boolean(),
    discoverable: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_discoverable_newest", ["discoverable", "publishedAt"])
    .index("by_discoverable_name", ["discoverable", "sortName"])
    .index("by_discoverable_cost", ["discoverable", "minCost", "sortName"])
    .searchIndex("search_public", {
      searchField: "searchText",
      filterFields: ["discoverable", "hasFreeTier"],
    }),

  /** One bounded row per public tag for filter-first catalogue pagination. */
  catalogueTagListings: defineTable({
    listingId: v.id("catalogueListings"),
    tag: v.string(),
    publishedAt: v.number(),
    sortName: v.string(),
    minCost: v.number(),
    discoverable: v.boolean(),
  })
    .index("by_listing", ["listingId"])
    .index("by_tag_newest", ["tag", "discoverable", "publishedAt"])
    .index("by_tag_name", ["tag", "discoverable", "sortName"])
    .index("by_tag_cost", ["tag", "discoverable", "minCost", "sortName"]),

  /** Single-row exact count for catalogue UI; rebuilt by bounded projection job. */
  catalogueStats: defineTable({
    key: v.string(),
    publicCount: v.number(),
    tagCounts: v.optional(v.record(v.string(), v.number())),
    freeTierCount: v.optional(v.number()),
    projectionComplete: v.boolean(),
    backfillCursor: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  /** Immutable registry stream heads; every producer mutation advances one. */
  registryStreams: defineTable({
    streamKey: v.string(),
    revision: v.number(),
    lastEventId: v.string(),
    lastOperation: v.union(
      v.literal("org.put"),
      v.literal("org.archive"),
      v.literal("route.put"),
      v.literal("route.archive"),
      v.literal("key.put"),
      v.literal("key.revoke"),
      v.literal("catalogue.snapshot"),
    ),
    payloadSha256: v.string(),
    entityKey: v.string(),
    terminal: v.boolean(),
    updatedAt: v.number(),
  }).index("by_stream", ["streamKey"]),

  /** Singleton initial producer rollout with bounded, resumable phase cursor. */
  registryRollouts: defineTable({
    key: v.string(),
    rolloutId: v.string(),
    /** Optional-first compatibility; runtime rejects pre-provenance rows. */
    provenanceVersion: v.optional(v.literal(1)),
    snapshotAt: v.number(),
    status: v.union(v.literal("running"), v.literal("complete")),
    phase: v.union(
      v.literal("credentials"),
      v.literal("organizations"),
      v.literal("routes"),
      v.literal("keys"),
      v.literal("verify_sources"),
      v.literal("verify_events"),
      v.literal("complete"),
    ),
    cursor: v.optional(v.string()),
    page: v.optional(v.number()),
    counts: v.object({
      credentials: v.number(),
      organizations: v.number(),
      archivedOrganizations: v.number(),
      handlesBackfilled: v.number(),
      handlesReassigned: v.number(),
      publishedRoutes: v.number(),
      retiredRoutes: v.number(),
      keys: v.number(),
      keysForcedToRotate: v.number(),
      events: v.number(),
    }),
    digests: v.object({
      sources: v.string(),
      events: v.string(),
    }),
    verification: v.optional(
      v.object({
        counts: v.object({
          credentials: v.number(),
          organizations: v.number(),
          archivedOrganizations: v.number(),
          handlesBackfilled: v.number(),
          handlesReassigned: v.number(),
          publishedRoutes: v.number(),
          retiredRoutes: v.number(),
          keys: v.number(),
          keysForcedToRotate: v.number(),
          events: v.number(),
        }),
        digests: v.object({
          sources: v.string(),
          events: v.string(),
        }),
        lastPage: v.optional(v.number()),
        lastOrdinal: v.optional(v.number()),
      }),
    ),
    startedAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_key", ["key"]),

  /** Immutable exact inputs to the rollout source digest chain. */
  registryRolloutSourcePreimages: defineTable({
    rolloutId: v.string(),
    page: v.number(),
    ordinal: v.number(),
    phase: v.union(
      v.literal("credentials"),
      v.literal("organizations"),
      v.literal("routes"),
      v.literal("keys"),
    ),
    sourceId: v.string(),
    preimageJson: v.string(),
    countDelta: v.object({
      credentials: v.number(),
      organizations: v.number(),
      archivedOrganizations: v.number(),
      handlesBackfilled: v.number(),
      handlesReassigned: v.number(),
      publishedRoutes: v.number(),
      retiredRoutes: v.number(),
      keys: v.number(),
      keysForcedToRotate: v.number(),
      events: v.number(),
    }),
  })
    .index("by_rollout_order", ["rolloutId", "page", "ordinal"])
    .index("by_rollout_source", ["rolloutId", "phase", "sourceId"]),

  /** Immutable exact inputs to the rollout event-receipt digest chain. */
  registryRolloutEventReceipts: defineTable({
    rolloutId: v.string(),
    page: v.number(),
    ordinal: v.number(),
    sourceOrdinal: v.number(),
    eventId: v.string(),
    streamKey: v.string(),
    revision: v.number(),
    payloadSha256: v.string(),
    operation: v.union(
      v.literal("org.put"),
      v.literal("org.archive"),
      v.literal("route.put"),
      v.literal("route.archive"),
      v.literal("key.put"),
      v.literal("key.revoke"),
      v.literal("catalogue.snapshot"),
    ),
    receiptJson: v.string(),
  })
    .index("by_rollout_order", ["rolloutId", "page", "ordinal"])
    .index("by_rollout_event", ["rolloutId", "eventId"]),

  registryOutbox: defineTable({
    schemaVersion: v.literal(2),
    eventId: v.string(),
    streamKey: v.string(),
    revision: v.number(),
    operation: v.union(
      v.literal("org.put"),
      v.literal("org.archive"),
      v.literal("route.put"),
      v.literal("route.archive"),
      v.literal("key.put"),
      v.literal("key.revoke"),
      v.literal("catalogue.snapshot"),
    ),
    occurredAt: v.number(),
    nonce: v.string(),
    payloadSha256: v.string(),
    entityKey: v.string(),
    eventJson: v.string(),
    bodySha256: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("delivering"),
      v.literal("acked"),
      v.literal("dead_letter"),
    ),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    leaseToken: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    dependsOnEventId: v.optional(v.string()),
    ackJson: v.optional(v.string()),
    lastErrorCode: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_stream_revision", ["streamKey", "revision"])
    .index("by_status_next", ["status", "nextAttemptAt"])
    .index("by_status_lease", ["status", "leaseUntil"]),

  /** Pinned immutable reconciliation manifest headers. */
  registryManifestSnapshots: defineTable({
    snapshotId: v.string(),
    kind: v.union(
      v.literal("org"),
      v.literal("route"),
      v.literal("key"),
      v.literal("catalogue"),
    ),
    shard: v.string(),
    createdAt: v.number(),
    totalCount: v.number(),
    totalSha256: v.string(),
    pageCount: v.number(),
  })
    .index("by_snapshot", ["snapshotId"])
    .index("by_kind_shard", ["kind", "shard", "createdAt"]),

  /** Immutable manifest rows, sorted and diffed by entityKey. */
  registryManifestItems: defineTable({
    snapshotId: v.string(),
    entityKey: v.string(),
    streamKey: v.string(),
    revision: v.number(),
    eventId: v.string(),
    operation: v.union(
      v.literal("org.put"),
      v.literal("org.archive"),
      v.literal("route.put"),
      v.literal("route.archive"),
      v.literal("key.put"),
      v.literal("key.revoke"),
      v.literal("catalogue.snapshot"),
    ),
    payloadSha256: v.string(),
    tombstone: v.boolean(),
  })
    .index("by_snapshot_entity", ["snapshotId", "entityKey"])
    .index("by_snapshot_stream", ["snapshotId", "streamKey"]),

  keyRotationOperations: defineTable({
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    oldKeyId: v.string(),
    requestedName: v.optional(v.string()),
    /** Membership projection revision fenced when provider membership was fresh. */
    membershipRevision: v.optional(v.number()),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    status: v.union(
      v.literal("reserved"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    newKeyId: v.optional(v.string()),
    graceUntil: v.optional(v.number()),
    autoRevokeStatus: v.optional(
      v.union(
        v.literal("scheduled"),
        v.literal("revoking"),
        v.literal("revoked"),
        v.literal("failed"),
      ),
    ),
    autoRevokeAttempts: v.optional(v.number()),
    autoRevokeLeaseUntil: v.optional(v.number()),
    autoRevokeFailure: v.optional(v.string()),
    oldKeyRevokedAt: v.optional(v.number()),
    orphanReconciledAt: v.optional(v.number()),
    failure: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_operation", ["clerkOrgId", "userId", "operationId"])
    .index("by_active_old_key", ["clerkOrgId", "oldKeyId", "status"])
    .index("by_auto_revoke", ["autoRevokeStatus", "updatedAt"])
    .index("by_auto_revoke_due", ["autoRevokeStatus", "graceUntil"])
    .index("by_auto_revoke_lease", ["autoRevokeStatus", "autoRevokeLeaseUntil"])
    .index("by_lease_expiry", ["status", "leaseExpiresAt"])
    .index("by_reconcile", ["status", "orphanReconciledAt", "updatedAt"]),

  keyLifecycleOperations: defineTable({
    clerkOrgId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    kind: v.union(v.literal("create"), v.literal("revoke")),
    requestedName: v.optional(v.string()),
    /** Membership projection revision fenced when provider membership was fresh. */
    membershipRevision: v.optional(v.number()),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    status: v.union(
      v.literal("reserved"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    keyId: v.optional(v.string()),
    previousDisabled: v.optional(v.boolean()),
    orphanReconciledAt: v.optional(v.number()),
    failure: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_operation", ["clerkOrgId", "userId", "operationId"])
    .index("by_active_kind", ["clerkOrgId", "userId", "kind", "status"])
    .index("by_lease_expiry", ["status", "leaseExpiresAt"])
    .index("by_reconcile", ["status", "orphanReconciledAt", "updatedAt"]),

  // Transactional control-plane → gateway registry stream heads. Streams are
  // never deleted, so a route/key source revision can never move backwards.
  registrySyncStreams: defineTable({
    streamKey: v.string(),
    sourceRevision: v.number(),
    operation: v.union(
      v.literal("route.upsert"),
      v.literal("route.archive"),
      v.literal("key.upsert"),
      v.literal("key.state"),
      v.literal("org.archive"),
      v.literal("catalogue.replace"),
    ),
    payloadJson: v.string(),
    payloadDigest: v.string(),
    occurredAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_stream", ["streamKey"])
    .index("by_updated", ["updatedAt"]),

  // Durable at-least-once outbox. Receiver sourceRevision checks make retries
  // and out-of-order delivery safe; failed rows remain queued indefinitely.
  registrySyncOutbox: defineTable({
    eventId: v.string(),
    streamKey: v.string(),
    sourceRevision: v.number(),
    operation: v.union(
      v.literal("route.upsert"),
      v.literal("route.archive"),
      v.literal("key.upsert"),
      v.literal("key.state"),
      v.literal("org.archive"),
      v.literal("catalogue.replace"),
    ),
    payloadJson: v.string(),
    payloadDigest: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("delivering"),
      v.literal("delivered"),
    ),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    leaseUntil: v.optional(v.number()),
    lastError: v.optional(v.string()),
    occurredAt: v.number(),
    updatedAt: v.number(),
    deliveredAt: v.optional(v.number()),
  })
    .index("by_event", ["eventId"])
    .index("by_stream_revision", ["streamKey", "sourceRevision"])
    .index("by_due", ["status", "nextAttemptAt"]),

  // Cross-isolate lease + fixed-window limiter for authenticated spec imports.
  specImportLimits: defineTable({
    clerkOrgId: v.string(),
    userId: v.string(),
    windowStartedAt: v.number(),
    requestsInWindow: v.number(),
    leases: v.array(
      v.object({
        id: v.string(),
        expiresAt: v.number(),
      }),
    ),
    updatedAt: v.number(),
  }).index("by_scope", ["clerkOrgId", "userId"]),

  /** Cross-tenant import ceiling. Updated in same OCC transaction as user lease. */
  specImportGlobalLimits: defineTable({
    singleton: v.literal("global"),
    windowStartedAt: v.number(),
    requestsInWindow: v.number(),
    leases: v.array(
      v.object({
        id: v.string(),
        expiresAt: v.number(),
      }),
    ),
    updatedAt: v.number(),
  }).index("by_singleton", ["singleton"]),

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
      v.literal("provider_reconciliation_required"),
      v.literal("dead_letter"),
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

  // Durable processing journal for every accepted Stripe event. Lease tokens
  // reject stale completions; terminal states never strand accepted money.
  stripeEventOutbox: defineTable({
    paymentEventId: v.id("paymentEvents"),
    stripeEventId: v.string(),
    eventType: v.string(),
    objectId: v.string(),
    state: v.union(
      v.literal("queued"),
      v.literal("leased"),
      v.literal("retry_wait"),
      v.literal("applied"),
      v.literal("ignored"),
      v.literal("provider_reconciliation_required"),
      v.literal("dead_letter"),
    ),
    attemptCycle: v.number(),
    totalAttempts: v.number(),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    nextAttemptAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    reconciliationReason: v.optional(v.string()),
    resumedAt: v.optional(v.number()),
    resumedBy: v.optional(v.string()),
    appliedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_payment_event", ["paymentEventId"])
    .index("by_stripe_event", ["stripeEventId"])
    .index("by_state_next_attempt", ["state", "nextAttemptAt"])
    .index("by_state_lease", ["state", "leaseExpiresAt"]),

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
      v.union(
        v.literal("building"),
        v.literal("verified"),
        v.literal("provider_reconciliation_required"),
      ),
    ),
    /** Present only while this payment is fenced by a migration job. */
    financeMigrationJobId: v.optional(v.id("financialMigrationJobs")),
    financeReconciliationReason: v.optional(v.string()),
    financeReconciledAt: v.optional(v.number()),
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
    specVersionId: v.optional(v.id("specVersions")),
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
    .index("by_project_created", ["projectId", "createdAt"])
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
        v.literal("correlated_v2"),
      ),
    ),
    /** Canonical immutable create request, independent of provider retention. */
    requestFingerprint: v.optional(v.string()),
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

  // Persisted before first provider attempt. Unknown outcomes reconcile by
  // signed request fingerprint; unsafe retries never issue another create.
  publisherTransferDispatches: defineTable({
    transferId: v.id("publisherTransfers"),
    publisherOrganizationId: v.id("organizations"),
    stripeConnectedAccountId: v.string(),
    idempotencyKey: v.string(),
    requestFingerprint: v.string(),
    state: v.union(
      v.literal("prepared"),
      v.literal("leased"),
      v.literal("ambiguous"),
      v.literal("provider_verified"),
      v.literal("provider_reconciliation_required"),
    ),
    attemptCount: v.number(),
    firstAttemptAt: v.optional(v.number()),
    lastAttemptAt: v.optional(v.number()),
    safeRetryUntil: v.optional(v.number()),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    stripeTransferId: v.optional(v.string()),
    reconciliationReason: v.optional(v.string()),
    reconciliationPasses: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_transfer", ["transferId"])
    .index("by_state_updated", ["state", "updatedAt"])
    .index("by_request_fingerprint", ["requestFingerprint"]),

  // Resumable finance-v2 rollout. One versioned checkpoint owns cursors and
  // bounded accumulators; audits are append-only proof of each verified phase.
  financialMigrationJobs: defineTable({
    migrationKey: v.string(),
    /** Globally visible software-fence generation captured at start. */
    snapshotFenceToken: v.optional(v.string()),
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
    /** Hash over independently enumerated final facts, set with verified. */
    finalWatermark: v.optional(v.string()),
    finalWatermarkAt: v.optional(v.number()),
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
    .index("by_connected_account_status", [
      "stripeConnectedAccountId",
      "status",
    ])
    .index("by_stripe_payout", ["stripePayoutId"]),

  /** OCC hotspot fencing every credential/webhook-secret writer. */
  securityRolloutState: defineTable({
    singleton: v.literal("security-rollout"),
    generation: v.number(),
    updatedAt: v.number(),
  }).index("by_singleton", ["singleton"]),

  /** Read-only secret audit progress. No row repair or scrub occurs here. */
  securityRolloutAudits: defineTable({
    auditId: v.string(),
    generation: v.number(),
    /** Immutable creation-time fence captured before first page. */
    highWaterCreationTime: v.number(),
    phase: v.union(
      v.literal("credentials"),
      v.literal("webhooks"),
      v.literal("completed"),
      v.literal("invalidated"),
    ),
    credentialCursor: v.optional(v.union(v.string(), v.null())),
    webhookCursor: v.optional(v.union(v.string(), v.null())),
    credentialsScanned: v.number(),
    webhooksScanned: v.number(),
    current: v.number(),
    old: v.number(),
    plaintext: v.number(),
    corrupt: v.number(),
    broken: v.number(),
    zeroCorruption: v.boolean(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_audit", ["auditId"])
    .index("by_phase", ["phase", "createdAt"]),

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
});
