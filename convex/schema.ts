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
  }).index("by_organization", ["organizationId"]),

  // Append-only, signed credit ledger. `amount` is never inferred from kind.
  walletEntries: defineTable({
    walletId: v.id("wallets"),
    kind: v.union(
      v.literal("payment_grant"),
      v.literal("usage_settlement"),
      v.literal("refund_reversal"),
      v.literal("dispute_reversal"),
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
    .index("by_ref", ["refId"]),

  // Per-call metering events (gateway → Convex, async)
  usageEvents: defineTable({
    organizationId: v.id("organizations"),
    /** Server-derived Clerk user that owned key at settlement time. */
    ownerUserId: v.optional(v.string()),
    projectId: v.id("projects"),
    /** Optional-first migration; all new gateway rows require this. */
    specVersionId: v.optional(v.id("specVersions")),
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
    .index("by_project_at", ["projectId", "at"])
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
    keyId: v.string(),
    /** Verified Clerk subject. Optional only during legacy backfill. */
    ownerUserId: v.optional(v.string()),
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
    /** Monthly credit cap; undefined = unlimited. Enforced by the wallet DO. */
    monthlyCapCredits: v.optional(v.number()),
    disabled: v.boolean(),
    /** Set when this key replaced another during rotation. */
    rotatedFromKeyId: v.optional(v.string()),
    /** Old key keeps working until this ms epoch (rotation grace). */
    graceUntil: v.optional(v.number()),
    /** Transitional deny state when legacy raw material cannot be re-hashed. */
    rotationRequiredAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_org", ["clerkOrgId"])
    .index("by_owner", ["clerkOrgId", "ownerUserId"])
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
    /** Reversal target projected into publisher earnings. */
    publisherClawbackTargetCredits: v.number(),
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
    .index("by_payment", ["paymentId", "createdAt"]),

  // Each successful settlement creates exactly one immutable publisher split.
  publisherEarnings: defineTable({
    publisherOrganizationId: v.id("organizations"),
    consumerOrganizationId: v.id("organizations"),
    /** Immutable published project that earned this settlement. */
    projectId: v.optional(v.id("projects")),
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
    .index("by_status_available", ["status", "availableAt"]),

  // Materialized publisher settlement buckets. `availableAtoms` may be
  // negative after clawing back earnings already paid; future earnings repay
  // that debt before another transfer can be prepared.
  publisherBalances: defineTable({
    publisherOrganizationId: v.id("organizations"),
    availableAtoms: v.number(),
    allocatedAtoms: v.number(),
    paidAtoms: v.number(),
    sequence: v.number(),
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
      v.literal("dispute_restoration"),
      v.literal("transfer_allocation"),
      v.literal("transfer_succeeded"),
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
    .index("by_ref", ["refId"]),

  publisherClawbacks: defineTable({
    paymentId: v.id("payments"),
    consumerOrganizationId: v.id("organizations"),
    publisherOrganizationId: v.id("organizations"),
    earningId: v.id("publisherEarnings"),
    sourceKind: v.union(v.literal("refund"), v.literal("dispute")),
    sourceRef: v.string(),
    grossCredits: v.number(),
    amountAtoms: v.number(),
    restoredGrossCredits: v.number(),
    restoredAtoms: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_payment", ["paymentId", "createdAt"])
    .index("by_source", ["sourceRef"]),

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
    .index("by_idempotency_key", ["idempotencyKey"])
    .index("by_stripe_transfer", ["stripeTransferId"]),

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
    .index("by_stripe_payout", ["stripePayoutId"]),
});
