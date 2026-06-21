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

// Organization-specific user permissions.
export const OrganizationUserPermissions = [
  "apiKey.create",
  "apiKey.delete",
  "apiKey.read",
  "apiKey.update",
  "organization.delete",
  "organization.edit",
  "organization.members.invite",
  "organization.members.remove",
  "organization.members.view",
  "organization.members.permission.edit",
  "organization.view",
  "organization.owner.add",
  "organization.owner.remove",
  "organization.owner.edit",
  "project.create",
  "project.delete",
  "project.edit",
  "project.list",
  "project.price.edit",
  "project.publish",
  "project.spec.edit",
  "project.spec.view",
  "project.unpublish",
  "project.view",
] as const;
export type OrganizationUserPermission = (typeof OrganizationUserPermissions)[number];

/** @deprecated Don't use this standalone (yet) */
export const UserPermissions = [
  "dashboard.view", // ability to view the dashboard
  "marketplace.view", // ability to view the marketplace
  "organization.create", // ability to create organizations
  "organization.list", // ability to list organizations
] as const;
export type UserPermission = (typeof UserPermissions)[number];
export type AnyUserPermission = OrganizationUserPermission | ProjectUserPermission | UserPermission;
export type Permissions = Partial<Record<AnyUserPermission, PermissionValue>>;
