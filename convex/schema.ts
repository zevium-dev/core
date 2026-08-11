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
    deprecationStartedAt: v.optional(v.number()),
    sunsetAt: v.optional(v.number()),
    deprecationMessage: v.optional(v.string()),
    /** Audit tombstone after sunset cleanup; project row remains immutable history. */
    retiredAt: v.optional(v.number()),
  })
    .index("by_org", ["organizationId"])
    .index("by_org_slug", ["organizationId", "slug"])
    .index("by_visibility_status", ["visibility", "status"])
    .index("by_sunset", ["sunsetAt"]),

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
    createdAt: v.number(),
  })
    .index("by_wallet", ["walletId"])
    .index("by_ref", ["refId"]),

  // Per-call metering events (gateway → Convex, async)
  usageEvents: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
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
  })
    .index("by_org", ["organizationId"])
    .index("by_project", ["projectId"])
    .index("by_org_at", ["organizationId", "at"])
    .index("by_org_project_at", ["organizationId", "projectId", "at"])
    .index("by_org_key_at", ["organizationId", "keyId", "at"])
    .index("by_org_project_key_at", [
      "organizationId",
      "projectId",
      "keyId",
      "at",
    ])
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
