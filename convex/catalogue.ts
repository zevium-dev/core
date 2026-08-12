import { extractPricing, parseSpec } from "@zevium/shared";
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { getOrgByPublicHandle } from "./lib/auth";

const PAGE_SIZE = 24;

export type CatalogueSort = "newest" | "name" | "cheapest";

/** Pricing rollup from latest published specVersion at query time. */
export type ListingPricingSummary = {
  minCost: number;
  maxCost: number;
  endpointCount: number;
  hasFreeTier: boolean;
};

export type PublicListing = {
  projectId: Doc<"projects">["_id"];
  name: string;
  slug: string;
  description: string | undefined;
  tags: string[];
  organizationId: Doc<"organizations">["_id"];
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
  }> => {
    const search =
      args.search === undefined ? "" : args.search.trim().toLowerCase();
    const tag = args.tag === undefined ? "" : args.tag.trim().toLowerCase();
    const sort = parseSort(args.sort);
    const freeOnly = args.hasFreeTier === true;
    const maxCostCap =
      args.maxCost !== undefined &&
      Number.isFinite(args.maxCost) &&
      args.maxCost >= 0
        ? args.maxCost
        : null;

    const offset =
      args.cursor !== undefined && args.cursor !== ""
        ? Number.parseInt(args.cursor, 10)
        : 0;
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;

    // Public catalogue is still small; filter in memory after index scan.
    // Later: vectorIndex + searchIndex (TECH.md).
    const candidates = await ctx.db
      .query("projects")
      .withIndex("by_visibility_status", (q) =>
        q.eq("visibility", "public").eq("status", "published"),
      )
      .collect();

    // Total public+published count, decoupled from search/tag/price filtering
    // below — the landing "APIs listed" stat wants the whole catalogue size,
    // not a filtered subset. Bounded at 1000 docs (noted in the return type
    // comment); catalogue growth past that undercounts the stat.
    const totalDocs = await ctx.db
      .query("projects")
      .withIndex("by_visibility_status", (q) =>
        q.eq("visibility", "public").eq("status", "published"),
      )
      .take(1000);
    const total = totalDocs.length;

    const filtered: Array<{
      project: Doc<"projects">;
      org: Doc<"organizations">;
      publishedAt: number | null;
      pricing: ListingPricingSummary | null;
    }> = [];

    for (const project of candidates) {
      if (project.retiringAt !== undefined) continue;
      if (tag !== "" && !project.tags.includes(tag)) continue;

      if (search !== "") {
        const hay =
          `${project.name} ${project.slug} ${project.description ?? ""} ${project.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(search)) continue;
      }

      const org = await ctx.db.get(project.organizationId);
      if (org === null || org.retiringAt !== undefined) continue;
      // Public URLs are only valid through the dedicated publisher handle.
      // Never emit an empty segment or fall back to Clerk's internal slug.
      if (org.publicHandle === undefined || org.publicHandle === "") continue;

      // Latest published version only — drafts live in specs table, never here.
      const latest = await ctx.db
        .query("specVersions")
        .withIndex("by_project_published", (q) =>
          q.eq("projectId", project._id),
        )
        .order("desc")
        .first();

      const pricing =
        latest === null ? null : summarizePublishedPricing(latest.spec);

      if (freeOnly && (pricing === null || !pricing.hasFreeTier)) {
        continue;
      }

      if (maxCostCap !== null) {
        // No price data → exclude when caller asked for a cost ceiling.
        if (pricing === null || pricing.endpointCount === 0) continue;
        if (pricing.minCost > maxCostCap) continue;
      }

      filtered.push({
        project,
        org,
        publishedAt: latest?.publishedAt ?? null,
        pricing,
      });
    }

    filtered.sort((a, b) => {
      if (sort === "name") {
        const byName = a.project.name.localeCompare(b.project.name);
        if (byName !== 0) return byName;
        return a.project.slug.localeCompare(b.project.slug);
      }

      if (sort === "cheapest") {
        const aCost =
          a.pricing === null || a.pricing.endpointCount === 0
            ? Number.POSITIVE_INFINITY
            : a.pricing.minCost;
        const bCost =
          b.pricing === null || b.pricing.endpointCount === 0
            ? Number.POSITIVE_INFINITY
            : b.pricing.minCost;
        if (aCost !== bCost) return aCost - bCost;
        return a.project.name.localeCompare(b.project.name);
      }

      // newest (default)
      const ap = a.publishedAt ?? 0;
      const bp = b.publishedAt ?? 0;
      if (bp !== ap) return bp - ap;
      return a.project.name.localeCompare(b.project.name);
    });

    const page = filtered.slice(start, start + PAGE_SIZE);
    const nextOffset = start + PAGE_SIZE;
    const nextCursor = nextOffset < filtered.length ? String(nextOffset) : null;

    return {
      items: page.map(({ project, org, publishedAt, pricing }) => ({
        projectId: project._id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        tags: project.tags,
        organizationId: org._id,
        orgName: org.name,
        publisherHandle: org.publicHandle!,
        publishedAt,
        pricing,
      })),
      nextCursor,
      total,
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
      _id: Doc<"projects">["_id"];
      name: string;
      slug: string;
      description: string | undefined;
      tags: string[];
      status: Doc<"projects">["status"];
      visibility: Doc<"projects">["visibility"];
    };
    org: {
      _id: Doc<"organizations">["_id"];
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
    if (
      org === null ||
      org.publicHandle === undefined ||
      org.retiringAt !== undefined
    ) {
      return null;
    }

    const project = await ctx.db
      .query("projects")
      .withIndex("by_org_slug", (q) =>
        q.eq("organizationId", org._id).eq("slug", args.projectSlug),
      )
      .unique();
    if (project === null || project.retiringAt !== undefined) return null;
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
        _id: project._id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        tags: project.tags,
        status: project.status,
        visibility: project.visibility,
      },
      org: {
        _id: org._id,
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
              deprecatedAt: latest.deprecatedAt,
              sunsetAt: latest.sunsetAt,
              deprecationMessage: latest.deprecationMessage,
            },
    };
  },
});
