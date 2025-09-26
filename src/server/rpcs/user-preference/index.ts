import { eq } from "drizzle-orm";
import z from "zod";

import { db } from "~/db";
import * as schema from "~/db/schema";
import { protectedProcedure, router } from "~/server/trpc";

// Base preference schema (extend later as you add columns)
export const userPreferenceSchema = z.object({
  timezone: z.string(),
});

export const userPreferenceRouter = router({ 
  get: protectedProcedure
    .meta({ route: { path: "/user-preference/get", summary: "Get current user's preferences" } })
    .output(userPreferenceSchema)
    .query(async ({ ctx }) => {
      const rows = await db
        .select({ timezone: schema.userPreference.timezone })
        .from(schema.userPreference)
        .where(eq(schema.userPreference.userId, ctx.user.id))
        .limit(1);
      const row = rows[0];
      return { timezone: row.timezone };
    }),
  update: protectedProcedure
    .meta({ route: { path: "/user-preference/update", summary: "Update current user's preferences" } })
    .input(
      z.object({
        timezone: z.string().min(1).optional(),
      }),
    )
    .output(userPreferenceSchema)
    .mutation(async ({ ctx, input }) => {
      // Only update provided fields
      const patch: Partial<{ timezone: string }> = {};
      if (input.timezone) patch.timezone = input.timezone;
      if (Object.keys(patch).length === 0) {
        const current = await db
          .select({ timezone: schema.userPreference.timezone })
          .from(schema.userPreference)
          .where(eq(schema.userPreference.userId, ctx.user.id))
          .limit(1);
        return { timezone: current[0].timezone };
      }
      await db
        .insert(schema.userPreference)
        .values({ timezone: patch.timezone, userId: ctx.user.id })
        .onConflictDoUpdate({
          set: { ...patch },
          target: schema.userPreference.userId,
        });
      return { timezone: patch.timezone ?? (await db
        .select({ timezone: schema.userPreference.timezone })
        .from(schema.userPreference)
        .where(eq(schema.userPreference.userId, ctx.user.id))
        .limit(1))[0].timezone };
    }),
});
