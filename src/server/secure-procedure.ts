// TODO: fix the waterfall cuz of sequential permission checks (1st user, 2nd org, 3rd project, etc)
// TODO: separate the routers according to the permissions defined for each level (user, org, project, etc)

import { TRPCError } from "@trpc/server";
import z from "zod";

import { db, orm, schema } from "~/db";
import { OrganizationRolePermissions } from "~/db/default-roles";
import { Permissions } from "~/db/permission";

import { protectedProcedure } from "./trpc";

const OrganizationInputZod = z.object({
  organizationId: z.string().optional(),
  organizationSlug: z.string().optional(),
});
const ProjectInputZod = z.object({
  projectId: z.string().optional(),
  projectSlug: z.string().optional(),
});

const getOrganizationPermissions = async (userId: string, input: z.infer<typeof OrganizationInputZod>) => {
  if (input.organizationId && input.organizationSlug) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Only one of organizationId or organizationSlug must be provided",
    });
  }

  let organizationWhere = orm.and();
  if (input.organizationId) {
    organizationWhere = orm.eq(schema.organization.id, input.organizationId);
  } else if (input.organizationSlug) {
    organizationWhere = orm.eq(schema.organization.slug, input.organizationSlug);
  } else {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Either organizationId or organizationSlug must be provided",
    });
  }

  const row = await db
    .select({
      memberId: schema.member.id,
      organization: schema.organization,
      role: schema.member.role,
    })
    .from(schema.organization)
    .leftJoin(
      schema.member,
      orm.and(orm.eq(schema.member.organizationId, schema.organization.id), orm.eq(schema.member.userId, userId)),
    )
    .where(organizationWhere)
    .limit(1)
    .then((rows) => rows.at(0));

  if (!row?.organization) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Organization not found",
    });
  }

  if (!row.memberId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have access to this organization",
    });
  }

  if (!row.role) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Your role in this organization is invalid",
    });
  }

  const permissionRows = await db
    .select({
      permission: schema.organizationUserPermission.permission,
      value: schema.organizationUserPermission.value,
    })
    .from(schema.organizationUserPermission)
    .where(
      orm.and(
        orm.eq(schema.organizationUserPermission.userId, userId),
        orm.eq(schema.organizationUserPermission.organizationId, row.organization.id),
      ),
    );

  const permissions = OrganizationRolePermissions[row.role] ?? {};
  // override default role permissions with user-specific permissions
  for (const permissionRow of permissionRows) {
    permissions[permissionRow.permission] = permissionRow.value;
  }

  return { orgId: row.organization.id, permissions };
};

const getProjectPermissions = async (userId: string, input: z.infer<typeof ProjectInputZod>) => {
  if (input.projectId && input.projectSlug) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Only one of projectId or projectSlug must be provided",
    });
  }

  let projectWhere = orm.and();
  if (input.projectId) {
    projectWhere = orm.eq(schema.project.id, input.projectId);
  } else if (input.projectSlug) {
    projectWhere = orm.eq(schema.project.slug, input.projectSlug);
  } else {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Either projectId or projectSlug must be provided",
    });
  }

  const row = await db
    .select({
      organization: schema.organization,
      project: schema.project,
    })
    .from(schema.project)
    .leftJoin(schema.organization, orm.eq(schema.project.organizationId, schema.organization.id))
    .where(projectWhere)
    .limit(1)
    .then((rows) => rows.at(0));

  if (!row?.project || !row.organization) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Project not found",
    });
  }

  const permissionRows = await db
    .select({
      permission: schema.projectUserPermission.permission,
      value: schema.projectUserPermission.value,
    })
    .from(schema.projectUserPermission)
    .where(
      orm.and(
        orm.eq(schema.projectUserPermission.userId, userId),
        orm.eq(schema.projectUserPermission.projectId, row.project.id),
      ),
    );

  const permissions: Permissions = {};
  // override default role permissions with user-specific permissions
  for (const permissionRow of permissionRows) {
    permissions[permissionRow.permission] = permissionRow.value;
  }

  return { permissions, projectId: row.project.id };
};

export const secureProcedure = protectedProcedure
  .input(OrganizationInputZod.or(ProjectInputZod).optional())
  .use(async ({ ctx, input, meta, next }) => {
    const requiredPermissions = meta?.requiredPermissions;
    if (!requiredPermissions) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "No required permissions specified" });
    }

    const userPermissions = await db
      .select()
      .from(schema.userPermission)
      .where(orm.eq(schema.userPermission.userId, ctx.user.id));

    let permissions: Permissions = {};
    // base user permissions
    for (const permission of userPermissions) {
      permissions[permission.permission] = permission.value;
    }

    let orgId: string | undefined = undefined;
    let projectId: string | undefined = undefined;

    if (input && ("organizationId" in input || "organizationSlug" in input)) {
      const orgPermissions = await getOrganizationPermissions(ctx.user.id, input);
      // override base user permissions with organization-specific permissions
      permissions = {
        ...permissions,
        ...orgPermissions.permissions,
      };
      orgId = orgPermissions.orgId;
    }

    if (input && ("projectId" in input || "projectSlug" in input)) {
      const projectPermissions = await getProjectPermissions(ctx.user.id, input);
      // override previous permissions with project-specific permissions
      permissions = {
        ...permissions,
        ...projectPermissions.permissions,
      };
      projectId = projectPermissions.projectId;
    }

    const missingPermissions = requiredPermissions.filter((requiredPermission) => {
      // we are returning true for missing permissions
      const permission = permissions[requiredPermission];
      if (!permission) return true;
      if (permission.status === "deny") return true;
      if (permission.status === "allow") return false;
      // TODO: add handling for limited or ratelimit statuses
      return false;
    });

    if (missingPermissions.length > 0) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `You are missing the following permissions: ${missingPermissions.join(", ")}`,
      });
    }

    return next({ ctx: { ...ctx, orgId, permissions, projectId } });
  });
