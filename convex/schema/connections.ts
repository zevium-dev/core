import { defineTable } from "convex/server";
import { v } from "convex/values";
import { envelope } from "./common";

export const connectionTables = {
  // Consumer-connected third-party accounts: one OAuth grant per row, owned by
  // the consumer org, issued to Zevium's own client for `provider`. Tokens are
  // encrypted and bound to the row's public id.
  oauthConnections: defineTable({
    publicId: v.string(),
    clerkOrgId: v.string(),
    projectId: v.id("projects"),
    /** `publisherHandle/projectSlug` at creation; display only. */
    api: v.string(),
    scheme: v.string(),
    /** Registry id (`packages/shared/src/oauth-providers.ts`). */
    provider: v.string(),
    label: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("exchanging"),
      v.literal("active"),
      v.literal("reauthorize"),
      v.literal("failed"),
      v.literal("revoked"),
    ),
    requestedScopes: v.array(v.string()),
    grantedScopes: v.optional(v.array(v.string())),
    createdByKeyId: v.string(),
    redirectUri: v.string(),
    returnUrl: v.optional(v.string()),
    /** SHA-256 of the OAuth `state`; cleared once the callback claims it. */
    stateHash: v.optional(v.string()),
    codeVerifier: v.optional(envelope),
    pendingExpiresAt: v.optional(v.number()),
    accessToken: v.optional(envelope),
    refreshToken: v.optional(envelope),
    accessExpiresAt: v.optional(v.number()),
    tokenRevision: v.number(),
    refreshLeaseUntil: v.optional(v.number()),
    /** Long-lived tokens only: when the renewal cron refreshes this grant. */
    renewAt: v.optional(v.number()),
    error: v.optional(v.string()),
    connectedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_public_id", ["publicId"])
    .index("by_state_hash", ["stateHash"])
    .index("by_org_status", ["clerkOrgId", "status"])
    .index("by_org_project_scheme_status", [
      "clerkOrgId",
      "projectId",
      "scheme",
      "status",
    ])
    .index("by_project", ["projectId"])
    .index("by_status_expiry", ["status", "pendingExpiresAt"])
    .index("by_status_updated", ["status", "updatedAt"])
    .index("by_status_renew", ["status", "renewAt"]),
};
