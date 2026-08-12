import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { requireOrgMemberBySlug } from "./lib/auth";

const MAX_USAGE_PAGE_SIZE = 50;

export type UsageListItem = {
  eventId: string;
  projectRef: string | null;
  projectName: string | null;
  projectSlug: string | null;
  endpoint: string;
  method: string;
  credits: number;
  status: number;
  latencyMs: number;
  keyId: string;
  memberId?: string | null;
  memberName?: string | null;
  at: number;
};

function boundedPagination(options: {
  numItems: number;
  cursor: string | null;
}) {
  return {
    cursor: options.cursor,
    numItems: Math.min(
      Math.max(Math.floor(options.numItems), 1),
      MAX_USAGE_PAGE_SIZE,
    ),
  };
}

function maskedKeyId(keyId: string): string {
  return keyId.length > 4 ? `••••${keyId.slice(-4)}` : "••••";
}

async function projectView(
  ctx: QueryCtx,
  projectId: Id<"projects">,
): Promise<{
  projectRef: string | null;
  projectName: string | null;
  projectSlug: string | null;
}> {
  const project = await ctx.db.get(projectId);
  if (project === null) {
    return { projectRef: null, projectName: null, projectSlug: null };
  }
  const publisher = await ctx.db.get(project.organizationId);
  return {
    projectRef: publisher?.publicHandle
      ? `${publisher.publicHandle}/${project.slug}`
      : null,
    projectName: project.name,
    projectSlug: project.slug,
  };
}

async function usageView(
  ctx: QueryCtx,
  event: Doc<"usageEvents">,
  canViewOrgUsage: boolean,
): Promise<UsageListItem> {
  const member =
    canViewOrgUsage && event.ownerUserId !== undefined
      ? await ctx.db
          .query("users")
          .withIndex("by_clerk_user", (q) =>
            q.eq("clerkUserId", event.ownerUserId!),
          )
          .unique()
      : null;
  return {
    eventId: String(event._id),
    ...(await projectView(ctx, event.projectId)),
    endpoint: event.endpoint,
    method: event.method,
    credits: event.credits,
    status: event.status,
    latencyMs: event.latencyMs,
    keyId: canViewOrgUsage ? event.keyId : maskedKeyId(event.keyId),
    ...(canViewOrgUsage
      ? {
          memberId: event.ownerUserId ?? null,
          memberName:
            event.ownerUserId === undefined
              ? "Unattributed member"
              : (member?.name ?? "Organization member"),
        }
      : {}),
    at: event.at,
  };
}

async function resolveProjectRef(
  ctx: QueryCtx,
  projectRef: string,
): Promise<Id<"projects"> | null> {
  const separator = projectRef.indexOf("/");
  if (separator <= 0 || separator === projectRef.length - 1) return null;
  const publisherHandle = projectRef.slice(0, separator);
  const projectSlug = projectRef.slice(separator + 1);
  const publisher = await ctx.db
    .query("organizations")
    .withIndex("by_public_handle", (q) => q.eq("publicHandle", publisherHandle))
    .unique();
  if (publisher === null) return null;
  const project = await ctx.db
    .query("projects")
    .withIndex("by_org_slug", (q) =>
      q.eq("organizationId", publisher._id).eq("slug", projectSlug),
    )
    .unique();
  return project?._id ?? null;
}

function emptyPage(
  access: Awaited<ReturnType<typeof requireOrgMemberBySlug>>["access"],
) {
  return {
    access,
    page: [] as UsageListItem[],
    isDone: true,
    continueCursor: "",
  };
}

/** Paginated consumer call log. Ordinary members are always self-scoped. */
export const listForOrg = query({
  args: {
    orgSlug: v.string(),
    paginationOpts: paginationOptsValidator,
    projectRef: v.optional(v.string()),
    keyId: v.optional(v.string()),
    memberId: v.optional(v.string()),
    endpoint: v.optional(v.string()),
    method: v.optional(v.string()),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { access, claims, org } = await requireOrgMemberBySlug(
      ctx,
      args.orgSlug,
    );
    const canViewOrgUsage = access.capabilities.viewOrgUsage;
    if (
      (!canViewOrgUsage &&
        args.memberId !== undefined &&
        args.memberId !== claims.subject) ||
      (args.endpoint?.length ?? 0) > 512 ||
      (args.method?.length ?? 0) > 16 ||
      (args.keyId?.length ?? 0) > 128 ||
      (args.projectRef?.length ?? 0) > 256
    ) {
      return emptyPage(access);
    }

    const projectId = args.projectRef
      ? await resolveProjectRef(ctx, args.projectRef)
      : undefined;
    if (args.projectRef !== undefined && projectId === null) {
      return emptyPage(access);
    }
    const method = args.method?.toUpperCase();
    const pagination = boundedPagination(args.paginationOpts);
    const applyTime = <T extends { gte: Function; lt: Function }>(base: T) => {
      if (args.since !== undefined && args.until !== undefined) {
        return base.gte("at", args.since).lt("at", args.until);
      }
      if (args.since !== undefined) return base.gte("at", args.since);
      if (args.until !== undefined) return base.lt("at", args.until);
      return base;
    };

    let result;
    if (!canViewOrgUsage) {
      result = await ctx.db
        .query("usageEvents")
        .withIndex("by_org_owner_at", (q) =>
          applyTime(
            q.eq("organizationId", org._id).eq("ownerUserId", claims.subject),
          ),
        )
        .order("desc")
        .paginate(pagination);
    } else if (args.memberId !== undefined) {
      result = await ctx.db
        .query("usageEvents")
        .withIndex("by_org_owner_at", (q) =>
          applyTime(
            q.eq("organizationId", org._id).eq("ownerUserId", args.memberId),
          ),
        )
        .order("desc")
        .paginate(pagination);
    } else if (args.keyId !== undefined) {
      result = await ctx.db
        .query("usageEvents")
        .withIndex("by_org_key_at", (q) =>
          applyTime(q.eq("organizationId", org._id).eq("keyId", args.keyId!)),
        )
        .order("desc")
        .paginate(pagination);
    } else if (projectId !== undefined && projectId !== null) {
      result = await ctx.db
        .query("usageEvents")
        .withIndex("by_org_project_at", (q) =>
          applyTime(q.eq("organizationId", org._id).eq("projectId", projectId)),
        )
        .order("desc")
        .paginate(pagination);
    } else if (args.endpoint !== undefined && method !== undefined) {
      result = await ctx.db
        .query("usageEvents")
        .withIndex("by_org_endpoint_method_at", (q) =>
          applyTime(
            q
              .eq("organizationId", org._id)
              .eq("endpoint", args.endpoint!)
              .eq("method", method),
          ),
        )
        .order("desc")
        .paginate(pagination);
    } else if (args.endpoint !== undefined) {
      result = await ctx.db
        .query("usageEvents")
        .withIndex("by_org_endpoint_at", (q) =>
          applyTime(
            q.eq("organizationId", org._id).eq("endpoint", args.endpoint!),
          ),
        )
        .order("desc")
        .paginate(pagination);
    } else {
      result = await ctx.db
        .query("usageEvents")
        .withIndex("by_org_at", (q) =>
          applyTime(q.eq("organizationId", org._id)),
        )
        .order("desc")
        .paginate(pagination);
    }

    const page: UsageListItem[] = [];
    for (const event of result.page) {
      if (!canViewOrgUsage && event.ownerUserId !== claims.subject) continue;
      if (projectId && event.projectId !== projectId) continue;
      if (args.keyId !== undefined && event.keyId !== args.keyId) continue;
      if (args.endpoint !== undefined && event.endpoint !== args.endpoint)
        continue;
      if (method !== undefined && event.method.toUpperCase() !== method)
        continue;
      page.push(await usageView(ctx, event, canViewOrgUsage));
    }
    return { ...result, access, page };
  },
});

/** Deep-linked usage reads return null for missing, cross-org, or colleague rows. */
export const getForOrgById = query({
  args: { orgSlug: v.string(), eventId: v.string() },
  handler: async (ctx, args): Promise<UsageListItem | null> => {
    const { access, claims, org } = await requireOrgMemberBySlug(
      ctx,
      args.orgSlug,
    );
    const eventId = ctx.db.normalizeId("usageEvents", args.eventId);
    if (eventId === null) return null;
    const event = await ctx.db.get(eventId);
    if (event === null || event.organizationId !== org._id) return null;
    if (
      !access.capabilities.viewOrgUsage &&
      event.ownerUserId !== claims.subject
    ) {
      return null;
    }
    return await usageView(ctx, event, access.capabilities.viewOrgUsage);
  },
});
