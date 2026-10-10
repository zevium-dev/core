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
