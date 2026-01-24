import { ORPCMeta } from "@orpc/trpc";
import { initTRPC, TRPCError } from "@trpc/server";
import { waitUntil } from "cloudflare:workers";
import SuperJSON from "superjson";

import { AnyUserPermission } from "~/db/permission";
import { createPostHogClient } from "~/lib/server/posthog";

import { Context } from "./context";

export const t = initTRPC
  .context<Context>()
  .meta<{ requiredPermissions?: [AnyUserPermission, ...Array<AnyUserPermission>] } & ORPCMeta>()
  .create({ transformer: SuperJSON });
export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  const posthog = createPostHogClient();
  posthog?.identify({
    distinctId: ctx.user.id,
    properties: {
      avatar: ctx.user.image,
      email: ctx.user.email,
      name: ctx.user.name,
    },
  });
  const response = await next({ ctx: { ...ctx, posthog, user: ctx.user } });
  waitUntil(posthog?.shutdown() ?? Promise.resolve());
  return response;
});
