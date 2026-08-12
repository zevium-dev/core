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
    /** Set before bounded organization retirement starts. */
    retiringAt: v.optional(v.number()),
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
    /** Route is archived before bounded child cleanup starts. */
    retiringAt: v.optional(v.number()),
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
    serverOrigin: v.string(),
    credentialRevision: v.number(),
    /** Hash of every credential identity + revision; deletion changes it. */
    credentialFingerprint: v.optional(v.string()),
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
  }).index("by_organization", ["organizationId"]),

  // Append-only, signed credit ledger. `amount` is never inferred from kind.
  walletEntries: defineTable({
    walletId: v.id("wallets"),
    kind: v.union(
      v.literal("payment_grant"),
      v.literal("usage_settlement"),
      v.literal("refund_reversal"),
      v.literal("dispute_reversal"),
      v.literal("admin_adjustment"),
    ),
    amount: v.number(),
    /** Globally unique business id; duplicate delivery is a no-op. */
    refId: v.string(),
    /** Wallet sequence after this entry was atomically materialized. */
    sequence: v.number(),
    paymentId: v.optional(v.id("payments")),
    usageEventId: v.optional(v.id("usageEvents")),
    createdAt: v.number(),
  })
    .index("by_wallet", ["walletId"])
    .index("by_ref", ["refId"]),

  // Per-call metering events (gateway → Convex, async)
  usageEvents: defineTable({
    /** Public opaque row identity; Convex document ids never cross member APIs. */
    publicId: v.optional(v.string()),
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    endpoint: v.string(),
    method: v.string(),
    credits: v.number(),
    status: v.number(),
    latencyMs: v.number(),
    keyId: v.string(),
    /** Derived from authoritative keySettings during ingest, never from gateway input. */
    ownerUserId: v.optional(v.string()),
    at: v.number(),
    /**
     * Stable gateway settlement reference (`settle:{reservationId}`).
     * Optional solely for pre-ledger historical analytics rows; every new
     * Wallet DO ingest validates and persists it.
     */
    settleRefId: v.optional(v.string()),
  })
    .index("by_org", ["organizationId"])
    .index("by_project", ["projectId"])
    .index("by_org_at", ["organizationId", "at"])
    .index("by_org_owner_at", ["organizationId", "ownerUserId", "at"])
    .index("by_project_at", ["projectId", "at"])
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

  // Per-key controls (Clerk owns the key itself; this is Zevium metadata).
  // Gateway pulls these via the internal-secret ledger sync — never per-request.
  keySettings: defineTable({
    clerkOrgId: v.string(),
    // Transitional optional only for pre-policy rows. Member queries and all
    // writes ignore unclaimed rows until Clerk-backed broker verifies owner.
    ownerUserId: v.optional(v.string()),
    keyId: v.string(),
    /** False means Clerk key was observed but never provisioned by Zevium. */
    managed: v.optional(v.boolean()),
    /** Stable budget identity shared by every physical key in a rotation. */
    familyId: v.optional(v.string()),
    /** Monthly credit cap; undefined = unlimited. Enforced by the wallet DO. */
    monthlyCapCredits: v.optional(v.number()),
    disabled: v.boolean(),
    /** Set when this key replaced another during rotation. */
    rotatedFromKeyId: v.optional(v.string()),
    /** Old key keeps working until this ms epoch (rotation grace). */
    graceUntil: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
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
    .index("by_family", ["clerkOrgId", "ownerUserId", "familyId"])
    .index("by_key", ["keyId"]),

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

  /** Svix ids fence replayed Clerk lifecycle events. */
  clerkWebhookReceipts: defineTable({
    svixId: v.string(),
    eventType: v.string(),
    receivedAt: v.number(),
  }).index("by_svix_id", ["svixId"]),

  /**
   * Durable membership fence. Deletion bumps revision before any key cleanup;
   * in-flight create/rotation completion must still match this revision.
   */
  clerkMembershipStates: defineTable({
    clerkOrgId: v.string(),
    userId: v.string(),
    status: v.union(v.literal("active"), v.literal("revoked")),
    revision: v.number(),
    updatedAt: v.number(),
  })
    .index("by_membership", ["clerkOrgId", "userId"])
    .index("by_status", ["status", "updatedAt"]),

  /**
   * Durable signed edge key-revocation outbox. Delivery retries until the wallet
   * DO returns a request-bound HMAC acknowledgement. No secrets in body.
   */
  edgeKeyRevocationOutbox: defineTable({
    eventId: v.string(),
    clerkOrgId: v.string(),
    keyId: v.string(),
    revision: v.number(),
    reason: v.union(
      v.literal("membership_deleted"),
      v.literal("admin_revoked"),
      v.literal("rotated"),
      v.literal("provider_revoked"),
      v.literal("disabled"),
    ),
    bodyJson: v.string(),
    bodySha256: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("delivering"),
      v.literal("acked"),
    ),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    leaseToken: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    lastErrorCode: v.optional(v.string()),
    ackJson: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    ackedAt: v.optional(v.number()),
  })
    .index("by_event", ["eventId"])
    .index("by_key_revision", ["keyId", "revision"])
    .index("by_status_next", ["status", "nextAttemptAt"])
    .index("by_status_lease", ["status", "leaseUntil"]),

  /**
   * Durable provider cleanup after membership revocation. Jobs never age out on
   * failure; completion requires two identical provider snapshots with zero
   * scoped live keys for the exact revoked membership revision.
   */
  membershipCleanupJobs: defineTable({
    clerkOrgId: v.string(),
    userId: v.string(),
    membershipRevision: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
    ),
    attempts: v.number(),
    zeroVerificationPasses: v.number(),
    /** Durable offset through one bounded provider verification pass. */
    cursorOffset: v.optional(v.number()),
    scanExpectedTotal: v.optional(v.number()),
    /** At most 2,000 opaque provider ids; used only to prove stable snapshots. */
    scanProviderIds: v.optional(v.array(v.string())),
    previousZeroFingerprint: v.optional(v.string()),
    leaseToken: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    nextRunAt: v.number(),
    lastErrorCode: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_membership", ["clerkOrgId", "userId"])
    .index("by_due", ["status", "nextRunAt"])
    .index("by_lease", ["status", "leaseUntil"]),

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

  /** Tombstones make large archive/secret retirement bounded and resumable. */
  retirementJobs: defineTable({
    resourceKey: v.string(),
    kind: v.union(
      v.literal("project"),
      v.literal("organization"),
      v.literal("webhook"),
    ),
    resourceId: v.string(),
    phase: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    failureAttempts: v.optional(v.number()),
    nextRunAt: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_resource", ["resourceKey"])
    .index("by_due", ["status", "nextRunAt"]),

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
    attempts: v.number(),
    lastError: v.optional(v.string()),
    receivedAt: v.number(),
    processedAt: v.optional(v.number()),
  })
    .index("by_stripe_event", ["stripeEventId"])
    .index("by_object", ["objectId"]),

  payments: defineTable({
    organizationId: v.id("organizations"),
    checkoutIntentId: v.id("checkoutIntents"),
    stripeCheckoutSessionId: v.string(),
    stripePaymentIntentId: v.optional(v.string()),
    stripeChargeId: v.optional(v.string()),
    amount: v.number(),
    currency: v.string(),
    grantedCredits: v.number(),
    reversedCredits: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("paid"),
      v.literal("partially_refunded"),
      v.literal("refunded"),
      v.literal("disputed"),
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

  // Each successful settlement creates exactly one immutable publisher split.
  publisherEarnings: defineTable({
    publisherOrganizationId: v.id("organizations"),
    /** Immutable published project that earned this settlement. */
    projectId: v.optional(v.id("projects")),
    usageSettlementRefId: v.string(),
    grossCredits: v.number(),
    platformFeeCredits: v.number(),
    netCredits: v.number(),
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
    .index("by_settlement", ["usageSettlementRefId"])
    .index("by_status_available", ["status", "availableAt"]),

  publisherTransfers: defineTable({
    publisherOrganizationId: v.id("organizations"),
    stripeConnectedAccountId: v.string(),
    amount: v.number(),
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
