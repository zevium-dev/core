import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { shardFor } from "../money/rollups";
import { isActive } from "./identity";
import { qualitySnapshotContract } from "./qualityContract";
export function facetKeys(p: Doc<"projects">) {
  return p.discoverable && p.endpointCount > 0
    ? [
        "total",
        ...(p.hasFreeTier ? ["free"] : []),
        ...p.tags.map((t) => `tag:${t}`),
      ]
    : [];
}
/** Called in the same transaction as every discoverability/metadata change. */
export async function syncCatalogue(
  ctx: MutationCtx,
  before: Doc<"projects"> | null,
  after: Doc<"projects">,
) {
  if (
    after.latestVersionId &&
    after.discoverable &&
    (!before?.discoverable ||
      before.latestVersionId !== after.latestVersionId ||
      before.name !== after.name ||
      before.description !== after.description ||
      JSON.stringify(before.tags) !== JSON.stringify(after.tags))
  ) {
    await ctx.scheduler.runAfter(0, internal.search.embedProject, {
      projectId: after._id,
    });
  }
  if (
    !after.discoverable ||
    before?.latestVersionId !== after.latestVersionId
  ) {
    const vector = await ctx.db
      .query("specEmbeddings")
      .withIndex("by_project", (q) => q.eq("projectId", after._id))
      .unique();
    if (vector) await ctx.db.delete(vector._id);
  }
  const previous = new Set(before ? facetKeys(before) : []),
    next = new Set(facetKeys(after));
  const shard = shardFor(after._id);
  for (const facetKey of new Set([...previous, ...next])) {
    const delta = Number(next.has(facetKey)) - Number(previous.has(facetKey));
    if (!delta) continue;
    const row = await ctx.db
      .query("catalogueIndex")
      .withIndex("by_facet", (q) =>
        q.eq("kind", "facet").eq("facetKey", facetKey).eq("shard", shard),
      )
      .unique();
    if (row?.kind === "facet") {
      const count = row.count + delta;
      if (count < 0) throw new Error("Catalogue count underflow");
      if (count === 0) await ctx.db.delete(row._id);
      else await ctx.db.patch(row._id, { count, updatedAt: Date.now() });
    } else if (delta > 0)
      await ctx.db.insert("catalogueIndex", {
        kind: "facet",
        facetKey,
        shard,
        count: delta,
        updatedAt: Date.now(),
      });
  }
  const tags = await ctx.db
    .query("catalogueIndex")
    .withIndex("by_project", (q) =>
      q.eq("kind", "tag").eq("projectId", after._id),
    )
    .take(32);
  for (const row of tags) await ctx.db.delete(row._id);
  if (next.size)
    for (const tag of after.tags)
      await ctx.db.insert("catalogueIndex", {
        kind: "tag",
        projectId: after._id,
        tag,
        discoverable: true,
        publishedAt: after.publishedAt ?? 0,
        sortName: after.sortName,
        minCost: after.minCost ?? 0,
      });
}
export async function listing(
  ctx: Pick<QueryCtx, "db">,
  project: Doc<"projects">,
) {
  if (!project.discoverable || project.endpointCount === 0) return null;
  const org = await ctx.db.get(project.organizationId);
  if (!org || !(await isActive(ctx, org))) return null;
  return {
    name: project.name,
    slug: project.slug,
    description: project.description,
    tags: project.tags,
    orgName: org.name,
    publisherHandle: org.publicHandle,
    publishedAt: project.publishedAt ?? null,
    houseOperated: project.houseOperated,
    pricing: {
      minCost: project.minCost ?? 0,
      maxCost: project.maxCost ?? 0,
      endpointCount: project.endpointCount,
      hasFreeTier: project.hasFreeTier,
    },
    quality:
      project.quality.snapshot?.specVersionId === project.latestVersionId &&
      project.quality.snapshot
        ? qualitySnapshotContract(project.quality.snapshot)
        : null,
  };
}
export async function adjustStat(
  ctx: MutationCtx,
  key: string,
  id: string,
  delta: number,
) {
  const facetKey = `stats:${key}`,
    shard = shardFor(id),
    row = await ctx.db
      .query("catalogueIndex")
      .withIndex("by_facet", (q) =>
        q.eq("kind", "facet").eq("facetKey", facetKey).eq("shard", shard),
      )
      .unique();
  if (row?.kind === "facet")
    await ctx.db.patch(row._id, {
      count: row.count + delta,
      updatedAt: Date.now(),
    });
  else
    await ctx.db.insert("catalogueIndex", {
      kind: "facet",
      facetKey,
      shard,
      count: delta,
      updatedAt: Date.now(),
    });
}
