import { defineTable } from "convex/server";
import { v } from "convex/values";
import { jobState, content } from "./common";
export const readTables = {
  connectedPayouts: defineTable({
    accountId: v.string(),
    providerPayoutId: v.string(),
    amountCents: v.number(),
    currency: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("in_transit"),
      v.literal("paid"),
      v.literal("failed"),
      v.literal("canceled"),
    ),
    arrivalDate: v.optional(v.number()),
    failureCode: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_provider", ["providerPayoutId"])
    .index("by_account_time", ["accountId", "updatedAt"]),
  specEmbeddings: defineTable(
    v.union(
      v.object({
        model: v.string(),
        contentHash: v.string(),
        embedding: v.array(v.number()),
        updatedAt: v.number(),
        kind: v.literal("listing"),
        projectId: v.id("projects"),
        specVersionId: v.id("specVersions"),
        text: v.string(),
        dimensions: v.literal(768),
      }),
      v.object({
        model: v.string(),
        contentHash: v.string(),
        embedding: v.array(v.number()),
        updatedAt: v.number(),
        kind: v.literal("query"),
        queryHash: v.string(),
        expiresAt: v.number(),
        dimensions: v.literal(768),
      }),
    ),
  )
    .index("by_project", ["projectId"])
    .index("by_query", ["model", "queryHash"])
    .index("by_expiry", ["expiresAt"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 768,
      filterFields: ["kind"],
    }),
  catalogueIndex: defineTable(
    v.union(
      v.object({
        kind: v.literal("tag"),
        projectId: v.id("projects"),
        tag: v.string(),
        discoverable: v.boolean(),
        publishedAt: v.number(),
        sortName: v.string(),
        minCost: v.number(),
      }),
      v.object({
        kind: v.literal("facet"),
        facetKey: v.string(),
        shard: v.number(),
        count: v.number(),
        updatedAt: v.number(),
      }),
    ),
  )
    .index("by_project", ["kind", "projectId"])
    .index("by_tag_newest", ["kind", "tag", "discoverable", "publishedAt"])
    .index("by_tag_name", ["kind", "tag", "discoverable", "sortName"])
    .index("by_tag_cost", [
      "kind",
      "tag",
      "discoverable",
      "minCost",
      "sortName",
    ])
    .index("by_facet", ["kind", "facetKey", "shard"]),
  qualityEvents: defineTable(
    v.union(
      v.object({
        kind: v.literal("probe"),
        projectId: v.id("projects"),
        specVersionId: v.id("specVersions"),
        generation: v.number(),
        executionId: v.string(),
        at: v.number(),
        outcome: v.union(
          v.literal("healthy"),
          v.literal("http_error"),
          v.literal("network_error"),
          v.literal("timeout"),
          v.literal("blocked_target"),
          v.literal("dns_error"),
          v.literal("tls_error"),
        ),
        statusCode: v.optional(v.number()),
        latencyMs: v.optional(v.number()),
      }),
      v.object({
        kind: v.literal("incident"),
        projectId: v.id("projects"),
        specVersionId: v.id("specVersions"),
        at: v.number(),
        state: v.union(v.literal("open"), v.literal("closed")),
        closedAt: v.optional(v.number()),
        reason: v.string(),
        failureCount: v.number(),
        recoveryPasses: v.number(),
      }),
    ),
  )
    .index("by_execution", ["executionId"])
    .index("by_project_kind_time", ["projectId", "kind", "at"])
    .index("by_version_kind_time", [
      "projectId",
      "specVersionId",
      "kind",
      "at",
    ]),
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
    sortKey: v.string(),
    contentRevision: v.number(),
    moderationGeneration: v.number(),
    openReportCount: v.number(),
    hasOpenReports: v.boolean(),
    queueSortKey: v.optional(v.string()),
    latestReportReason: v.optional(v.string()),
    latestReportAt: v.optional(v.number()),
    response: v.optional(
      v.object({
        body: v.string(),
        createdBy: v.string(),
        updatedBy: v.string(),
        createdAt: v.number(),
        updatedAt: v.number(),
      }),
    ),
  })
    .index("by_consumer_project", ["consumerOrganizationId", "projectId"])
    .index("by_public", ["projectId", "active", "hidden", "sortKey"])
    .index("by_state", ["active", "hidden", "sortKey"])
    .index("by_reported", ["hasOpenReports", "queueSortKey"]),
  reviewEvents: defineTable(
    v.union(
      v.object({
        reviewId: v.id("reviews"),
        actorUserId: v.string(),
        actorOrganizationId: v.optional(v.id("organizations")),
        at: v.number(),
        sortKey: v.string(),
        contentRevision: v.number(),
        moderationGeneration: v.number(),
        kind: v.literal("report"),
        reason: v.string(),
        status: v.union(v.literal("open"), v.literal("resolved")),
        resolvedAt: v.optional(v.number()),
      }),
      v.object({
        reviewId: v.id("reviews"),
        actorUserId: v.string(),
        actorOrganizationId: v.optional(v.id("organizations")),
        at: v.number(),
        sortKey: v.string(),
        contentRevision: v.number(),
        moderationGeneration: v.number(),
        kind: v.literal("moderation"),
        action: v.union(
          v.literal("hide"),
          v.literal("restore"),
          v.literal("dismiss"),
        ),
        reason: v.string(),
        snapshot: content,
      }),
      v.object({
        reviewId: v.id("reviews"),
        actorUserId: v.string(),
        actorOrganizationId: v.optional(v.id("organizations")),
        at: v.number(),
        sortKey: v.string(),
        contentRevision: v.number(),
        moderationGeneration: v.number(),
        kind: v.literal("edit"),
        previous: content,
        current: content,
      }),
      v.object({
        reviewId: v.id("reviews"),
        actorUserId: v.string(),
        actorOrganizationId: v.optional(v.id("organizations")),
        at: v.number(),
        sortKey: v.string(),
        contentRevision: v.number(),
        moderationGeneration: v.number(),
        kind: v.literal("response_edit"),
        previous: v.union(v.null(), v.string()),
        current: v.union(v.null(), v.string()),
      }),
    ),
  )
    .index("by_review_kind_time", ["reviewId", "kind", "at"])
    .index("by_kind_time", ["kind", "sortKey"])
    .index("by_reporter_review", ["actorOrganizationId", "reviewId", "kind"])
    .index("by_review_status", [
      "reviewId",
      "kind",
      "status",
      "moderationGeneration",
    ]),
  webhookDeliveries: defineTable({
    projectId: v.id("projects"),
    deliveryId: v.string(),
    event: v.string(),
    payload: v.string(),
    secretVersion: v.number(),
    state: jobState,
    attempts: v.number(),
    leaseToken: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    nextAttemptAt: v.optional(v.number()),
    lastErrorCode: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_delivery", ["deliveryId"])
    .index("by_project_time", ["projectId", "createdAt"])
    .index("by_due", ["state", "nextAttemptAt"])
    .index("by_lease", ["state", "leaseUntil"]),
  notificationPreferences: defineTable({
    clerkOrgId: v.string(),
    clerkUserId: v.string(),
    emailOptOut: v.boolean(),
  }).index("by_org_user", ["clerkOrgId", "clerkUserId"]),
  // Permanent receipts outlive provider retention and notification revisions.
  notificationEmailDeliveries: defineTable({
    notificationId: v.id("notifications"),
    revision: v.number(),
    clerkUserId: v.string(),
    emailId: v.string(),
  }).index("by_notification_revision_user", [
    "notificationId",
    "revision",
    "clerkUserId",
  ]),
  // Evidence is paginated child rows, never arrays growing on a case document.
  financeReconciliationCases: defineTable(
    v.union(
      v.object({
        rowKind: v.literal("case"),
        kind: v.union(
          v.literal("transfer"),
          v.literal("transfer_orphan"),
          v.literal("account_create"),
          v.literal("foreign_stripe_event"),
          v.literal("foreign_test_payout"),
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
        candidateCount: v.number(),
        providerCursor: v.optional(v.string()),
        attempts: v.number(),
        resolution: v.optional(v.string()),
        createdAt: v.number(),
        updatedAt: v.number(),
      }),
      v.object({
        rowKind: v.union(v.literal("candidate"), v.literal("provider_request")),
        caseId: v.id("financeReconciliationCases"),
        value: v.string(),
        createdAt: v.number(),
      }),
    ),
  )
    .index("by_status_updated", ["rowKind", "status", "updatedAt"])
    .index("by_transfer", ["rowKind", "transferId"])
    .index("by_operation", ["rowKind", "operationId"])
    .index("by_case_evidence", ["caseId", "rowKind", "value"]),
  notifications: defineTable({
    organizationId: v.id("organizations"),
    refId: v.string(),
    kind: v.string(),
    title: v.string(),
    body: v.string(),
    publisherHandle: v.optional(v.string()),
    projectSlug: v.optional(v.string()),
    readAt: v.optional(v.number()),
    createdAt: v.number(),
    emailState: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("queued"),
        v.literal("skipped"),
        v.literal("failed"),
      ),
    ),
    emailRevision: v.optional(v.number()),
    emailOffset: v.optional(v.number()),
    emailAttempts: v.optional(v.number()),
    emailNextAttemptAt: v.optional(v.number()),
  })
    .index("by_ref", ["refId"])
    .index("by_org_time", ["organizationId", "createdAt"])
    .index("by_org_read", ["organizationId", "readAt", "createdAt"]),
  specImportLeases: defineTable({
    organizationId: v.id("organizations"),
    userId: v.string(),
    leaseId: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_principal", ["organizationId", "userId", "expiresAt"])
    .index("by_lease", ["leaseId"])
    .index("by_expiry", ["expiresAt"]),
};
