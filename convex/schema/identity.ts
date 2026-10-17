import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  envelope,
  jobState,
  lifecycle,
  visibility,
  qualityEvidence,
} from "./common";
const providerRevoke = v.optional(
  v.object({
    state: jobState,
    attempts: v.number(),
    nextAttemptAt: v.number(),
    leaseUntil: v.optional(v.number()),
  }),
);
export const identityTables = {
  organizations: defineTable({
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
    publicHandle: v.string(),
    imageUrl: v.optional(v.string()),
    lastClerkEventAt: v.number(),
    archivedAt: v.optional(v.number()),
    revision: v.number(),
    stripeCustomerId: v.optional(v.string()),
    personalForClerkUserId: v.optional(v.string()),
    connect: v.optional(
      v.object({
        accountId: v.string(),
        revision: v.optional(v.number()),
        platformAccountId: v.string(),
        livemode: v.boolean(),
        status: v.union(
          v.literal("pending"),
          v.literal("active"),
          v.literal("restricted"),
          v.literal("closed"),
        ),
        requirements: v.array(v.string()),
        updatedAt: v.number(),
      }),
    ),
    connectOperation: v.optional(
      v.object({
        id: v.string(),
        kind: v.union(
          v.literal("account"),
          v.literal("onboarding"),
          v.literal("refresh"),
        ),
        requestFingerprint: v.string(),
        state: jobState,
        leaseToken: v.optional(v.string()),
        leaseUntil: v.optional(v.number()),
        nextAttemptAt: v.optional(v.number()),
        providerCursor: v.optional(v.string()),
        country: v.optional(v.string()),
        contactEmail: v.optional(v.string()),
        link: v.optional(
          v.object({
            id: v.string(),
            state: v.union(v.literal("pending"), v.literal("complete")),
            origin: v.string(),
            requestFingerprint: v.string(),
            createdAt: v.number(),
          }),
        ),
        piiExpiresAt: v.optional(v.number()),
        displayName: v.optional(v.string()),
        startedAt: v.optional(v.number()),
        platformAccountId: v.optional(v.string()),
      }),
    ),
  })
    .index("by_clerk", ["clerkOrgId"])
    .index("by_personal_user", ["personalForClerkUserId"])
    .index("by_handle", ["publicHandle"])
    .index("by_connect", ["connect.accountId"])
    .index("by_connect_due", [
      "connectOperation.state",
      "connectOperation.nextAttemptAt",
    ]),
  users: defineTable({
    clerkUserId: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    lastClerkEventAt: v.number(),
    deletedAt: v.optional(v.number()),
    signupPersonalOrganizationId: v.optional(v.id("organizations")),
    signupGrant: v.optional(
      v.object({
        refId: v.string(),
        organizationId: v.id("organizations"),
        grantedAt: v.number(),
      }),
    ),
  }).index("by_clerk", ["clerkUserId"]),
  orgTombstones: defineTable({
    clerkOrgId: v.string(),
    organizationId: v.optional(v.id("organizations")),
    publisherHandle: v.optional(v.string()),
    sourceTimestamp: v.number(),
    archivedAt: v.number(),
  })
    .index("by_clerk", ["clerkOrgId"])
    .index("by_handle", ["publisherHandle"]),
  projects: defineTable({
    organizationId: v.id("organizations"),
    slug: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    tags: v.array(v.string()),
    status: v.union(v.literal("draft"), v.literal("published")),
    visibility: visibility,
    desiredVisibility: visibility,
    qualityStatus: v.union(
      v.literal("active"),
      v.literal("suspended"),
      v.literal("recovering"),
    ),
    revision: v.number(),
    latestVersionId: v.optional(v.id("specVersions")),
    publicationGeneration: v.number(),
    houseOperated: v.boolean(),
    discoverable: v.boolean(),
    searchText: v.string(),
    sortName: v.string(),
    minCost: v.optional(v.number()),
    maxCost: v.optional(v.number()),
    endpointCount: v.number(),
    hasFreeTier: v.boolean(),
    publishedAt: v.optional(v.number()),
    draft: v.optional(
      v.object({
        revision: v.number(),
        hash: v.string(),
        savedAt: v.number(),
        readiness: v.optional(
          v.object({
            draftHash: v.string(),
            credentialFingerprint: v.string(),
            url: v.string(),
            method: v.string(),
            testedAt: v.number(),
          }),
        ),
      }),
    ),
    retirement: v.optional(
      v.object({
        state: v.union(v.literal("scheduled"), v.literal("retired")),
        revision: v.number(),
        message: v.string(),
        startedAt: v.number(),
        sunsetAt: v.number(),
        retiredAt: v.optional(v.number()),
        cleanupPhase: v.union(
          v.literal("pending"),
          v.literal("notifications"),
          v.literal("credentials"),
          v.literal("complete"),
        ),
        cursor: v.optional(v.string()),
      }),
    ),
    quality: v.object({
      versionId: v.optional(v.id("specVersions")),
      nextProbeAt: v.optional(v.number()),
      leaseId: v.optional(v.string()),
      leaseUntil: v.optional(v.number()),
      recoveryPasses: v.number(),
      probeTarget: v.optional(
        v.object({
          url: v.string(),
          method: v.union(v.literal("GET"), v.literal("HEAD")),
        }),
      ),
      snapshot: v.union(v.null(), qualityEvidence),
    }),
    reviewSummary: v.object({
      count: v.number(),
      ratingSum: v.number(),
      distribution: v.object({
        one: v.number(),
        two: v.number(),
        three: v.number(),
        four: v.number(),
        five: v.number(),
      }),
    }),
    webhook: v.optional(
      v.object({
        url: v.string(),
        active: v.boolean(),
        current: envelope,
        secretVersion: v.number(),
        revealedAt: v.optional(v.number()),
        previous: v.optional(envelope),
        previousVersion: v.optional(v.number()),
        previousValidUntil: v.optional(v.number()),
        createdAt: v.number(),
        retiringAt: v.optional(v.number()),
      }),
    ),
  })
    .index("by_org_slug", ["organizationId", "slug"])
    .index("by_retire", ["retirement.state", "retirement.sunsetAt"])
    .index("by_probe", ["quality.nextProbeAt"])
    .index("by_discoverable_newest", ["discoverable", "publishedAt"])
    .index("by_discoverable_name", ["discoverable", "sortName"])
    .index("by_discoverable_cost", ["discoverable", "minCost", "sortName"])
    .index("by_status", ["status"])
    .searchIndex("search_public", {
      searchField: "searchText",
      filterFields: ["discoverable", "hasFreeTier"],
    }),
  routeTombstones: defineTable({
    publisherHandle: v.string(),
    projectSlug: v.string(),
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    reservedAt: v.number(),
    revision: v.number(),
    retiredAt: v.optional(v.number()),
  })
    .index("by_route", ["publisherHandle", "projectSlug"])
    .index("by_project", ["projectId"])
    .index("by_org", ["organizationId"]),
  projectDrafts: defineTable({
    projectId: v.id("projects"),
    text: v.string(),
    hash: v.string(),
    revision: v.number(),
    savedAt: v.number(),
  }).index("by_project", ["projectId"]),
  specVersions: defineTable({
    projectId: v.id("projects"),
    version: v.string(),
    spec: v.string(),
    contentHash: v.string(),
    publishedAt: v.number(),
    deprecatedAt: v.optional(v.number()),
    sunsetAt: v.optional(v.number()),
    deprecationMessage: v.optional(v.string()),
    noticeRevision: v.optional(v.number()),
  })
    .index("by_version", ["projectId", "version"])
    .index("by_project_time", ["projectId", "publishedAt"]),
  upstreamCredentials: defineTable({
    projectId: v.id("projects"),
    name: v.string(),
    envelope: envelope,
    revision: v.number(),
    updatedAt: v.number(),
  }).index("by_project_name", ["projectId", "name"]),
  /** One row per member+org: first-OAuth-connect key auto-creation (#324). */
  mcpKeyProvisions: defineTable({
    organizationId: v.id("organizations"),
    userId: v.string(),
    state: v.union(
      v.literal("pending"),
      v.literal("created"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    leaseUntil: v.number(),
    nextAttemptAt: v.number(),
    keyId: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_org_user", ["organizationId", "userId"]),
  apiKeys: defineTable(
    v.union(
      v.object({
        kind: v.literal("key"),
        organizationId: v.id("organizations"),
        clerkOrgId: v.string(),
        keyId: v.string(),
        keyName: v.string(),
        ownerUserId: v.string(),
        subjectUserId: v.string(),
        secretSha256: v.string(),
        verifiedProjectionHash: v.string(),
        verifiedAt: v.number(),
        keyFamilyId: v.string(),
        budgetId: v.string(),
        budgetRevision: v.number(),
        scopes: v.array(v.string()),
        monthlyCapCredits: v.optional(v.number()),
        lifecycle: lifecycle,
        expiresAt: v.optional(v.number()),
        graceUntil: v.optional(v.number()),
        rotatedFromKeyId: v.optional(v.string()),
        revokedAt: v.optional(v.number()),
        membershipRevokedAt: v.optional(v.number()),
        edgeRevision: v.number(),
        updatedAt: v.number(),
        providerRevoke: providerRevoke,
      }),
      v.object({
        kind: v.literal("rotation"),
        organizationId: v.id("organizations"),
        actorUserId: v.string(),
        operationId: v.string(),
        oldKeyId: v.string(),
        newKeyId: v.optional(v.string()),
        providerRevoke: providerRevoke,
        state: v.union(
          v.literal("pending"),
          v.literal("complete"),
          v.literal("failed"),
        ),
        requestFingerprint: v.string(),
        leaseUntil: v.optional(v.number()),
        failure: v.optional(v.string()),
        createdAt: v.number(),
        updatedAt: v.number(),
      }),
    ),
  )
    .index("by_key", ["keyId"])
    .index("by_new_key", ["newKeyId"])
    .index("by_hash", ["secretSha256"])
    .index("by_org_owner", ["kind", "organizationId", "ownerUserId"])
    .index("by_owner", ["kind", "ownerUserId"])
    .index("by_org", ["kind", "organizationId"])
    .index("by_revoke", [
      "providerRevoke.state",
      "providerRevoke.nextAttemptAt",
    ])
    .index("by_grace", ["lifecycle", "graceUntil"])
    .index("by_rotation", [
      "kind",
      "organizationId",
      "actorUserId",
      "operationId",
    ])
    .index("by_active_rotation", [
      "kind",
      "organizationId",
      "oldKeyId",
      "state",
    ]),
};
