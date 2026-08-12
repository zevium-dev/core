import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { orgCapabilities, requireOrgMemberBySlug } from "./lib/auth";
import { maskedSuffix, publicReference } from "./lib/publicIds";

export type UsageListItem = {
  id: string;
  projectName: string | null;
  projectSlug: string | null;
  endpoint: string;
  method: string;
  credits: number;
  status: number;
  latencyMs: number;
  keyRef: string;
  keyLabel: string;
  ownerRef?: string;
  at: number;
};

/** Capability-filtered consumer call log. Members see own-key rows only. */
export const listForOrg = query({
  args: {
    orgSlug: v.string(),
    paginationOpts: paginationOptsValidator,
    projectId: v.optional(v.id("projects")),
    keyId: v.optional(v.string()),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { claims, org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const capabilities = orgCapabilities(claims);

    const result = capabilities.canViewOrgUsage
      ? await ctx.db
          .query("usageEvents")
          .withIndex("by_org_at", (q) => {
            const base = q.eq("organizationId", org._id);
            if (args.since !== undefined && args.until !== undefined) {
              return base.gte("at", args.since).lt("at", args.until);
            }
            if (args.since !== undefined) return base.gte("at", args.since);
            if (args.until !== undefined) return base.lt("at", args.until);
            return base;
          })
          .order("desc")
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("usageEvents")
          .withIndex("by_org_owner_at", (q) => {
            const base = q
              .eq("organizationId", org._id)
              .eq("ownerUserId", claims.subject);
            if (args.since !== undefined && args.until !== undefined) {
              return base.gte("at", args.since).lt("at", args.until);
            }
            if (args.since !== undefined) return base.gte("at", args.since);
            if (args.until !== undefined) return base.lt("at", args.until);
            return base;
          })
          .order("desc")
          .paginate(args.paginationOpts);

    const projectCache = new Map<
      Id<"projects">,
      { name: string; slug: string } | null
    >();
    async function resolveProject(projectId: Id<"projects">) {
      if (projectCache.has(projectId)) {
        return projectCache.get(projectId) ?? null;
      }
      const project = await ctx.db.get(projectId);
      const view =
        project === null ? null : { name: project.name, slug: project.slug };
      projectCache.set(projectId, view);
      return view;
    }

    const page: UsageListItem[] = [];
    for (const event of result.page) {
      if (args.projectId !== undefined && event.projectId !== args.projectId) {
        continue;
      }
      if (args.keyId !== undefined && event.keyId !== args.keyId) continue;
      // Legacy rows without an authoritative owner fail closed for members.
      if (
        !capabilities.canViewOrgUsage &&
        event.ownerUserId !== claims.subject
      ) {
        continue;
      }
      const project = await resolveProject(event.projectId);
      page.push({
        id:
          event.publicId ??
          (await publicReference("usage-event", String(event._id))),
        projectName: project?.name ?? null,
        projectSlug: project?.slug ?? null,
        endpoint: event.endpoint,
        method: event.method,
        credits: event.credits,
        status: event.status,
        latencyMs: event.latencyMs,
        keyRef: await publicReference("api-key", event.keyId),
        keyLabel: maskedSuffix(event.keyId),
        ...(capabilities.canViewOrgUsage && event.ownerUserId !== undefined
          ? {
              ownerRef: await publicReference(
                "org-member",
                event.ownerUserId,
              ),
            }
          : {}),
        at: event.at,
      });
    }
    return { ...result, page };
  },
});
