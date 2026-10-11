import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  requireActiveOrg,
  requireOrgAdmin,
  requireProjectAdmin,
  requireProjectMember,
} from "./lib/auth";
import { credentialBinding, encryptSecret } from "./lib/credentialCrypto";
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
  if (name.length === 0) throw new ConvexError("Header name is required");
  if (name.length > 128) throw new ConvexError("Header name is too long");
  if (!HEADER_NAME.test(name)) throw new ConvexError("Header name is invalid");
  if (
    BLOCKED_HEADERS.has(name) ||
    name.startsWith("cf-") ||
    name.startsWith("x-zevium-")
  ) {
    throw new ConvexError("This header cannot be configured");
  }
  return name;
}

function validateSecret(secret: string): string {
  if (secret.length === 0) throw new ConvexError("Secret value is required");
  if (secret.length > 4096) throw new ConvexError("Secret value is too long");
  if (secret.includes("\r") || secret.includes("\n")) {
    throw new ConvexError("Secret value cannot contain newlines");
  }
  return secret;
}

export const listForProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectMember(ctx, args.projectId);
    const rows = await ctx.db
      .query("upstreamCredentials")
      .withIndex("by_project_name", (q) => q.eq("projectId", args.projectId))
      .collect();
    return rows.map((r) => ({
      id: r._id,
      name: r.name,
      updatedAt: r.updatedAt,
    }));
  },
});
export const upsert = mutation({
  args: { projectId: v.id("projects"), name: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    const { project } = await requireProjectAdmin(ctx, args.projectId);
    const name = normalizeName(args.name),
      secret = validateSecret(args.secret);
    const existing = await ctx.db
      .query("upstreamCredentials")
      .withIndex("by_project_name", (q) =>
        q.eq("projectId", project._id).eq("name", name),
      )
      .unique();
    if (
      !existing &&
      (
        await ctx.db
          .query("upstreamCredentials")
          .withIndex("by_project_name", (q) => q.eq("projectId", project._id))
          .take(33)
      ).length >= 32
    )
      throw new ConvexError("At most 32 upstream credentials");
    const revision = Math.max(project.revision, existing?.revision ?? 0) + 1;
    const fields = {
      projectId: project._id,
      name,
      revision,
      updatedAt: Date.now(),
      envelope: await encryptSecret(
        secret,
        credentialBinding(project._id, name, revision),
      ),
    };
    let id = existing?._id;
    if (id) await ctx.db.patch(id, fields);
    else id = await ctx.db.insert("upstreamCredentials", fields);
    await ctx.db.patch(project._id, {
      revision: project.revision + 1,
      ...(project.draft
        ? { draft: { ...project.draft, readiness: undefined } }
        : {}),
    });
    return { id, name, updatedAt: fields.updatedAt };
  },
});
export const remove = mutation({
  args: { credentialId: v.id("upstreamCredentials") },
  handler: async (ctx, args) => {
    const { org, claims } = await requireActiveOrg(ctx);
    requireOrgAdmin(claims);
    const row = await ctx.db.get(args.credentialId);
    const project = row && (await ctx.db.get(row.projectId));
    if (
      !row ||
      !project ||
      project.organizationId !== org._id ||
      project.retirement?.state === "retired"
    )
      throw new ConvexError("Upstream credential unavailable");
    await ctx.db.delete(row._id);
    await ctx.db.patch(project._id, {
      revision: project.revision + 1,
      ...(project.draft
        ? { draft: { ...project.draft, readiness: undefined } }
        : {}),
    });
    return { deleted: row._id };
  },
});
