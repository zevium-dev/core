import { z } from "zod";

export const PermissionValueZod = z
  .object({ status: z.enum(["allow", "deny"]) })
  .or(
    z.object({
      limit: z.number().int().positive(),
      status: z.literal("limited"),
    }),
  )
  .or(
    z.object({
      // sliding window ratelimit
      limit: z.number().int().positive(),
      status: z.literal("ratelimit"),
      window: z.number().int().positive(), // in ms
    }),
  );
export type PermissionValue = z.infer<typeof PermissionValueZod>;

/** @deprecated Don't use this standalone (yet) */
export const ProjectUserPermissions = [
  "project.delete", // ability to delete the project
  "project.edit", // ability to edit the project details like name, description, documentation etc
  "project.view", // ability to view the project details
  "project.price.edit", // ability to edit the API pricing
  "project.publish", // ability to publish a project version to the marketplace
  "project.spec.edit", // ability to edit the project specification
  "project.spec.view", // ability to view the project specification
  "project.unpublish", // ability to unpublish a project version from the marketplace
] as const;
export type ProjectUserPermission = (typeof ProjectUserPermissions)[number];

// Organization-specific user permissions
export const OrganizationUserPermissions = [
  "organization.delete", // ability to delete the organization
  "organization.edit", // ability to edit the organization details like name, logo, slug etc
  "organization.members.invite", // ability to invite members to the organization
  "organization.members.remove", // ability to remove members from the organization
  "organization.members.view", // ability to view other members in the organization
  "organization.members.permission.edit", // ability to edit other members' permissions in the organization
  "organization.view", // ability to view the organization details
  "organization.owner.add", // ability to add owners to the organization
  "organization.owner.remove", // ability to remove owners from the organization
  "organization.owner.edit", // ability to edit owners' permissions in the organization

  //
  "project.create", // ability to create projects in the organization
  "project.list", // ability to list projects in the organization

  // default project permissions for organization users
  ...ProjectUserPermissions,
] as const;
export type OrganizationUserPermission = (typeof OrganizationUserPermissions)[number];

/** @deprecated Don't use this standalone (yet) */
export const UserPermissions = [
  "dashboard.view", // ability to view the dashboard
  "marketplace.view", // ability to view the marketplace
  "organization.create", // ability to create organizations
] as const;
export type AnyUserPermission = OrganizationUserPermission | ProjectUserPermission | UserPermission;
export type Permissions = Partial<Record<AnyUserPermission, PermissionValue>>;
export type UserPermission = (typeof UserPermissions)[number];
