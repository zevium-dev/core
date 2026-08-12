import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isValidSlug } from "./validate";

type DbCtx = QueryCtx | MutationCtx;

export async function getOrganizationTombstone(
  ctx: DbCtx,
  clerkOrgId: string,
): Promise<Doc<"organizationTombstones"> | null> {
  return await ctx.db
    .query("organizationTombstones")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", clerkOrgId))
    .first();
}

/** Terminal Clerk deletion wins over every mutable organization mirror field. */
export async function isOrganizationActive(
  ctx: DbCtx,
  organization: Doc<"organizations">,
): Promise<boolean> {
  return (
    organization.archivedAt === undefined &&
    (await getOrganizationTombstone(ctx, organization.clerkOrgId)) === null
  );
}

export async function getActiveOrganizationByClerkId(
  ctx: DbCtx,
  clerkOrgId: string,
): Promise<Doc<"organizations"> | null> {
  const rows = await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", clerkOrgId))
    .take(2);
  if (rows.length !== 1) return null;
  return (await isOrganizationActive(ctx, rows[0]!)) ? rows[0]! : null;
}

export async function getActiveOrganizationBySlug(
  ctx: DbCtx,
  slug: string,
): Promise<Doc<"organizations"> | null> {
  const rows = await ctx.db
    .query("organizations")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .take(2);
  if (rows.length !== 1) return null;
  return (await isOrganizationActive(ctx, rows[0]!)) ? rows[0]! : null;
}

export async function getActiveOrganizationByPublicHandle(
  ctx: DbCtx,
  handle: string,
): Promise<Doc<"organizations"> | null> {
  const normalized = handle.trim().toLowerCase();
  const rows = await ctx.db
    .query("organizations")
    .withIndex("by_public_handle", (q) => q.eq("publicHandle", normalized))
    .take(2);
  if (rows.length !== 1) return null;
  return (await isOrganizationActive(ctx, rows[0]!)) ? rows[0]! : null;
}

/** Any retirement tombstone dominates a restored mutable project row. */
export async function isProjectRetired(
  _ctx: DbCtx,
  project: Doc<"projects">,
): Promise<boolean> {
  if (project.retiredAt !== undefined) return true;
  return false;
}

/**
 * Public routing exists only through its permanent exact reservation. A row
 * from another org/project incarnation, renamed handle/slug, or retired URL is
 * terminally invalid even when mutable source rows look active.
 */
export async function getActivePublicRouteBinding(
  ctx: DbCtx,
  organization: Doc<"organizations">,
  project: Doc<"projects">,
): Promise<Doc<"publicRouteTombstones"> | null> {
  if (!(await isOrganizationActive(ctx, organization))) return null;
  if (project.retiredAt !== undefined) return null;
  const publisherHandle = organization.publicHandle?.trim().toLowerCase();
  if (!publisherHandle) return null;
  const rows = await ctx.db
    .query("publicRouteTombstones")
    .withIndex("by_project", (q) => q.eq("projectId", project._id))
    .collect();
  return (
    rows.find(
      (binding) =>
        binding.organizationId === organization._id &&
        binding.projectId === project._id &&
        binding.publisherHandle === publisherHandle &&
        binding.projectSlug === project.slug &&
        binding.retiredAt === undefined,
    ) ?? null
  );
}

export async function resolveActivePublicRoute(
  ctx: DbCtx,
  publisherHandle: string,
  projectSlug: string,
): Promise<{
  organization: Doc<"organizations">;
  project: Doc<"projects">;
  binding: Doc<"publicRouteTombstones">;
} | null> {
  const organization = await getActiveOrganizationByPublicHandle(
    ctx,
    publisherHandle,
  );
  if (organization === null) return null;
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_org_slug", (q) =>
      q.eq("organizationId", organization._id).eq("slug", projectSlug),
    )
    .take(2);
  if (projects.length !== 1) return null;
  const binding = await getActivePublicRouteBinding(
    ctx,
    organization,
    projects[0]!,
  );
  return binding === null
    ? null
    : { organization, project: projects[0]!, binding };
}

export async function isPublicHandleReserved(
  ctx: DbCtx,
  handle: string,
  organizationId?: Id<"organizations">,
): Promise<boolean> {
  const normalized = handle.trim().toLowerCase();
  const organizations = await ctx.db
    .query("organizations")
    .withIndex("by_public_handle", (q) => q.eq("publicHandle", normalized))
    .take(2);
  if (
    organizations.some((organization) => organization._id !== organizationId)
  ) {
    return true;
  }
  const tombstone = await ctx.db
    .query("publicRouteTombstones")
    .withIndex("by_handle", (q) => q.eq("publisherHandle", normalized))
    .first();
  return tombstone !== null && tombstone.organizationId !== organizationId;
}

/** Deterministically retain the oldest valid legacy handle owner. */
export async function resolveRolloutPublicHandle(
  ctx: MutationCtx,
  organization: Doc<"organizations">,
): Promise<string> {
  const current = organization.publicHandle?.trim().toLowerCase();
  if (current !== undefined && isValidSlug(current)) {
    const oldestOrganization = await ctx.db
      .query("organizations")
      .withIndex("by_public_handle", (q) => q.eq("publicHandle", current))
      .order("asc")
      .first();
    const oldestTombstone = await ctx.db
      .query("publicRouteTombstones")
      .withIndex("by_handle", (q) => q.eq("publisherHandle", current))
      .order("asc")
      .first();
    if (
      oldestOrganization?._id === organization._id &&
      (oldestTombstone === null ||
        oldestTombstone.organizationId === organization._id)
    ) {
      return current;
    }
  }
  return await availablePublicHandle(
    ctx,
    current ?? organization.slug,
    organization.clerkOrgId,
    organization._id,
  );
}

function safeBaseHandle(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  return isValidSlug(normalized) ? normalized : "publisher";
}

function handleSuffix(sourceId: string): string {
  const compact = sourceId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact.slice(-12) || "organization";
}

/** Pick a stable handle without reclaiming archived/public route namespaces. */
export async function availablePublicHandle(
  ctx: DbCtx,
  requested: string,
  sourceId: string,
  organizationId?: Id<"organizations">,
): Promise<string> {
  const base = safeBaseHandle(requested);
  if (!(await isPublicHandleReserved(ctx, base, organizationId))) return base;

  const suffix = handleSuffix(sourceId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const tail = attempt === 0 ? suffix : `${suffix}-${attempt}`;
    const prefix = base.slice(0, Math.max(1, 64 - tail.length - 1));
    const candidate = `${prefix}-${tail}`;
    if (
      isValidSlug(candidate) &&
      !(await isPublicHandleReserved(ctx, candidate, organizationId))
    ) {
      return candidate;
    }
  }
  throw new Error("Could not allocate a permanent public handle");
}

/** Reserve publisher handle + project slug forever on first route publish. */
export async function reservePublicRoute(
  ctx: MutationCtx,
  project: Doc<"projects">,
  organization: Doc<"organizations">,
  reservedAt: number,
  handleOverride?: string,
): Promise<Doc<"publicRouteTombstones">> {
  const publisherHandle = (handleOverride ?? organization.publicHandle)
    ?.trim()
    .toLowerCase();
  if (!publisherHandle) throw new Error("Organization has no public handle");

  const byProject = await ctx.db
    .query("publicRouteTombstones")
    .withIndex("by_project", (q) => q.eq("projectId", project._id))
    .collect();
  const exact = byProject.find(
    (row) =>
      row.organizationId === organization._id &&
      row.publisherHandle === publisherHandle &&
      row.projectSlug === project.slug,
  );
  if (exact !== undefined) {
    return exact;
  }

  const byPublicUrl = await ctx.db
    .query("publicRouteTombstones")
    .withIndex("by_public_url", (q) =>
      q.eq("publisherHandle", publisherHandle).eq("projectSlug", project.slug),
    )
    .unique();
  if (byPublicUrl !== null) {
    throw new Error("Public API URL is permanently reserved");
  }

  const id = await ctx.db.insert("publicRouteTombstones", {
    routeKey: `${publisherHandle}/${project.slug}`,
    organizationId: organization._id,
    projectId: project._id,
    publisherHandle,
    projectSlug: project.slug,
    reservedAt,
  });
  const inserted = await ctx.db.get(id);
  if (inserted === null) throw new Error("Failed to reserve public API URL");
  return inserted;
}

export async function retirePublicRoute(
  ctx: MutationCtx,
  project: Doc<"projects">,
  organization: Doc<"organizations">,
  retiredAt: number,
  handleOverride?: string,
): Promise<void> {
  const tombstone = await reservePublicRoute(
    ctx,
    project,
    organization,
    retiredAt,
    handleOverride,
  );
  if (tombstone.retiredAt === undefined) {
    await ctx.db.patch(tombstone._id, { retiredAt });
  }
}
