import type { Doc } from "../_generated/dataModel";

type OrganizationSurface = Pick<Doc<"organizations">, "publicHandle">;

/** A publisher is publicly addressable only once it has a public handle. */
export function isOrganizationPublicSurfaceAllowed(
  organization: OrganizationSurface,
): boolean {
  return (
    organization.publicHandle !== undefined && organization.publicHandle !== ""
  );
}

/** A listing is public when its publisher is addressable and a version is published. */
export function isPublishedSurfaceAllowed<V>(
  organization: OrganizationSurface,
  version: V | null,
): version is V {
  return version !== null && isOrganizationPublicSurfaceAllowed(organization);
}
