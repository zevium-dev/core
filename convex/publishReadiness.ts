import { extractHealthCheckTarget, parseSpec } from "@zevium/shared";
import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireProjectMember } from "./lib/auth";
import { isOrganizationActive } from "./lib/publicRoutes";

export const READINESS_TTL_MS = 15 * 60 * 1000;

export type ReadinessValidity =
  | { current: true; reason: null }
  | {
      current: false;
      reason:
        | "missing"
        | "draft_missing"
        | "status_not_ok"
        | "expired"
        | "draft_changed"
        /** Retained in public union for UI compatibility; credential-free probes never emit it. */
        | "credentials_changed";
    };

export async function draftFingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Stable hash over complete credential membership, identity, and revision. */
export async function credentialSetFingerprint(
  rows: readonly {
    _id: unknown;
    name: string;
    revision?: number;
    updatedAt: number;
  }[],
): Promise<string> {
  const canonical = rows
    .map((row) => ({
      id: String(row._id),
      name: row.name,
      revision: row.revision ?? row.updatedAt,
      updatedAt: row.updatedAt,
    }))
    .sort((left, right) =>
      left.id === right.id
        ? left.name.localeCompare(right.name)
        : left.id.localeCompare(right.id),
    );
  return await draftFingerprint(JSON.stringify(canonical));
}

function credentialRevision(
  rows: readonly { revision?: number; updatedAt: number }[],
): number {
  return rows.reduce(
    (latest, row) => Math.max(latest, row.revision ?? row.updatedAt),
    0,
  );
}

/**
 * A publish test is valid only for this exact saved draft.
 * Keep this pure so the UI query and authoritative publish gate cannot drift.
 */
export async function readinessValidity(
  readiness: {
    status: string;
    draftHash: string;
    credentialRevision?: number;
    credentialFingerprint?: string;
    testedAt: number;
  } | null,
  draft: string | null,
  credentialRevision: number,
  credentialFingerprint: string,
  nowMs: number = Date.now(),
): Promise<ReadinessValidity> {
  if (readiness === null) return { current: false, reason: "missing" };
  if (draft === null) return { current: false, reason: "draft_missing" };
  if (readiness.status !== "ok") {
    return { current: false, reason: "status_not_ok" };
  }
  if (nowMs - readiness.testedAt > READINESS_TTL_MS) {
    return { current: false, reason: "expired" };
  }
  if (readiness.draftHash !== (await draftFingerprint(draft))) {
    return { current: false, reason: "draft_changed" };
  }
  if (
    readiness.credentialRevision !== credentialRevision ||
    readiness.credentialFingerprint !== credentialFingerprint
  ) {
    return { current: false, reason: "credentials_changed" };
  }
  return { current: true, reason: null };
}

export const getTarget = internalQuery({
  args: { projectId: v.id("projects"), clerkOrgId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    url: string | null;
    method: "GET" | "HEAD" | null;
    draftHash: string | null;
  }> => {
    const project = await ctx.db.get(args.projectId);
    if (project === null) throw new Error("Project not found");
    const organization = await ctx.db.get(project.organizationId);
    if (
      organization === null ||
      organization.clerkOrgId !== args.clerkOrgId ||
      !(await isOrganizationActive(ctx, organization))
    )
      throw new Error("Not a member of this organization");
    const draft = await ctx.db
      .query("specs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    let url: string | null = null;
    let method: "GET" | "HEAD" | null = null;
    if (draft?.draft.trim()) {
      try {
        const target = extractHealthCheckTarget(parseSpec(draft.draft));
        if (target !== null) {
          url = target.url;
          method = target.method;
        }
      } catch {
        // The editor separately reports spec parsing errors.
      }
    }
    return {
      url,
      method,
      draftHash: draft ? await draftFingerprint(draft.draft) : null,
    };
  },
});

export const recordPassingTest = internalMutation({
  args: {
    projectId: v.id("projects"),
    draftHash: v.string(),

    healthCheckUrl: v.string(),
    healthCheckMethod: v.union(v.literal("GET"), v.literal("HEAD")),
  },
  handler: async (ctx, args) => {
    const draft = await ctx.db
      .query("specs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    const credentials = await ctx.db
      .query("upstreamCredentials")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const currentCredentialRevision = credentialRevision(credentials);
    const currentCredentialFingerprint =
      await credentialSetFingerprint(credentials);
    if (
      draft === null ||
      args.draftHash !== (await draftFingerprint(draft.draft))
    ) {
      return false;
    }
    const existing = await ctx.db
      .query("publishReadiness")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    const value = {
      draftHash: args.draftHash,
      healthCheckUrl: args.healthCheckUrl,
      healthCheckMethod: args.healthCheckMethod,
      credentialRevision: currentCredentialRevision,
      credentialFingerprint: currentCredentialFingerprint,
      status: "ok" as const,
      testedAt: Date.now(),
    };
    if (existing) await ctx.db.patch(existing._id, value);
    else
      await ctx.db.insert("publishReadiness", {
        projectId: args.projectId,
        ...value,
      });
    return true;
  },
});

/**
 * Remove a prior pass after a failed retry, but only when tested draft is still
 * current. A delayed action for an older draft cannot erase newer readiness.
 */
export const clearPassingTest = internalMutation({
  args: {
    projectId: v.id("projects"),
    draftHash: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const draft = await ctx.db
      .query("specs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (
      draft === null ||
      args.draftHash !== (await draftFingerprint(draft.draft))
    ) {
      return false;
    }
    const existing = await ctx.db
      .query("publishReadiness")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (existing !== null) await ctx.db.delete(existing._id);
    return true;
  },
});

export const getCurrent = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectMember(ctx, args.projectId);
    const readiness = await ctx.db
      .query("publishReadiness")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    const draft = await ctx.db
      .query("specs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    const credentials = await ctx.db
      .query("upstreamCredentials")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const currentCredentialRevision = credentialRevision(credentials);
    const credentialFingerprint = await credentialSetFingerprint(credentials);
    const validity = await readinessValidity(
      readiness,
      draft?.draft ?? null,
      currentCredentialRevision,
      credentialFingerprint,
    );
    return {
      readiness,
      ...validity,
    };
  },
});
