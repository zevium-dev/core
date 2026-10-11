import { publicSpec } from "./lib/specPolicy";
import { paginationOptsValidator, type PaginationOptions } from "convex/server";
import { v, ConvexError } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { listing } from "./lib/catalogue";
import { resolveActivePublicRoute } from "./lib/publicRoutes";
import { qualitySnapshotContract } from "./lib/qualityContract";
export type PublicListing = NonNullable<Awaited<ReturnType<typeof listing>>>;
const listArgs = {
  search: v.optional(v.string()),
  tag: v.optional(v.string()),
  cursor: v.optional(v.string()),
  sort: v.optional(
    v.union(v.literal("newest"), v.literal("name"), v.literal("cheapest")),
  ),
  hasFreeTier: v.optional(v.boolean()),
  maxCost: v.optional(v.number()),
};
type Filters = {
  search?: string;
  tag?: string;
  cursor?: string;
  sort?: "newest" | "name" | "cheapest";
  hasFreeTier?: boolean;
  maxCost?: number;
  paginationOpts?: PaginationOptions;
};
async function facets(ctx: QueryCtx) {
  // Facet suggestions are bounded; counts of each returned tag remain exact.
  const rows = await ctx.db
    .query("catalogueIndex")
    .withIndex("by_facet", (q) =>
      q.eq("kind", "facet").gte("facetKey", "tag:").lt("facetKey", "tag;"),
    )
    .take(1025);
  const counts = new Map<string, number>();
  const last =
    rows.length === 1025 && rows.at(-1)?.kind === "facet"
      ? (rows.at(-1) as Extract<Doc<"catalogueIndex">, { kind: "facet" }>)
          .facetKey
      : null;
  for (const row of rows)
    if (row.kind === "facet" && row.facetKey !== last)
      counts.set(
        row.facetKey.slice(4),
        (counts.get(row.facetKey.slice(4)) ?? 0) + row.count,
      );
  return [...counts].map(([name, count]) => ({ name, count }));
}
async function count(ctx: QueryCtx, key: string) {
  const rows = await ctx.db
    .query("catalogueIndex")
    .withIndex("by_facet", (q) => q.eq("kind", "facet").eq("facetKey", key))
    .take(16);
  return rows.reduce((sum, r) => sum + (r.kind === "facet" ? r.count : 0), 0);
}
export async function browse(ctx: QueryCtx, args: Filters) {
  const search = args.search?.trim(),
    tag = args.tag?.trim().toLowerCase(),
    sort = args.sort ?? "newest";
  if (
    (search?.length ?? 0) > 200 ||
    (tag?.length ?? 0) > 80 ||
    (args.maxCost !== undefined &&
      (!Number.isFinite(args.maxCost) || args.maxCost < 0))
  )
    throw new ConvexError("Invalid catalogue filter");
  const opts = {
    ...args.paginationOpts,
    cursor: args.paginationOpts?.cursor ?? args.cursor ?? null,
    numItems: Math.max(1, Math.min(50, args.paginationOpts?.numItems ?? 24)),
    maximumRowsRead: 200,
    maximumBytesRead: 512 * 1024,
  };
  let rows;
  if (search)
    rows = await ctx.db
      .query("projects")
      .withSearchIndex("search_public", (q) =>
        q.search("searchText", search).eq("discoverable", true),
      )
      .paginate(opts);
  else if (tag) {
    const tags = ctx.db.query("catalogueIndex");
    const source =
      sort === "name"
        ? tags.withIndex("by_tag_name", (q) =>
            q.eq("kind", "tag").eq("tag", tag).eq("discoverable", true),
          )
        : sort === "cheapest"
          ? tags.withIndex("by_tag_cost", (q) =>
              q.eq("kind", "tag").eq("tag", tag).eq("discoverable", true),
            )
          : tags.withIndex("by_tag_newest", (q) =>
              q.eq("kind", "tag").eq("tag", tag).eq("discoverable", true),
            );
    const page = await source
      .order(sort === "newest" ? "desc" : "asc")
      .paginate(opts);
    const projects = await Promise.all(
      page.page.map((r) => (r.kind === "tag" ? ctx.db.get(r.projectId) : null)),
    );
    rows = {
      ...page,
      page: projects.filter((p): p is Doc<"projects"> => p !== null),
    };
  } else {
    const projects = ctx.db.query("projects");
    const source =
      sort === "name"
        ? projects.withIndex("by_discoverable_name", (q) =>
            q.eq("discoverable", true),
          )
        : sort === "cheapest"
          ? projects.withIndex("by_discoverable_cost", (q) =>
              q.eq("discoverable", true),
            )
          : projects.withIndex("by_discoverable_newest", (q) =>
              q.eq("discoverable", true),
            );
    rows = await source
      .order(sort === "newest" ? "desc" : "asc")
      .paginate(opts);
  }
  const hydrated = await Promise.all(
    rows.page
      .filter(
        (p) =>
          (!tag || p.tags.includes(tag)) &&
          (!args.hasFreeTier || p.hasFreeTier) &&
          (args.maxCost === undefined ||
            (p.minCost ?? Infinity) <= args.maxCost),
      )
      .map((p) => listing(ctx, p)),
  );
  const items = hydrated.filter((p): p is PublicListing => p !== null);
  return {
    ...rows,
    page: items,
    items,
    nextCursor: rows.isDone ? null : rows.continueCursor,
    totalScope: "facet" as const,
    partial: !rows.isDone && items.length < opts.numItems,
    total: await count(ctx, tag ? `tag:${tag}` : "total"),
    facets: {
      tags: await facets(ctx),
      freeTierCount: await count(ctx, "free"),
    },
  };
}
export const listPublic = query({ args: listArgs, handler: browse });
export const listPublicPaginated = query({
  args: { ...listArgs, paginationOpts: paginationOptsValidator },
  handler: browse,
});
export const publicFacets = query({ args: {}, handler: facets });
export const getPublicDetail = query({
  args: { publisherHandle: v.string(), projectSlug: v.string() },
  handler: async (ctx, args) => {
    const route = await resolveActivePublicRoute(
      ctx,
      args.publisherHandle,
      args.projectSlug,
    );
    if (!route?.project.latestVersionId || route.project.endpointCount === 0)
      return null;
    const { project, org } = route,
      version = await ctx.db.get(route.project.latestVersionId);
    if (!version) return null;
    return {
      project: {
        _id: project._id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        tags: project.tags,
        status: project.status,
        visibility: project.visibility,
        houseOperated: project.houseOperated,
      },
      org: {
        name: org.name,
        publisherHandle: org.publicHandle,
        imageUrl: org.imageUrl,
      },
      latestVersion: {
        version: version.version,
        spec: publicSpec(version.spec),
        publishedAt: version.publishedAt,
        deprecatedAt: project.retirement?.startedAt ?? version.deprecatedAt,
        sunsetAt: project.retirement?.sunsetAt ?? version.sunsetAt,
        deprecationMessage:
          project.retirement?.message ?? version.deprecationMessage,
      },
      quality:
        project.quality.snapshot?.specVersionId === version._id
          ? qualitySnapshotContract(project.quality.snapshot)
          : null,
    };
  },
});
