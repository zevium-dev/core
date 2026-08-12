import {
  isOpenApiPublicCopyAllowed,
  isPublicCopyAllowed,
} from "@zevium/shared";
import type { Doc } from "../_generated/dataModel";

export const PUBLIC_COPY_ERROR =
  "Public copy contains an unsupported compliance or absolute security claim";

type OrganizationCopy = Pick<
  Doc<"organizations">,
  "name" | "slug" | "publicHandle"
>;

type ProjectCopy = Pick<
  Doc<"projects">,
  "name" | "slug" | "description" | "tags"
>;

type PublishedCopy = Pick<
  Doc<"specVersions">,
  "version" | "spec" | "deprecationMessage"
>;

export function isOrganizationCopyAllowed(
  organization: OrganizationCopy,
): boolean {
  return isPublicCopyAllowed(
    [
      organization.name,
      organization.slug,
      organization.publicHandle ?? "",
    ].join("\n"),
  );
}

export function isOrganizationPublicSurfaceAllowed(
  organization: OrganizationCopy,
): boolean {
  return (
    organization.publicHandle !== undefined &&
    organization.publicHandle !== "" &&
    isOrganizationCopyAllowed(organization)
  );
}

export function isProjectCopyAllowed(project: ProjectCopy): boolean {
  return isPublicCopyAllowed(
    [
      project.name,
      project.slug,
      project.description ?? "",
      ...project.tags,
    ].join("\n"),
  );
}

export function isProjectPublicSurfaceAllowed(
  project: ProjectCopy,
  organization: OrganizationCopy,
): boolean {
  return (
    isOrganizationPublicSurfaceAllowed(organization) &&
    isProjectCopyAllowed(project)
  );
}

export function isPublishedSurfaceAllowed(
  project: ProjectCopy,
  organization: OrganizationCopy,
  version: PublishedCopy | null,
): version is PublishedCopy {
  return (
    version !== null &&
    isProjectPublicSurfaceAllowed(project, organization) &&
    isPublicCopyAllowed(
      [version.version, version.deprecationMessage ?? ""].join("\n"),
    ) &&
    isOpenApiPublicCopyAllowed(version.spec)
  );
}

export function assertOrganizationCopyAllowed(
  organization: OrganizationCopy,
): void {
  if (!isOrganizationCopyAllowed(organization))
    throw new Error(PUBLIC_COPY_ERROR);
}

export function assertProjectCopyAllowed(project: ProjectCopy): void {
  if (!isProjectCopyAllowed(project)) throw new Error(PUBLIC_COPY_ERROR);
}
