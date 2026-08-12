import { v } from "convex/values";

import { internalMutation, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { encryptCredential } from "./lib/credentialCrypto";
import { requireOrgAdmin, requireProjectMember } from "./lib/auth";

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
    const encrypted = await encryptCredential(secret);
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
    return { id, name, updatedAt };
  },
});

export const remove = mutation({
  args: { credentialId: v.id("upstreamCredentials") },
  handler: async (
    ctx,
    args,
  ): Promise<{ deleted: Id<"upstreamCredentials"> }> => {
    const credential = await ctx.db.get(args.credentialId);
    if (credential === null) throw new Error("Upstream credential not found");
    const { claims } = await requireProjectMember(ctx, credential.projectId);
    requireOrgAdmin(claims);
    await ctx.db.delete(credential._id);
    return { deleted: credential._id };
  },
});

/** One-shot deployment migration for legacy plaintext rows. Remove after all rows report zero. */
export const migrateLegacyPlaintext = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ migrated: number; remaining: number }> => {
    const rows = await ctx.db.query("upstreamCredentials").collect();
    let migrated = 0;
    let remaining = 0;
    for (const row of rows) {
      if (row.ciphertext && row.iv && row.keyVersion) {
        if (row.secret !== undefined) {
          await ctx.db.patch(row._id, { secret: undefined });
          migrated += 1;
        }
        continue;
      }
      if (row.secret === undefined) {
        remaining += 1;
        continue;
      }
      const encrypted = await encryptCredential(row.secret);
      await ctx.db.patch(row._id, { ...encrypted, secret: undefined });
      migrated += 1;
    }
    return { migrated, remaining };
  },
});
