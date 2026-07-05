import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";

// Define the access control statement set. We copy arrays to mutable lists to
// satisfy Better Auth's Subset typing (it expects non-readonly arrays).
const statement = {
  ac: [...defaultStatements.ac],
  apiKey: ["create", "read", "update", "delete"],
  invitation: [...defaultStatements.invitation],
  member: [...defaultStatements.member],
  organization: [...defaultStatements.organization],
  team: [...defaultStatements.team],
};

export const ac = createAccessControl(statement);

// Role catalog aligned with our DB enum (owner, admin, member, developer, guest).
// We keep the semantics simple and conservative: owners/admins get full access;
// developer/member can create invitations/teams; guest is read-only.
export const owner = ac.newRole(statement);
export const admin = ac.newRole(statement);
export const developer = ac.newRole({
  apiKey: ["read"],
  invitation: ["create", "cancel"],
  team: ["create", "update"],
});
export const member = ac.newRole({
  apiKey: ["read"],
  invitation: ["create", "cancel"],
});
export const guest = ac.newRole({
  apiKey: ["read"],
});

export const roles = {
  admin,
  developer,
  guest,
  member,
  owner,
};
