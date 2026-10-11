import type { Doc } from "../_generated/dataModel";
// Explicit allowlists: project embeds secrets and organization embeds payment state.
export function organizationDto(row: Doc<"organizations">) {
  return {
    _id: row._id,
    _creationTime: row._creationTime,
    clerkOrgId: row.clerkOrgId,
    name: row.name,
    slug: row.slug,
    publicHandle: row.publicHandle,
    imageUrl: row.imageUrl,
  };
}
export function userDto(row: Doc<"users">) {
  return {
    _id: row._id,
    _creationTime: row._creationTime,
    clerkUserId: row.clerkUserId,
    name: row.name,
    email: row.email,
  };
}
export function projectDto(row: Doc<"projects">) {
  return {
    _id: row._id,
    _creationTime: row._creationTime,
    organizationId: row.organizationId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    tags: row.tags,
    status: row.status,
    visibility: row.visibility,
    desiredVisibility: row.desiredVisibility,
    qualityStatus: row.qualityStatus,
    publicationGeneration: row.publicationGeneration,
    houseOperated: row.houseOperated,
    retirementState: row.retirement?.state,
    retirementRevision: row.retirement?.revision,
    deprecationStartedAt: row.retirement?.startedAt,
    deprecationMessage: row.retirement?.message,
    sunsetAt: row.retirement?.sunsetAt,
    retiredAt: row.retirement?.retiredAt,
  };
}
export function versionDto(row: Doc<"specVersions">) {
  return {
    _id: row._id,
    _creationTime: row._creationTime,
    projectId: row.projectId,
    version: row.version,
    spec: row.spec,
    publishedAt: row.publishedAt,
    deprecatedAt: row.deprecatedAt,
    sunsetAt: row.sunsetAt,
    deprecationMessage: row.deprecationMessage,
  };
}
