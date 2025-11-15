import { dedupeArray } from "~/lib/utils";

import type { OrganizationUserPermission } from "./permission";

export const OrganizationRoles = ["owner", "member", "developer", "admin", "guest"] as const;
export type OrganizationRole = (typeof OrganizationRoles)[number];

const guestPermissions: Array<OrganizationUserPermission> = ["organization.view"];

const memberPermissions = dedupeArray<OrganizationUserPermission>([
  ...guestPermissions,
  "organization.members.view",
  //
  "project.list",
  //
  "project.view",
  "project.spec.view",
]);

const developerPermissions = dedupeArray<OrganizationUserPermission>([
  ...memberPermissions,
  "project.create",
  //
  "project.edit",
  "project.price.edit",
  "project.publish",
  "project.spec.edit",
  "project.unpublish",
]);

const adminPermissions = dedupeArray<OrganizationUserPermission>([
  ...developerPermissions,
  "organization.delete",
  "organization.edit",
  "organization.members.invite",
  "organization.members.permission.edit",
  "organization.members.remove",
  "project.delete",
]);

const ownerPermissions = dedupeArray<OrganizationUserPermission>([
  ...adminPermissions,
  "organization.owner.add",
  "organization.owner.remove",
  "organization.owner.edit",
]);

export const OrganizationRolePermissions: Partial<Record<OrganizationRole, Array<OrganizationUserPermission>>> = {
  admin: adminPermissions,
  developer: developerPermissions,
  guest: guestPermissions,
  member: memberPermissions,
  owner: ownerPermissions,
};
