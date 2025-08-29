import { ORPCMeta } from "@orpc/trpc";
import { initTRPC, TRPCError } from "@trpc/server";
import SuperJSON from "superjson";

import { Context } from "./context";

export const t = initTRPC.context<Context>().meta<ORPCMeta>().create({ transformer: SuperJSON });
export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});
