import {
  extractPricing,
  MAX_ENDPOINT_COST_CREDITS,
  parseSpec,
} from "@zevium/shared";
import { v } from "convex/values";
import { internalMutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  getActiveOrgById,
  getOrgByClerkId,
  getOrgByPublicHandle,
} from "./lib/auth";

const PAGE_SIZE = 24;
const PUBLIC_SCAN_CAP = 240;
const PROJECTION_BACKFILL_PAGE_SIZE = 25;
const CATALOGUE_STATS_KEY = "public";

export type CatalogueSort = "newest" | "name" | "cheapest";

/** Pricing rollup from latest published specVersion at query time. */
export type ListingPricingSummary = {
  minCost: number;
  maxCost: number;
  endpointCount: number;
  hasFreeTier: boolean;
};

export type PublicListing = {
  name: string;
  slug: string;
  description: string | undefined;
  tags: string[];
  orgName: string;
  publisherHandle: string;
  publishedAt: number | null;
  pricing: ListingPricingSummary | null;
};

/**
 * Summarize per-endpoint costs from a published OpenAPI JSON string.
 * Invalid/unparseable specs yield null (listing still visible, no price chip).
 */
export function summarizePublishedPricing(
  specJson: string,
): ListingPricingSummary | null {
  try {
    const spec = parseSpec(specJson);
    let endpointCount = 0;
    let minCost = Number.POSITIVE_INFINITY;
    let maxCost = Number.NEGATIVE_INFINITY;
    let hasFreeTier = false;

    for (const pathItem of Object.values(spec.paths)) {
      if (pathItem === undefined) continue;
      for (const op of Object.values(pathItem)) {
        if (op === undefined) continue;
        endpointCount += 1;
        const pricing = extractPricing(op);
        minCost = Math.min(minCost, pricing.cost);
        maxCost = Math.max(maxCost, pricing.cost);
        if (pricing.freeTier !== undefined && pricing.freeTier > 0) {
          hasFreeTier = true;
        }
      }
    }

    if (endpointCount === 0) {
      return {
        minCost: 0,
        maxCost: 0,
        endpointCount: 0,
        hasFreeTier: false,
      };
    }

    return {
      minCost,
      maxCost,
      endpointCount,
      hasFreeTier,
    };
  } catch {
    return null;
  }
}

function listingPricing(
  listing: Doc<"catalogueListings">,
): ListingPricingSummary | null {
  return listing.pricingValid
    ? {
        minCost: listing.minCost,
        maxCost: listing.maxCost,
        endpointCount: listing.endpointCount,
        hasFreeTier: listing.hasFreeTier,
      }
    : null;
}

function publicListing(listing: Doc<"catalogueListings">): PublicListing {
  return {
    name: listing.name,
    slug: listing.slug,
    description: listing.description,
    tags: listing.tags,
    orgName: listing.orgName,
    publisherHandle: listing.publisherHandle,
    publishedAt: listing.publishedAt || null,
    pricing: listingPricing(listing),
  };
}

async function adjustCatalogueCount(
  ctx: MutationCtx,
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  const stats = await ctx.db
    .query("catalogueStats")
    .withIndex("by_key", (q) => q.eq("key", CATALOGUE_STATS_KEY))
    .unique();
  const now = Date.now();
  if (stats === null) {
    await ctx.db.insert("catalogueStats", {
      key: CATALOGUE_STATS_KEY,
      publicCount: Math.max(0, delta),
      projectionComplete: false,
      updatedAt: now,
    });
    return;
  }
  await ctx.db.patch(stats._id, {
    publicCount: Math.max(0, stats.publicCount + delta),
    updatedAt: now,
  });
}

async function adjustCatalogueFacets(
  ctx: MutationCtx,
  previous: Pick<
    Doc<"catalogueListings">,
    "discoverable" | "tags" | "hasFreeTier"
  > | null,
  next: Pick<Doc<"catalogueListings">, "discoverable" | "tags" | "hasFreeTier">,
): Promise<void> {
  const stats = await ctx.db
    .query("catalogueStats")
    .withIndex("by_key", (q) => q.eq("key", CATALOGUE_STATS_KEY))
    .unique();
  if (stats === null) return;
  const tags = { ...(stats.tagCounts ?? {}) };
  let freeTierCount = stats.freeTierCount ?? 0;
  if (previous?.discoverable) {
    for (const tag of previous.tags)
      tags[tag] = Math.max(0, (tags[tag] ?? 0) - 1);
    if (previous.hasFreeTier) freeTierCount = Math.max(0, freeTierCount - 1);
  }
  if (next.discoverable) {
    for (const tag of next.tags) tags[tag] = (tags[tag] ?? 0) + 1;
    if (next.hasFreeTier) freeTierCount += 1;
  }
  await ctx.db.patch(stats._id, { tagCounts: tags, freeTierCount });
}

async function syncTagListings(
  ctx: MutationCtx,
  listingId: Id<"catalogueListings">,
  listing: Pick<
    Doc<"catalogueListings">,
    "tags" | "publishedAt" | "sortName" | "minCost" | "discoverable"
  > | null,
): Promise<void> {
  const previous = await ctx.db
    .query("catalogueTagListings")
    .withIndex("by_listing", (q) => q.eq("listingId", listingId))
    .collect();
  for (const row of previous) await ctx.db.delete(row._id);
  if (listing === null) return;
  for (const tag of listing.tags) {
    await ctx.db.insert("catalogueTagListings", {
      listingId,
      tag,
      publishedAt: listing.publishedAt,
      sortName: listing.sortName,
      minCost: listing.minCost,
      discoverable: listing.discoverable,
    });
  }
}

/** Maintain one denormalized listing from authoritative project/org/spec rows. */
export async function syncCatalogueListing(
  ctx: MutationCtx,
  projectId: Id<"projects">,
): Promise<Doc<"catalogueListings"> | null> {
  const existing = await ctx.db
    .query("catalogueListings")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .unique();
  const project = await ctx.db.get(projectId);
  if (project === null) {
    if (existing !== null) {
      await ctx.db.delete(existing._id);
      await syncTagListings(ctx, existing._id, null);
      await adjustCatalogueCount(ctx, existing.discoverable ? -1 : 0);
    }
    return null;
  }
  if (project.status !== "published" && existing === null) return null;
  const organization = await getActiveOrgById(ctx, project.organizationId);
  if (organization === null || organization.publicHandle === undefined) {
    if (existing !== null && existing.discoverable) {
      await ctx.db.patch(existing._id, {
        discoverable: false,
        updatedAt: Date.now(),
      });
      await adjustCatalogueCount(ctx, -1);
      await syncTagListings(ctx, existing._id, {
        ...existing,
        discoverable: false,
      });
    }
    return null;
  }
  const discoverable =
    project.status === "published" &&
    project.visibility === "public" &&
    project.deprecationStartedAt === undefined &&
    project.retiredAt === undefined &&
    organization.archivedAt === undefined;
  if (!discoverable && existing === null) return null;
  const latest = await ctx.db
    .query("specVersions")
    .withIndex("by_project_published", (q) => q.eq("projectId", projectId))
    .order("desc")
    .first();
  const pricing =
    latest === null ? null : summarizePublishedPricing(latest.spec);
  const next = {
    projectId,
    clerkOrgId: organization.clerkOrgId,
    publisherHandle: organization.publicHandle,
    orgName: organization.name,
    name: project.name,
    sortName: `${project.name.toLowerCase()}\u0000${project.slug}`,
    slug: project.slug,
    description: project.description,
    tags: project.tags,
    tagText: project.tags.join(" "),
    searchText:
      `${project.name} ${project.slug} ${project.description ?? ""} ${project.tags.join(" ")}`.toLowerCase(),
    publishedAt: latest?.publishedAt ?? 0,
    pricingValid: pricing !== null,
    minCost:
      pricing === null || pricing.endpointCount === 0
        ? MAX_ENDPOINT_COST_CREDITS + 1
        : pricing.minCost,
    maxCost: pricing?.maxCost ?? 0,
    endpointCount: pricing?.endpointCount ?? 0,
    hasFreeTier: pricing?.hasFreeTier ?? false,
    discoverable,
    updatedAt: Date.now(),
  };
  const unchanged =
    existing !== null &&
    existing.clerkOrgId === next.clerkOrgId &&
    existing.publisherHandle === next.publisherHandle &&
    existing.orgName === next.orgName &&
    existing.name === next.name &&
    existing.sortName === next.sortName &&
    existing.slug === next.slug &&
    existing.description === next.description &&
    JSON.stringify(existing.tags) === JSON.stringify(next.tags) &&
    existing.tagText === next.tagText &&
    existing.searchText === next.searchText &&
    existing.publishedAt === next.publishedAt &&
    existing.pricingValid === next.pricingValid &&
    existing.minCost === next.minCost &&
    existing.maxCost === next.maxCost &&
    existing.endpointCount === next.endpointCount &&
    existing.hasFreeTier === next.hasFreeTier &&
    existing.discoverable === next.discoverable;
  if (unchanged) return existing;

  let listingId: Id<"catalogueListings">;
  if (existing === null) {
    listingId = await ctx.db.insert("catalogueListings", next);
  } else {
    await ctx.db.replace(existing._id, next);
    listingId = existing._id;
  }
  await adjustCatalogueCount(
    ctx,
    Number(discoverable) - Number(existing?.discoverable ?? false),
  );
  await adjustCatalogueFacets(ctx, existing, next);
  await syncTagListings(ctx, listingId, next);
  return await ctx.db.get(listingId);
}

/** Optional-first bounded backfill; safe to resume after any partial deploy. */
export const backfillCatalogueListingsPage = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<{ processed: number; done: boolean }> => {
    const page = await ctx.db.query("projects").paginate({
      cursor: args.cursor,
      numItems: PROJECTION_BACKFILL_PAGE_SIZE,
      maximumRowsRead: PROJECTION_BACKFILL_PAGE_SIZE + 1,
    });
    for (const project of page.page) {
      await syncCatalogueListing(ctx, project._id);
    }
    let stats = await ctx.db
      .query("catalogueStats")
      .withIndex("by_key", (q) => q.eq("key", CATALOGUE_STATS_KEY))
      .unique();
    if (stats === null) {
      const id = await ctx.db.insert("catalogueStats", {
        key: CATALOGUE_STATS_KEY,
        publicCount: 0,
        projectionComplete: page.isDone,
        backfillCursor: page.isDone ? undefined : page.continueCursor,
        updatedAt: Date.now(),
      });
      stats = await ctx.db.get(id);
    } else {
      await ctx.db.patch(stats._id, {
        projectionComplete: page.isDone,
        backfillCursor: page.isDone ? undefined : page.continueCursor,
        updatedAt: Date.now(),
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.catalogue.backfillCatalogueListingsPage,
        { cursor: page.continueCursor },
      );
    }
    return { processed: page.page.length, done: page.isDone };
  },
});

export const resumeCatalogueProjectionBackfill = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ scheduled: boolean }> => {
    const stats = await ctx.db
      .query("catalogueStats")
      .withIndex("by_key", (q) => q.eq("key", CATALOGUE_STATS_KEY))
      .unique();
    if (stats?.projectionComplete === true) return { scheduled: false };
    await ctx.scheduler.runAfter(
      0,
      internal.catalogue.backfillCatalogueListingsPage,
      { cursor: stats?.backfillCursor ?? null },
    );
    return { scheduled: true };
  },
});

export const syncOrganizationCataloguePage = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<{ processed: number; done: boolean }> => {
    const page = await ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId))
      .paginate({
        cursor: args.cursor,
        numItems: PROJECTION_BACKFILL_PAGE_SIZE,
        maximumRowsRead: PROJECTION_BACKFILL_PAGE_SIZE + 1,
      });
    for (const project of page.page) {
      await syncCatalogueListing(ctx, project._id);
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.catalogue.syncOrganizationCataloguePage,
        {
          organizationId: args.organizationId,
          cursor: page.continueCursor,
        },
      );
    }
    return { processed: page.page.length, done: page.isDone };
  },
});

function parseSort(raw: string | undefined): CatalogueSort {
  if (raw === "name" || raw === "cheapest" || raw === "newest") return raw;
  return "newest";
}

export const listPublic = query({
  args: {
    search: v.optional(v.string()),
    tag: v.optional(v.string()),
    cursor: v.optional(v.string()),
    sort: v.optional(
      v.union(v.literal("newest"), v.literal("name"), v.literal("cheapest")),
    ),
    hasFreeTier: v.optional(v.boolean()),
    maxCost: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    items: PublicListing[];
    nextCursor: string | null;
    /** Total public+published projects, uncapped by search/tag/price filters. */
    total: number;
    facets: {
      tags: Array<{ name: string; count: number }>;
      freeTierCount: number;
    };
  }> => {
    const search =
      args.search === undefined ? "" : args.search.trim().toLowerCase();
    const tag = args.tag === undefined ? "" : args.tag.trim().toLowerCase();
    if (search.length > 200 || tag.length > 64) {
      throw new Error("Catalogue filter is too long");
    }
    const sort = parseSort(args.sort);
    const freeOnly = args.hasFreeTier === true;
    if (
      args.maxCost !== undefined &&
      (!Number.isSafeInteger(args.maxCost) ||
        args.maxCost < 0 ||
        args.maxCost > MAX_ENDPOINT_COST_CREDITS)
    ) {
      throw new Error("Invalid maximum endpoint cost");
    }
    const maxCostCap = args.maxCost ?? null;
    const cursor = args.cursor && args.cursor !== "" ? args.cursor : null;
    const stats = await ctx.db
      .query("catalogueStats")
      .withIndex("by_key", (q) => q.eq("key", CATALOGUE_STATS_KEY))
      .unique();

    // Deploy-safe compatibility path: bounded raw-page reads remain live while
    // the projection backfill advances. No table scan, offset, or unbounded N+1.
    if (stats?.projectionComplete !== true) {
      const items: PublicListing[] = [];
      let staleCount = 0;
      const rawPage = await ctx.db
        .query("projects")
        .withIndex("by_visibility_status", (q) =>
          q.eq("visibility", "public").eq("status", "published"),
        )
        .order("desc")
        .paginate({
          cursor,
          numItems: PAGE_SIZE,
          maximumRowsRead: PUBLIC_SCAN_CAP,
        });
      for (const project of rawPage.page) {
        if (
          project.deprecationStartedAt !== undefined ||
          project.retiredAt !== undefined
        ) {
          staleCount += 1;
          continue;
        }
        const organization = await getActiveOrgById(
          ctx,
          project.organizationId,
        );
        if (
          organization === null ||
          organization.archivedAt !== undefined ||
          !organization.publicHandle
        ) {
          continue;
        }
        const latest = await ctx.db
          .query("specVersions")
          .withIndex("by_project_published", (q) =>
            q.eq("projectId", project._id),
          )
          .order("desc")
          .first();
        const pricing =
          latest === null ? null : summarizePublishedPricing(latest.spec);
        const hay =
          `${project.name} ${project.slug} ${project.description ?? ""} ${project.tags.join(" ")}`.toLowerCase();
        if (search !== "" && !hay.includes(search)) continue;
        if (tag !== "" && !project.tags.includes(tag)) continue;
        if (freeOnly && !pricing?.hasFreeTier) continue;
        if (
          maxCostCap !== null &&
          (pricing === null ||
            pricing.endpointCount === 0 ||
            pricing.minCost > maxCostCap)
        ) {
          continue;
        }
        items.push({
          name: project.name,
          slug: project.slug,
          description: project.description,
          tags: project.tags,
          orgName: organization.name,
          publisherHandle: organization.publicHandle,
          publishedAt: latest?.publishedAt ?? null,
          pricing,
        });
      }
      items.sort((a, b) => {
        if (sort === "name") return a.name.localeCompare(b.name);
        if (sort === "cheapest") {
          return (
            (a.pricing?.minCost ?? Number.POSITIVE_INFINITY) -
              (b.pricing?.minCost ?? Number.POSITIVE_INFINITY) ||
            a.name.localeCompare(b.name)
          );
        }
        return (b.publishedAt ?? 0) - (a.publishedAt ?? 0);
      });
      return {
        items,
        nextCursor: rawPage.isDone ? null : rawPage.continueCursor,
        total: Math.max(
          0,
          (tag !== "" && !freeOnly && maxCostCap === null
            ? (stats?.tagCounts?.[tag] ?? 0)
            : freeOnly && tag === "" && maxCostCap === null
              ? (stats?.freeTierCount ?? 0)
              : (stats?.publicCount ?? items.length)) - staleCount,
        ),
        facets: {
          tags: Object.entries(stats?.tagCounts ?? {}).map(([name, count]) => ({
            name,
            count,
          })),
          freeTierCount: Math.max(0, (stats?.freeTierCount ?? 0) - 0),
        },
      };
    }

    if (tag !== "") {
      const tagPage =
        sort === "name"
          ? await ctx.db
              .query("catalogueTagListings")
              .withIndex("by_tag_name", (q) =>
                q.eq("tag", tag).eq("discoverable", true),
              )
              .order("asc")
              .paginate({
                cursor,
                numItems: PAGE_SIZE,
                maximumRowsRead: PUBLIC_SCAN_CAP,
              })
          : sort === "cheapest"
            ? await ctx.db
                .query("catalogueTagListings")
                .withIndex("by_tag_cost", (q) =>
                  q.eq("tag", tag).eq("discoverable", true),
                )
                .order("asc")
                .paginate({
                  cursor,
                  numItems: PAGE_SIZE,
                  maximumRowsRead: PUBLIC_SCAN_CAP,
                })
            : await ctx.db
                .query("catalogueTagListings")
                .withIndex("by_tag_newest", (q) =>
                  q.eq("tag", tag).eq("discoverable", true),
                )
                .order("desc")
                .paginate({
                  cursor,
                  numItems: PAGE_SIZE,
                  maximumRowsRead: PUBLIC_SCAN_CAP,
                });
      const tagged = (
        await Promise.all(
          tagPage.page.map(async (row) => {
            const listing = await ctx.db.get(row.listingId);
            if (listing === null || !listing.discoverable) return null;
            if (search !== "" && !listing.searchText.includes(search))
              return null;
            if (freeOnly && !listing.hasFreeTier) return null;
            if (
              maxCostCap !== null &&
              (!listing.pricingValid ||
                listing.endpointCount === 0 ||
                listing.minCost > maxCostCap)
            )
              return null;
            const organization = await getOrgByClerkId(ctx, listing.clerkOrgId);
            return organization?.publicHandle === listing.publisherHandle
              ? listing
              : null;
          }),
        )
      ).filter(
        (listing): listing is Doc<"catalogueListings"> => listing !== null,
      );
      return {
        items: tagged.map(publicListing),
        nextCursor: tagPage.isDone ? null : tagPage.continueCursor,
        total: stats.tagCounts?.[tag] ?? 0,
        facets: {
          tags: Object.entries(stats.tagCounts ?? {}).map(([name, count]) => ({
            name,
            count,
          })),
          freeTierCount: stats.freeTierCount ?? 0,
        },
      };
    }

    const pagination = {
      cursor,
      numItems: PAGE_SIZE,
      maximumRowsRead: PUBLIC_SCAN_CAP,
    };
    const page =
      search !== ""
        ? await ctx.db
            .query("catalogueListings")
            .withSearchIndex("search_public", (q) => {
              const searched = q
                .search("searchText", search)
                .eq("discoverable", true);
              return freeOnly ? searched.eq("hasFreeTier", true) : searched;
            })
            .filter((q) => {
              if (maxCostCap !== null) {
                return q.and(
                  q.eq(q.field("pricingValid"), true),
                  q.gt(q.field("endpointCount"), 0),
                  q.lte(q.field("minCost"), maxCostCap),
                );
              }
              return true;
            })
            .paginate(pagination)
        : sort === "name"
          ? await ctx.db
              .query("catalogueListings")
              .withIndex("by_discoverable_name", (q) =>
                q.eq("discoverable", true),
              )
              .order("asc")
              .filter((q) => {
                if (maxCostCap !== null) {
                  return q.and(
                    q.eq(q.field("pricingValid"), true),
                    q.gt(q.field("endpointCount"), 0),
                    q.lte(q.field("minCost"), maxCostCap),
                  );
                }
                return true;
              })
              .paginate(pagination)
          : sort === "cheapest"
            ? await ctx.db
                .query("catalogueListings")
                .withIndex("by_discoverable_cost", (q) =>
                  q.eq("discoverable", true),
                )
                .order("asc")
                .filter((q) => {
                  if (maxCostCap !== null) {
                    return q.and(
                      q.eq(q.field("pricingValid"), true),
                      q.gt(q.field("endpointCount"), 0),
                      q.lte(q.field("minCost"), maxCostCap),
                    );
                  }
                  return true;
                })
                .paginate(pagination)
            : await ctx.db
                .query("catalogueListings")
                .withIndex("by_discoverable_newest", (q) =>
                  q.eq("discoverable", true),
                )
                .order("desc")
                .filter((q) => {
                  if (maxCostCap !== null) {
                    return q.and(
                      q.eq(q.field("pricingValid"), true),
                      q.gt(q.field("endpointCount"), 0),
                      q.lte(q.field("minCost"), maxCostCap),
                    );
                  }
                  return true;
                })
                .paginate(pagination);
    const filtered = page.page.filter((listing) => {
      if (tag !== "" && !listing.tags.includes(tag)) return false;
      if (freeOnly && !listing.hasFreeTier) return false;
      return true;
    });
    const active = await Promise.all(
      filtered.map(async (listing) => {
        const organization = await getOrgByClerkId(ctx, listing.clerkOrgId);
        return organization?.publicHandle === listing.publisherHandle
          ? { listing, stale: false }
          : { listing, stale: true };
      }),
    );
    const staleCount = active.filter((row) => row.stale).length;
    const items = active.filter((row) => !row.stale).map((row) => row.listing);
    return {
      items: items.map(publicListing),
      nextCursor: page.isDone ? null : page.continueCursor,
      total: Math.max(
        0,
        (tag !== "" && !freeOnly && maxCostCap === null
          ? (stats.tagCounts?.[tag] ?? 0)
          : freeOnly && tag === "" && maxCostCap === null
            ? (stats.freeTierCount ?? 0)
            : stats.publicCount) - staleCount,
      ),
      facets: {
        tags: Object.entries(stats.tagCounts ?? {}).map(([name, count]) => ({
          name,
          count,
        })),
        freeTierCount: stats.freeTierCount ?? 0,
      },
    };
  },
});

export const getPublicDetail = query({
  args: {
    publisherHandle: v.string(),
    projectSlug: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    project: {
      name: string;
      slug: string;
      description: string | undefined;
      tags: string[];
      status: Doc<"projects">["status"];
      visibility: Doc<"projects">["visibility"];
    };
    org: {
      name: string;
      publisherHandle: string;
      imageUrl: string | undefined;
    };
    latestVersion: {
      version: string;
      spec: string;
      publishedAt: number;
      deprecatedAt: number | undefined;
      sunsetAt: number | undefined;
      deprecationMessage: string | undefined;
    } | null;
  } | null> => {
    const org = await getOrgByPublicHandle(ctx, args.publisherHandle);
    if (org === null || org.publicHandle === undefined) return null;

    const project = await ctx.db
      .query("projects")
      .withIndex("by_org_slug", (q) =>
        q.eq("organizationId", org._id).eq("slug", args.projectSlug),
      )
      .unique();
    if (project === null) return null;
    if (project.visibility !== "public" || project.status !== "published") {
      return null;
    }

    const latest = await ctx.db
      .query("specVersions")
      .withIndex("by_project_published", (q) => q.eq("projectId", project._id))
      .order("desc")
      .first();

    return {
      project: {
        name: project.name,
        slug: project.slug,
        description: project.description,
        tags: project.tags,
        status: project.status,
        visibility: project.visibility,
      },
      org: {
        name: org.name,
        publisherHandle: org.publicHandle,
        imageUrl: org.imageUrl,
      },
      latestVersion:
        latest === null
          ? null
          : {
              version: latest.version,
              spec: latest.spec,
              publishedAt: latest.publishedAt,
              deprecatedAt: project.deprecationStartedAt ?? latest.deprecatedAt,
              sunsetAt: project.sunsetAt ?? latest.sunsetAt,
              deprecationMessage:
                project.deprecationMessage ?? latest.deprecationMessage,
            },
    };
  },
});
