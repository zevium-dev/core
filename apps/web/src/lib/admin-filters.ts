/**
 * Pure helpers for the platform admin screens.
 *
 * No React, no Convex — fully unit-testable. The admin routes consume these
 * to coerce filter values and resolve org names client-side (the Convex
 * `listProjects` query returns only `organizationId`; names are joined here
 * from an accumulated org lookup).
 */
import type { Id } from "#/lib/convex-data-model";

export type ProjectStatusFilter = "draft" | "published";
export type ProjectVisibilityFilter = "private" | "public";

export const ADMIN_STATUS_OPTIONS: readonly {
  value: ProjectStatusFilter;
  label: string;
}[] = [
  { value: "draft", label: "Draft" },
  { value: "published", label: "Published" },
];

export const ADMIN_VISIBILITY_OPTIONS: readonly {
  value: ProjectVisibilityFilter;
  label: string;
}[] = [
  { value: "private", label: "Private" },
  { value: "public", label: "Public" },
];

/**
 * Coerce an arbitrary UI/search value to a project status filter.
 * `"all"` (or anything unrecognized) → `undefined` = no filter.
 */
export function parseProjectStatus(
  raw: unknown,
): ProjectStatusFilter | undefined {
  if (raw === "draft" || raw === "published") return raw;
  return undefined;
}

/**
 * Coerce an arbitrary UI/search value to a project visibility filter.
 * `"all"` (or anything unrecognized) → `undefined` = no filter.
 */
export function parseProjectVisibility(
  raw: unknown,
): ProjectVisibilityFilter | undefined {
  if (raw === "private" || raw === "public") return raw;
  return undefined;
}

export type OrgNameEntry = {
  _id: Id<"organizations">;
  name: string;
  slug: string;
};

export type OrgNameMap = Map<
  Id<"organizations">,
  { name: string; slug: string }
>;

/**
 * Build an org-id → `{name, slug}` lookup from accumulated org rows.
 * Runtime-accumulated dynamic-key lookup (paged in over time), hence Map.
 * Later entries win (idempotent rebuild from a merged list).
 */
export function buildOrgNameMap(orgs: readonly OrgNameEntry[]): OrgNameMap {
  const map: OrgNameMap = new Map();
  for (const org of orgs) {
    map.set(org._id, { name: org.name, slug: org.slug });
  }
  return map;
}

/**
 * Resolve an org id to a display name for tables.
 * Prefers the org name; falls back to the slug; then `—` while the
 * background org lookup is still loading the owning org.
 */
export function orgDisplayName(
  orgId: Id<"organizations">,
  map: OrgNameMap,
): string {
  const entry = map.get(orgId);
  if (entry === undefined) return "—";
  return entry.name.length > 0 ? entry.name : entry.slug;
}

export type OrgByClerkIdEntry = {
  clerkOrgId: string;
  name: string;
  slug: string;
};

export type OrgByClerkIdMap = Map<string, { name: string; slug: string }>;

/**
 * Build a clerkOrgId → `{name, slug}` lookup. Used by admin screens that
 * key off `clerkOrgId` (the auth-mirror identity) rather than the internal
 * `organizations` doc id — e.g. payout requests, which store `clerkOrgId`.
 * Later entries win (idempotent rebuild from a merged list).
 */
export function buildOrgByClerkIdMap(
  orgs: readonly OrgByClerkIdEntry[],
): OrgByClerkIdMap {
  const map: OrgByClerkIdMap = new Map();
  for (const org of orgs) {
    map.set(org.clerkOrgId, { name: org.name, slug: org.slug });
  }
  return map;
}

/**
 * Resolve a clerkOrgId to a display name for tables.
 * Prefers the org name; falls back to the slug; then `—` while the
 * background org lookup is still loading the owning org.
 */
export function orgDisplayNameByClerkId(
  clerkOrgId: string,
  map: OrgByClerkIdMap,
): string {
  const entry = map.get(clerkOrgId);
  if (entry === undefined) return "—";
  return entry.name.length > 0 ? entry.name : entry.slug;
}
