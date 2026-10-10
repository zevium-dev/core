import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { encryptCredential } from "./lib/credentialCrypto";
import {
  requireIdentity,
  requireOrgAdmin,
  requireProjectMember,
} from "./lib/auth";
import { enqueuePublishedProjectProjection } from "./registrySync";

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
const BLOCKED_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function normalizeName(input: string): string {
  const name = input.trim().toLowerCase();
  if (name.length === 0) throw new Error("Header name is required");
  if (name.length > 128) throw new Error("Header name is too long");
  if (!HEADER_NAME.test(name)) throw new Error("Header name is invalid");
  if (
    BLOCKED_HEADERS.has(name) ||
    name.startsWith("cf-") ||
    name.startsWith("x-zevium-")
  ) {
    throw new Error("This header cannot be configured");
  }
  return name;
}

function validateSecret(secret: string): string {
  if (secret.length === 0) throw new Error("Secret value is required");
  if (secret.length > 4096) throw new Error("Secret value is too long");
  if (secret.includes("\r") || secret.includes("\n")) {
    throw new Error("Secret value cannot contain newlines");
  }
  return secret;
}

export type UpstreamCredentialMetadata = {
  id: Id<"upstreamCredentials">;
  name: string;
  updatedAt: number;
};

export const listForProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<UpstreamCredentialMetadata[]> => {
    await requireProjectMember(ctx, args.projectId);
    const rows = await ctx.db
      .query("upstreamCredentials")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    return rows
      .map((row) => ({
        id: row._id,
        name: row.name,
        updatedAt: row.updatedAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const upsert = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    secret: v.string(),
  },
  handler: async (ctx, args): Promise<UpstreamCredentialMetadata> => {
    const { claims } = await requireProjectMember(ctx, args.projectId);
    requireOrgAdmin(claims);
    const name = normalizeName(args.name);
    const secret = validateSecret(args.secret);
    const encrypted = await encryptCredential(secret, args.projectId, name);
    const existing = await ctx.db
      .query("upstreamCredentials")
      .withIndex("by_project_name", (q) =>
        q.eq("projectId", args.projectId).eq("name", name),
      )
      .unique();
    const updatedAt = Date.now();
    const revision = (existing?.revision ?? 0) + 1;

    let id: Id<"upstreamCredentials">;
    if (existing === null) {
      id = await ctx.db.insert("upstreamCredentials", {
        projectId: args.projectId,
        name,
        ...encrypted,
        revision,
        updatedAt,
      });
    } else {
      id = existing._id;
      await ctx.db.patch(existing._id, {
        ...encrypted,
        secret: undefined,
        revision,
        updatedAt,
      });
    }
    await enqueuePublishedProjectProjection(ctx, args.projectId);
    return { id, name, updatedAt };
  },
});

export const remove = mutation({
  args: { credentialId: v.id("upstreamCredentials") },
  handler: async (
    ctx,
    args,
  ): Promise<{ deleted: Id<"upstreamCredentials"> }> => {
    // Role and active-org checks happen before touching caller-controlled id.
    // Missing and cross-org rows intentionally collapse to one error.
    const claims = await requireIdentity(ctx);
    requireOrgAdmin(claims);
    if (!claims.orgId) throw new Error("Upstream credential unavailable");
    const credential = await ctx.db.get(args.credentialId);
    if (credential === null) throw new Error("Upstream credential unavailable");
    const project = await ctx.db.get(credential.projectId);
    const org =
      project === null ? null : await ctx.db.get(project.organizationId);
    if (org === null || org.clerkOrgId !== claims.orgId) {
      throw new Error("Upstream credential unavailable");
    }
    await ctx.db.delete(credential._id);
    await enqueuePublishedProjectProjection(ctx, credential.projectId);
    return { deleted: credential._id };
  },
});
