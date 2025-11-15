import { ORPCMeta } from "@orpc/trpc";
import { initTRPC, TRPCError } from "@trpc/server";
import SuperJSON from "superjson";

import { db, orm, schema } from "~/db";
import { AnyUserPermission, Permissions } from "~/db/permission";

import { Context } from "./context";

export const t = initTRPC
  .context<Context>()
  .meta<{ requiredPermissions?: [AnyUserPermission, ...Array<AnyUserPermission>] } & ORPCMeta>()
  .create({ transformer: SuperJSON });
export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

// TODO: fix the waterfall cuz of sequential permission checks (1st user, 2nd org, 3rd project, etc)
// TODO: separate the routers according to the permissions defined for each level (user, org, project, etc)

export const secureProcedure = protectedProcedure.use(async ({ ctx, meta, next }) => {
  const requiredPermissions = meta?.requiredPermissions;
  if (!requiredPermissions) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "No required permissions specified" });
  }

  const userPermissions = await db
    .select()
    .from(schema.userPermission)
    .where(orm.eq(schema.userPermission.userId, ctx.user.id));

  const permissions: Permissions = {};
  for (const permission of userPermissions) {
    permissions[permission.permission] = permission.value;
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

  return next({
    ctx: {
      ...ctx,
      permissions: {
        // add any permissions from the previous context
        // ...ctx.permissions,
        ...permissions,
      },
    },
  });
});
