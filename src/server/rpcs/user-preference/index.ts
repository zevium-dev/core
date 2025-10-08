import z from "zod";

import { db, orm, schema } from "~/db";
import { protectedProcedure, router } from "~/server/trpc";

export const UserPreferenceZod = z.object({
  timezone: z.string().optional(),
});

export const userPreferenceRouter = router({
  get: protectedProcedure
    .meta({ route: { path: "/user-preference/get", summary: "Get current user's preferences" } })
    .output(UserPreferenceZod)
    .query(async ({ ctx }) => {
      const rows = await db
        .select({ timezone: schema.userPreference.timezone })
        .from(schema.userPreference)
        .where(orm.eq(schema.userPreference.userId, ctx.user.id))
        .limit(1);
      const row = rows.at(0);
      return { timezone: row?.timezone };
    }),
  update: protectedProcedure
    .meta({ route: { path: "/user-preference/update", summary: "Update current user's preferences" } })
    .input(UserPreferenceZod)
    .output(UserPreferenceZod)
    .mutation(async ({ ctx, input }) => {
      // Only update provided fields
      const patch: Partial<{ timezone: string }> = {};
      if (input.timezone) patch.timezone = input.timezone;
      if (Object.keys(patch).length === 0) {
        const current = await db
          .select({ timezone: schema.userPreference.timezone })
          .from(schema.userPreference)
          .where(orm.eq(schema.userPreference.userId, ctx.user.id))
          .limit(1);
        return { timezone: current.at(0)?.timezone };
      }
      const preferences = await db
        .insert(schema.userPreference)
        .values({ timezone: patch.timezone, userId: ctx.user.id })
        .onConflictDoUpdate({
          set: { ...patch },
          target: schema.userPreference.userId,
        })
        .returning();
      return {
        timezone: preferences.at(0)?.timezone,
      };
    }),
});
