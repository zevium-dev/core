import { Permissions } from "./permission";

export const DefaultOrganizationRoles = ["owner", "member", "developer", "admin", "guest"] as const;
export type DefaultOrganizationRole = (typeof DefaultOrganizationRoles)[number];

export const AssignableOrganizationRoles = DefaultOrganizationRoles satisfies ReadonlyArray<DefaultOrganizationRole>;
export type AssignableOrganizationRole = (typeof AssignableOrganizationRoles)[number];

const guestPermissions: Permissions = {
  "apiKey.read": { status: "allow" },
  "organization.view": { status: "allow" },
};

const memberPermissions: Permissions = {
  ...guestPermissions,
  "organization.members.view": { status: "allow" },
  "project.list": { status: "allow" },
  "project.spec.view": { status: "allow" },
  "project.view": { status: "allow" },
};

const developerPermissions: Permissions = {
  ...memberPermissions,
  "project.create": { limit: 500, status: "limited" },
  "project.edit": { status: "allow" },
  "project.price.edit": { status: "allow" },
  "project.publish": { status: "allow" },
  "project.spec.edit": { status: "allow" },
  "project.unpublish": { status: "allow" },
};

const adminPermissions: Permissions = {
  ...developerPermissions,
  "apiKey.create": { status: "allow" },
  "apiKey.delete": { status: "allow" },
  "apiKey.read": { status: "allow" },
  "apiKey.update": { status: "allow" },
  "organization.delete": { status: "allow" },
  "organization.edit": { status: "allow" },
  "organization.members.invite": { limit: 500, status: "limited" },
  "organization.members.permission.edit": { status: "allow" },
  "organization.members.remove": { status: "allow" },
  "project.delete": { status: "allow" },
};

const ownerPermissions: Permissions = {
  ...adminPermissions,
  "organization.owner.add": { status: "allow" },
  "organization.owner.edit": { status: "allow" },
  "organization.owner.remove": { status: "allow" },
};

export const OrganizationRolePermissions: Partial<Record<DefaultOrganizationRole, Permissions>> = {
  admin: adminPermissions,
  developer: developerPermissions,
  guest: guestPermissions,
  member: memberPermissions,
  owner: ownerPermissions,
};
