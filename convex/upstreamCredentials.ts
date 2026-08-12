import { v } from "convex/values";

import { internalMutation, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  credentialBinding,
  encryptCredential,
  migrateStoredSecret,
} from "./lib/credentialCrypto";
import {
  requireIdentity,
  requireOrgAdmin,
  requireProjectMember,
} from "./lib/auth";
import { enqueueRouteUpsert } from "./registrySync";

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
    const updatedAt = Date.now();
    const existing = await ctx.db
      .query("upstreamCredentials")
      .withIndex("by_project_name", (q) =>
        q.eq("projectId", args.projectId).eq("name", name),
      )
      .unique();

    let id: Id<"upstreamCredentials">;
    if (existing === null) {
      id = await ctx.db.insert("upstreamCredentials", {
        projectId: args.projectId,
        name,
        ...encrypted,
        updatedAt,
      });
    } else {
      id = existing._id;
      await ctx.db.patch(existing._id, { ...encrypted, updatedAt });
    }
    await enqueueRouteUpsert(ctx, args.projectId);
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
    await enqueueRouteUpsert(ctx, credential.projectId);
    return { deleted: credential._id };
  },
});

export type CredentialMigrationPage = {
  scanned: number;
  current: number;
  old: number;
  broken: number;
  corrupt: number;
  plaintext: number;
  recovered: number;
  rewrapped: number;
  scrubbed: number;
  continueCursor: string;
  isDone: boolean;
};

/** Cursor-bounded dual-envelope migration. Repeat until isDone, then audit again. */
export const migrateLegacyPlaintext = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<CredentialMigrationPage> => {
    const requested = args.numItems ?? 50;
    const numItems = Math.max(1, Math.min(100, Math.floor(requested)));
    const result = await ctx.db.query("upstreamCredentials").paginate({
      cursor: args.cursor ?? null,
      numItems,
    });
    const counts = {
      scanned: result.page.length,
      current: 0,
      old: 0,
      broken: 0,
      corrupt: 0,
      plaintext: 0,
      recovered: 0,
      rewrapped: 0,
      scrubbed: 0,
    };
    for (const row of result.page) {
      const migration = await migrateStoredSecret(
        row,
        credentialBinding(row.projectId, row.name),
      );
      if (migration.plaintext) counts.plaintext += 1;
      if (migration.old) counts.old += 1;
      if (migration.corrupt) counts.corrupt += 1;
      if (migration.broken) counts.broken += 1;
      else counts.current += 1;
      if (migration.recovered) counts.recovered += 1;
      if (migration.rewrapped) counts.rewrapped += 1;
      if (migration.scrubbed) counts.scrubbed += 1;
      if (migration.patch) {
        await ctx.db.patch(row._id, {
          ...migration.patch,
          updatedAt: Date.now(),
        });
      }
    }
    return {
      ...counts,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});
