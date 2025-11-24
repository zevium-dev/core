import { createId } from "@paralleldrive/cuid2";
import { TRPCError } from "@trpc/server";
import z from "zod";

import { db, orm, schema, schemaZod } from "~/db";
import { secureProcedure } from "~/server/secure-procedure";
import { router } from "~/server/trpc";

const OrganizationInputZod = z.object({
  organizationId: z.string().optional(),
  organizationSlug: z.string().optional(),
});

export const projectRouter = router({
  create: secureProcedure
    .meta({
      requiredPermissions: ["project.create"],
      route: { path: "/project/create", summary: "Create a new project" },
    })
    .input(OrganizationInputZod.and(schemaZod.ProjectSelectZod.pick({ description: true, name: true, slug: true })))
    .output(schemaZod.ProjectSelectZod)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.orgId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Organization ID not found in context",
        });
      }
      const project = await db
        .insert(schema.project)
        .values({
          description: input.description,
          id: createId(),
          metadata: {
            createdBy: ctx.user.id,
          },
          name: input.name,
          organizationId: ctx.orgId,
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

  get: secureProcedure
    .meta({
      requiredPermissions: ["project.view"],
      route: { path: "/project/get", summary: "Get a project by ID or slug" },
    })
    .input(OrganizationInputZod.and(z.object({ projectId: z.string() }).or(z.object({ projectSlug: z.string() }))))
    .output(schemaZod.ProjectSelectZod.and(z.object({ project_tags: z.array(schemaZod.ProjectTagSelectZod) })))
    .query(async ({ ctx, input }) => {
      if (!ctx.orgId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Organization ID not found in context",
        });
      }
      const whereClauses = [orm.eq(schema.project.organizationId, ctx.orgId)];
      if ("projectId" in input && input.projectId) {
        whereClauses.push(orm.eq(schema.project.id, input.projectId));
      } else if ("projectSlug" in input && input.projectSlug) {
        whereClauses.push(orm.eq(schema.project.slug, input.projectSlug));
      } else {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Either projectId or projectSlug must be provided",
        });
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

  list: secureProcedure
    .meta({
      requiredPermissions: ["project.list"],
      route: { path: "/project/list", summary: "List all projects in an organization" },
    })
    .input(OrganizationInputZod.and(z.object({ tagNames: z.array(z.string()).optional() })))
    .output(z.array(schemaZod.ProjectSelectZod.and(z.object({ project_tags: z.array(schemaZod.ProjectTagSelectZod) }))))
    .query(async ({ ctx, input }) => {
      if (!ctx.orgId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Organization ID not found in context",
        });
      }
      const where = [orm.eq(schema.project.organizationId, ctx.orgId)];
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

  update: secureProcedure
    .meta({
      requiredPermissions: ["project.edit"],
      route: { path: "/project/update", summary: "Update a project" },
    })
    .input(
      OrganizationInputZod.and(
        schemaZod.ProjectSelectZod.pick({
          description: true,
          documentation: true,
          id: true,
          name: true,
          status: true,
          visibility: true,
        }),
      ).and(
        z.object({
          tagNames: z.array(z.string()),
          variables: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
        }),
      ),
    )
    .output(schemaZod.ProjectSelectZod.and(z.object({ project_tags: z.array(schemaZod.ProjectTagSelectZod) })))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.orgId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Organization ID not found in context",
        });
      }
      const project = await db
        .update(schema.project)
        .set({
          description: input.description,
          documentation: input.documentation,
          name: input.name,
          status: input.status,
          variables: input.variables,
          visibility: input.visibility,
        })
        .where(orm.and(orm.eq(schema.project.id, input.id), orm.eq(schema.project.organizationId, ctx.orgId)))
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

  updateTags: secureProcedure
    .meta({
      requiredPermissions: ["project.edit"],
      route: { path: "/project/update-tags", summary: "Update project tags" },
    })
    .input(
      OrganizationInputZod.and(
        z.object({
          projectId: z.string(),
          tagNames: z.array(z.string()).min(1).max(100),
        }),
      ),
    )
    .output(schemaZod.ProjectSelectZod.and(z.object({ project_tags: z.array(schemaZod.ProjectTagSelectZod) })))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.orgId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Organization ID not found in context",
        });
      }
      const project = await db
        .select()
        .from(schema.project)
        .where(orm.and(orm.eq(schema.project.id, input.projectId), orm.eq(schema.project.organizationId, ctx.orgId)))
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
