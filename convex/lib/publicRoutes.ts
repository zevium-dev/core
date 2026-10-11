import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { isActive } from "./identity";
export async function reservePublicRoute(
  ctx: MutationCtx,
  org: Doc<"organizations">,
  project: Doc<"projects">,
) {
  if (project.organizationId !== org._id || !(await isActive(ctx, org)))
    throw new ConvexError("Public route is unavailable");
  const row = await ctx.db
    .query("routeTombstones")
    .withIndex("by_route", (q) =>
      q.eq("publisherHandle", org.publicHandle).eq("projectSlug", project.slug),
    )
    .unique();
  if (row) {
    if (
      row.projectId !== project._id ||
      row.organizationId !== org._id ||
      row.retiredAt !== undefined
    )
      throw new ConvexError("Public route is permanently reserved");
    return row;
  }
  const id = await ctx.db.insert("routeTombstones", {
    publisherHandle: org.publicHandle,
    projectSlug: project.slug,
    organizationId: org._id,
    projectId: project._id,
    reservedAt: Date.now(),
    revision: 1,
  });
  return (await ctx.db.get(id))!;
}
export async function resolveActivePublicRoute(
  ctx: Pick<QueryCtx, "db">,
  handle: string,
  slug: string,
) {
  const route = await ctx.db
    .query("routeTombstones")
    .withIndex("by_route", (q) =>
      q.eq("publisherHandle", handle).eq("projectSlug", slug),
    )
    .unique();
  if (!route || route.retiredAt !== undefined) return null;
  const org = await ctx.db.get(route.organizationId),
    project = await ctx.db.get(route.projectId);
  if (
    !org ||
    !(await isActive(ctx, org)) ||
    org.publicHandle !== handle ||
    !project ||
    project.organizationId !== org._id ||
    project.slug !== slug ||
    project.status !== "published" ||
    project.visibility !== "public" ||
    project.qualityStatus !== "active" ||
    project.retirement?.state === "retired" ||
    (project.retirement && project.retirement.sunsetAt <= Date.now())
  )
    return null;
  return { route, org, project };
}
