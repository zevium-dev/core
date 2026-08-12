import {
  isOpenApiPublicCopyAllowed,
  isPublicCopySetAllowed,
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

function organizationCopyFields(organization: OrganizationCopy): string[] {
  return [
    organization.name,
    organization.slug,
    organization.publicHandle ?? "",
  ];
}

function projectCopyFields(project: ProjectCopy): string[] {
  return [
    project.name,
    project.slug,
    project.description ?? "",
    ...project.tags,
  ];
}

export function isOrganizationCopyAllowed(
  organization: OrganizationCopy,
): boolean {
  return isPublicCopySetAllowed(organizationCopyFields(organization));
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
  return isPublicCopySetAllowed(projectCopyFields(project));
}

export function isProjectPublicSurfaceAllowed(
  project: ProjectCopy,
  organization: OrganizationCopy,
): boolean {
  return (
    isOrganizationPublicSurfaceAllowed(organization) &&
    isProjectCopyAllowed(project) &&
    isPublicCopySetAllowed([
      ...organizationCopyFields(organization),
      ...projectCopyFields(project),
    ])
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
    isPublicCopySetAllowed([
      ...organizationCopyFields(organization),
      ...projectCopyFields(project),
      version.version,
      version.deprecationMessage ?? "",
    ]) &&
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
