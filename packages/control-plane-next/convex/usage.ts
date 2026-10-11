import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireActiveOrg } from "./lib/auth";
async function view(
  ctx: QueryCtx,
  event: Doc<"usageEvents">,
  privileged: boolean,
) {
  const publisher = await ctx.db.get(event.publisherOrganizationId);
  const member =
    privileged && event.ownerUserId
      ? await ctx.db
          .query("users")
          .withIndex("by_clerk", (q) => q.eq("clerkUserId", event.ownerUserId!))
          .unique()
      : null;
  return {
    eventId: event.publicId,
    projectRef: publisher
      ? `${publisher.publicHandle}/${event.projectSlug}`
      : null,
    projectName: event.projectName,
    projectSlug: event.projectSlug,
    endpoint: event.endpoint,
    method: event.method,
    credits: event.credits,
    status: event.status,
    latencyMs: event.latencyMs,
    keyId: privileged
      ? (event.keyId ?? "")
      : event.keyId
        ? `…${event.keyId.slice(-4)}`
        : "",
    ...(privileged
      ? {
          memberId: event.ownerUserId ?? null,
          memberName: member?.name ?? "Organization member",
        }
      : {}),
    at: event.at,
  };
}
export const listForOrg = query({
  args: {
    orgSlug: v.string(),
    expectedRole: v.optional(v.string()),
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
    const { org, claims, access } = await requireActiveOrg(ctx),
      privileged = access.capabilities.viewOrgUsage;
    const empty = {
      page: [],
      isDone: true,
      continueCursor: "",
      partial: false,
      access,
    };
    if (
      (args.expectedRole !== undefined && args.expectedRole !== access.role) ||
      (!privileged &&
        args.memberId !== undefined &&
        args.memberId !== claims.subject)
    )
      return empty;
    if (
      [
        args.projectRef,
        args.keyId,
        args.memberId,
        args.endpoint,
        args.method,
      ].some((x) => x !== undefined && x.length > 512)
    )
      return empty;
    if (
      [args.since, args.until].some(
        (x) => x !== undefined && (!Number.isSafeInteger(x) || x < 0),
      ) ||
      (args.since !== undefined &&
        args.until !== undefined &&
        args.since >= args.until)
    )
      throw new ConvexError("Invalid usage time range");
    let projectId: Id<"projects"> | undefined;
    if (args.projectRef !== undefined) {
      const [handle, slug, extra] = args.projectRef.split("/");
      if (!handle || !slug || extra !== undefined) return empty;
      const publisher = await ctx.db
        .query("organizations")
        .withIndex("by_handle", (q) => q.eq("publicHandle", handle))
        .unique();
      if (!publisher) return empty;
      projectId = (
        await ctx.db
          .query("projects")
          .withIndex("by_org_slug", (q) =>
            q.eq("organizationId", publisher._id).eq("slug", slug),
          )
          .unique()
      )?._id;
      if (!projectId) return empty;
    }
    const ownerUserId = privileged ? args.memberId : claims.subject;
    // Most selective available tenant prefix; remaining filters run over a bounded scanned page.
    const base =
      ownerUserId !== undefined
        ? ctx.db
            .query("usageEvents")
            .withIndex("by_org_owner_time", (q) =>
              q
                .eq("consumerOrganizationId", org._id)
                .eq("ownerUserId", ownerUserId),
            )
        : args.keyId !== undefined
          ? ctx.db
              .query("usageEvents")
              .withIndex("by_org_key_time", (q) =>
                q.eq("consumerOrganizationId", org._id).eq("keyId", args.keyId),
              )
          : projectId !== undefined
            ? ctx.db
                .query("usageEvents")
                .withIndex("by_org_project_time", (q) =>
                  q
                    .eq("consumerOrganizationId", org._id)
                    .eq("projectId", projectId),
                )
            : ctx.db
                .query("usageEvents")
                .withIndex("by_org_time", (q) =>
                  q.eq("consumerOrganizationId", org._id),
                );
    const result = await base.order("desc").paginate({
      ...args.paginationOpts,
      numItems: Math.max(1, Math.min(100, args.paginationOpts.numItems)),
      maximumRowsRead: 100,
    });
    const filtered = result.page.filter(
      (e) =>
        (projectId === undefined || e.projectId === projectId) &&
        (args.keyId === undefined || args.keyId === e.keyId) &&
        (args.endpoint === undefined || args.endpoint === e.endpoint) &&
        (args.method === undefined || args.method.toUpperCase() === e.method) &&
        (args.since === undefined || e.at >= args.since) &&
        (args.until === undefined || e.at < args.until),
    );
    return {
      ...result,
      access,
      partial: filtered.length < result.page.length && !result.isDone,
      page: await Promise.all(filtered.map((e) => view(ctx, e, privileged))),
    };
  },
});
export const getForOrgById = query({
  args: { orgSlug: v.string(), eventId: v.string() },
  handler: async (ctx, args) => {
    const { org, claims, access } = await requireActiveOrg(ctx);
    const event = await ctx.db
      .query("usageEvents")
      .withIndex("by_public", (q) => q.eq("publicId", args.eventId))
      .unique();
    return event &&
      event.consumerOrganizationId === org._id &&
      (access.capabilities.viewOrgUsage || event.ownerUserId === claims.subject)
      ? view(ctx, event, access.capabilities.viewOrgUsage)
      : null;
  },
});
