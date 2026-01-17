import z from "zod";

import { db, orm, schema } from "~/db";
import { secureProcedure } from "~/server/secure-procedure";
import { router } from "~/server/trpc";

export const tagRouter = router({
  popular: secureProcedure
    .meta({
      requiredPermissions: ["marketplace.view"],
      route: { path: "/tag/popular", summary: "List popular tags in public catalogue" },
    })
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(50).default(20),
        })
        .optional(),
    )
    .output(z.array(z.object({ name: z.string(), projectCount: z.number().int() })))
    .query(async ({ input }) => {
      const limit = input?.limit ?? 20;

      const whereClauses: Array<orm.SQL> = [orm.eq(schema.project.visibility, "public")];

      const rows = await db
        .select({
          name: schema.tag.name,
          projectCount: orm.count(schema.projectTag.projectId),
        })
        .from(schema.tag)
        .leftJoin(schema.projectTag, orm.eq(schema.projectTag.tagName, schema.tag.name))
        .leftJoin(schema.project, orm.eq(schema.project.id, schema.projectTag.projectId))
        .where(orm.and(...whereClauses))
        .groupBy(schema.tag.name)
        .orderBy(orm.desc(orm.count(schema.projectTag.projectId)), orm.asc(schema.tag.name))
        .limit(limit);

      return rows.map((row) => ({
        name: row.name,
        projectCount: row.projectCount,
      }));
    }),
});
