import { createId } from "@paralleldrive/cuid2";
import { TRPCError } from "@trpc/server";
import z from "zod";

import { db, orm, schema, schemaZod } from "~/db";
import { protectedProcedure, router } from "~/server/trpc";

const verifyOrgAccess = async (userId: string, organizationId: string) => {
  const membership = await db
    .select()
    .from(schema.member)
    .where(orm.and(orm.eq(schema.member.userId, userId), orm.eq(schema.member.organizationId, organizationId)))
    .limit(1);
  if (membership.length === 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have access to this organization",
    });
  }
};

export const projectRouter = router({
  create: protectedProcedure
    .meta({ route: { path: "/project/create", summary: "Create a new project" } })
    .input(schemaZod.ProjectZod.pick({ description: true, name: true, organizationId: true, slug: true }))
    .output(schemaZod.ProjectZod)
    .mutation(async ({ ctx, input }) => {
      await verifyOrgAccess(ctx.user.id, input.organizationId);
      const project = await db
        .insert(schema.project)
        .values({
          description: input.description,
          id: createId(),
          metadata: {
            createdBy: ctx.user.id,
          },
          name: input.name,
          organizationId: input.organizationId,
          slug: input.slug,
        })
        .returning()
        .then((v) => v.at(0));
      if (!project) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create project",
        });
      }
      return project;
    }),

  get: protectedProcedure
    .meta({ route: { path: "/project/get", summary: "Get a project by ID or slug" } })
    .input(
      z
        .object({ organizationId: z.string() })
        .and(z.object({ projectId: z.string() }).or(z.object({ projectSlug: z.string() }))),
    )
    .output(schemaZod.ProjectZod.and(z.object({ project_tags: z.array(schemaZod.ProjectTagZod) })))
    .query(async ({ ctx, input }) => {
      await verifyOrgAccess(ctx.user.id, input.organizationId);
      const whereClauses = [orm.eq(schema.project.organizationId, input.organizationId)];
      if ("projectId" in input) {
        whereClauses.push(orm.eq(schema.project.id, input.projectId));
      } else {
        whereClauses.push(orm.eq(schema.project.slug, input.projectSlug));
      }
      const projectsWithTags = await db
        .select()
        .from(schema.project)
        .where(orm.and(...whereClauses))
        .leftJoin(schema.projectTag, orm.eq(schema.project.id, schema.projectTag.projectId))
        .limit(1);
      const preResult = projectsWithTags.map((row) => ({
        ...row.project,
        project_tags: [row.project_tag].filter(Boolean),
      }));
      const projectWithTags = preResult.at(0);
      if (!projectWithTags) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }
      return projectWithTags;
    }),

  list: protectedProcedure
    .meta({ route: { path: "/project/list", summary: "List all projects in an organization" } })
    .input(
      schemaZod.ProjectZod.pick({ organizationId: true }).and(z.object({ tagNames: z.array(z.string()).optional() })),
    )
    .output(z.array(schemaZod.ProjectZod.and(z.object({ project_tags: z.array(schemaZod.ProjectTagZod) }))))
    .query(async ({ ctx, input }) => {
      await verifyOrgAccess(ctx.user.id, input.organizationId);

      const where = [orm.eq(schema.project.organizationId, input.organizationId)];
      if (input.tagNames && input.tagNames.length > 0) {
        where.push(orm.inArray(schema.projectTag.tagName, input.tagNames));
      }

      const projectsWithTags = await db
        .select()
        .from(schema.project)
        .leftJoin(schema.projectTag, orm.eq(schema.project.id, schema.projectTag.projectId))
        .where(orm.and(...where));

      const preResult = projectsWithTags.map((row) => ({
        ...row.project,
        project_tags: [row.project_tag].filter(Boolean),
      }));

      const result = preResult.reduce<Array<(typeof preResult)[number]>>((acc, curr) => {
        const existing = acc.findLast((p) => p.id === curr.id);
        if (existing) {
          for (const tag of curr.project_tags) {
            if (!existing.project_tags.find((t) => t.id === tag.id)) existing.project_tags.push(tag);
          }
        } else {
          acc.push(curr);
        }
        return acc;
      }, []);

      return result;
    }),

  update: protectedProcedure
    .meta({ route: { path: "/project/update", summary: "Update a project" } })
    .input(
      schemaZod.ProjectZod.pick({
        description: true,
        documentation: true,
        id: true,
        name: true,
        organizationId: true,
        status: true,
        visibility: true,
      }).and(z.object({ tagNames: z.array(z.string()) })),
    )
    .output(schemaZod.ProjectZod.and(z.object({ project_tags: z.array(schemaZod.ProjectTagZod) })))
    .mutation(async ({ ctx, input }) => {
      await verifyOrgAccess(ctx.user.id, input.organizationId);
      const project = await db
        .update(schema.project)
        .set({
          description: input.description,
          documentation: input.documentation,
          name: input.name,
          status: input.status,
          visibility: input.visibility,
        })
        .where(
          orm.and(orm.eq(schema.project.id, input.id), orm.eq(schema.project.organizationId, input.organizationId)),
        )
        .returning()
        .then((v) => v.at(0));
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }
      const project_tags = await db
        .select()
        .from(schema.projectTag)
        .where(orm.eq(schema.projectTag.projectId, project.id));
      return {
        ...project,
        project_tags,
      };
    }),

  updateTags: protectedProcedure
    .meta({ route: { path: "/project/update-tags", summary: "Update project tags" } })
    .input(
      z.object({
        organizationId: z.string(),
        projectId: z.string(),
        tagNames: z.array(z.string()).min(1).max(100),
      }),
    )
    .output(schemaZod.ProjectZod.and(z.object({ project_tags: z.array(schemaZod.ProjectTagZod) })))
    .mutation(async ({ ctx, input }) => {
      await verifyOrgAccess(ctx.user.id, input.organizationId);
      const project = await db
        .select()
        .from(schema.project)
        .where(
          orm.and(
            orm.eq(schema.project.id, input.projectId),
            orm.eq(schema.project.organizationId, input.organizationId),
          ),
        )
        .limit(1)
        .then((v) => v.at(0));
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }
      // TODO: maybe a better logic here?
      await db.delete(schema.projectTag).where(orm.eq(schema.projectTag.projectId, project.id));
      const projectTags = input.tagNames.map((tagName) =>
        db
          .insert(schema.projectTag)
          .values({ id: createId(), projectId: project.id, tagName })
          .returning()
          .then((v) => v.at(0)),
      );
      const insertedTags = await Promise.all(projectTags);
      return {
        ...project,
        project_tags: insertedTags.filter(Boolean),
      };
    }),
});
