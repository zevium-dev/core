import { adjustStat } from "./lib/catalogue";
import { v, ConvexError } from "convex/values";
import { isValidSlug } from "@zevium/shared";
import { mutation, query } from "./_generated/server";
import { requireActiveOrg, requireIdentity, requireOrgAdmin } from "./lib/auth";
import { organizationDto } from "./lib/dto";
import {
  availableHandle,
  getOrganization,
  handleAvailable,
  isActive,
  trustedSlug,
  organizationSlug,
} from "./lib/identity";
export const ensureOrganization = mutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const claims = await requireIdentity(ctx);
    if (!claims.orgId || claims.orgId !== args.clerkOrgId)
      throw new ConvexError(
        "Organization does not match authenticated identity",
      );
    const deleted = await ctx.db
      .query("users")
      .withIndex("by_clerk", (q) => q.eq("clerkUserId", claims.subject))
      .unique();
    if (deleted?.deletedAt !== undefined)
      throw new ConvexError("Not authenticated");
    const tomb = await ctx.db
      .query("orgTombstones")
      .withIndex("by_clerk", (q) => q.eq("clerkOrgId", claims.orgId!))
      .unique();
    if (tomb) throw new ConvexError("Organization is archived");
    let org = await getOrganization(ctx, claims.orgId);
    if (!org) {
      const slug = await organizationSlug(claims.orgSlug, claims.orgId);
      const id = await ctx.db.insert("organizations", {
        clerkOrgId: claims.orgId,
        slug,
        name: slug,
        publicHandle: await availableHandle(ctx, slug, claims.orgId),
        lastClerkEventAt: 0,
        revision: 1,
      });
      await adjustStat(ctx, "orgs", id, 1);
      org = (await ctx.db.get(id))!;
    }
    if (!(await isActive(ctx, org)))
      throw new ConvexError("Organization is archived");
    return organizationDto(org);
  },
});
export const activeCapabilities = query({
  args: {},
  handler: async (ctx) => (await requireActiveOrg(ctx)).access,
});
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const claims = await requireIdentity(ctx);
    if (!claims.orgId) return [];
    const org = await getOrganization(ctx, claims.orgId);
    if (!org || !(await isActive(ctx, org))) return [];
    await requireActiveOrg(ctx);
    const reserved = await ctx.db
      .query("routeTombstones")
      .withIndex("by_org", (q) => q.eq("organizationId", org._id))
      .first();
    return [
      {
        name: org.name,
        publisherHandle: org.publicHandle,
        imageUrl: org.imageUrl,
        publicHandleLocked: !!reserved,
      },
    ];
  },
});
export const getByPublicHandle = query({
  args: { handle: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_handle", (q) => q.eq("publicHandle", args.handle))
      .unique();
    return org && (await isActive(ctx, org))
      ? {
          name: org.name,
          publisherHandle: org.publicHandle,
          imageUrl: org.imageUrl,
        }
      : null;
  },
});
export const checkPublicHandleAvailability = query({
  args: { handle: v.string() },
  handler: async (ctx, args) => {
    const { org } = await requireActiveOrg(ctx);
    const handle = args.handle.trim().toLowerCase();
    return {
      available:
        isValidSlug(handle) &&
        handle.length <= 120 &&
        (await handleAvailable(ctx, handle, org.clerkOrgId)),
    };
  },
});
export const setPublicHandle = mutation({
  args: { handle: v.string() },
  handler: async (ctx, args) => {
    const { org, claims } = await requireActiveOrg(ctx);
    requireOrgAdmin(claims);
    const handle = trustedSlug(args.handle.trim().toLowerCase());
    if (handle === org.publicHandle) return organizationDto(org);
    if (
      await ctx.db
        .query("routeTombstones")
        .withIndex("by_org", (q) => q.eq("organizationId", org._id))
        .first()
    )
      throw new ConvexError(
        "Public handle is permanent after first publication",
      );
    if (!(await handleAvailable(ctx, handle, org.clerkOrgId)))
      throw new ConvexError("That public handle is already in use");
    await ctx.db.patch(org._id, {
      publicHandle: handle,
      revision: org.revision + 1,
    });
    return organizationDto((await ctx.db.get(org._id))!);
  },
});
