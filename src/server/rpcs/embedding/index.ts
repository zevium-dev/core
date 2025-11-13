import { TRPCError } from "@trpc/server";
import z from "zod";

import { db, orm, schema } from "~/db";
import { createProjectEmbedding, search_embeddings } from "~/lib/server/embeddings";
import { protectedProcedure, router } from "~/server/trpc";

const ProjectInputZod = z.object({ projectId: z.string() });

const projectProcedure = protectedProcedure.input(ProjectInputZod).use(async ({ ctx, input, next }) => {
  const row = await db
    .select({
      memberId: schema.member.id,
      project: schema.project,
    })
    .from(schema.project)
    .leftJoin(
      schema.member,
      orm.and(
        orm.eq(schema.member.organizationId, schema.project.organizationId),
        orm.eq(schema.member.userId, ctx.user.id),
      ),
    )
    .where(orm.eq(schema.project.id, input.projectId))
    .limit(1)
    .then((rows) => rows.at(0));

  const project = row?.project;
  if (!project) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Project not found",
    });
  }

  if (!row.memberId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have access to this project",
    });
  }

  return next({ ctx: { ...ctx, project } });
});

export const embeddingRouter = router({
  create: projectProcedure
    .meta({ route: { path: "/embedding/create", summary: "Create an embedding for a project" } })
    .input(
      ProjectInputZod.and(
        z.object({
          modelName: z.string().optional(),
          text: z.string(),
        }),
      ),
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await createProjectEmbedding(ctx.project.id, input.text, input.modelName);
      return { success: true };
    }),

  search: protectedProcedure
    .meta({ route: { path: "/embedding/search", summary: "Search embeddings" } })
    .input(
      z.object({
        modelName: z.string().optional().default("Qwen/Qwen3-Embedding-8B"),
        text: z.string(),
        topK: z.number().optional().default(3),
      }),
    )
    .output(
      z.array(
        z.object({
          project_id: z.string(),
          schema: z.string().nullable(),
          text: z.string(),
        }),
      ),
    )
    .query(async ({ input }) => {
      const results = await search_embeddings({
        modelName: input.modelName,
        text: input.text,
        topK: input.topK,
      });

      return results.map((row) => ({
        project_id: row.project_id as string,
        schema: row.schema as null | string,
        text: row.text as string,
      }));
    }),
});
