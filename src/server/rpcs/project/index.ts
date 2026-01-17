import { createId } from "@paralleldrive/cuid2";
import { TRPCError } from "@trpc/server";
import z from "zod";

import { db, orm, schema, schemaZod } from "~/db";
import { getEmbeddings } from "~/lib/server/embeddings";
import { secureProcedure } from "~/server/secure-procedure";
import { router } from "~/server/trpc";

const OrganizationInputZod = z.object({
  organizationId: z.string().optional(),
  organizationSlug: z.string().optional(),
});

const CatalogueCursorZod = z.object({
  id: z.string(),
  updatedAt: z.date(),
});

const ProjectCatalogueItemZod = z.object({
  description: z.string().nullable(),
  id: z.string(),
  name: z.string(),
  organizationName: z.string(),
  organizationSlug: z.string(),
  slug: z.string(),
  tags: z.array(z.string()),
  updatedAt: z.date(),
});

export const projectRouter = router({
  catalogue: secureProcedure
    .meta({
      requiredPermissions: ["marketplace.view"],
      route: { path: "/project/catalogue", summary: "List public projects for catalogue" },
    })
    .input(
      z
        .object({
          cursor: CatalogueCursorZod.optional(),
          limit: z.number().int().min(1).max(60).default(24),
          q: z.string().trim().min(1).optional(),
          tag: z.string().trim().min(1).optional(),
        })
        .optional(),
    )
    .output(
      z.object({
        items: z.array(ProjectCatalogueItemZod),
        nextCursor: CatalogueCursorZod.nullable(),
      }),
    )
    .query(async ({ input }) => {
      const limit = input?.limit ?? 24;
      const q = input?.q;
      const tag = input?.tag;
      const cursor = input?.cursor;

      const escapeLikePattern = (str: string) => str.replace(/[%_\\]/g, "\\$&");
      const likeQClause = q ? orm.like(schema.project.name, `%${escapeLikePattern(q)}%`) : undefined;

      const cursorClause = cursor
        ? orm.or(
            orm.lt(schema.project.updatedAt, cursor.updatedAt),
            orm.and(orm.eq(schema.project.updatedAt, cursor.updatedAt), orm.lt(schema.project.id, cursor.id)),
          )
        : undefined;

      const baseWhere = orm.and(
        orm.eq(schema.project.visibility, "public"),
        ...(likeQClause ? [likeQClause] : []),
        ...(cursorClause ? [cursorClause] : []),
        ...(tag
          ? [
              orm.exists(
                db
                  .select({ id: orm.sql`1` })
                  .from(schema.projectTag)
                  .where(
                    orm.and(
                      orm.eq(schema.projectTag.projectId, schema.project.id),
                      orm.eq(schema.projectTag.tagName, tag),
                    ),
                  ),
              ),
            ]
          : []),
      );

      // First, get distinct projects with pagination
      const projects = await db
        .select({
          description: schema.project.description,
          id: schema.project.id,
          name: schema.project.name,
          organizationName: schema.organization.name,
          organizationSlug: schema.organization.slug,
          slug: schema.project.slug,
          updatedAt: schema.project.updatedAt,
        })
        .from(schema.project)
        .innerJoin(schema.organization, orm.eq(schema.organization.id, schema.project.organizationId))
        .where(baseWhere)
        .orderBy(orm.desc(schema.project.updatedAt), orm.desc(schema.project.id))
        .limit(limit + 1);

      const hasMore = projects.length > limit;
      const sliced = projects.slice(0, limit);

      // Fetch tags for the sliced projects
      const projectIds = sliced.map((p) => p.id);
      const tagsRows =
        projectIds.length > 0
          ? await db
              .select({
                projectId: schema.projectTag.projectId,
                tagName: schema.projectTag.tagName,
              })
              .from(schema.projectTag)
              .where(orm.inArray(schema.projectTag.projectId, projectIds))
          : [];

      const tagsByProject = new Map<string, Array<string>>();
      for (const row of tagsRows) {
        const existing = tagsByProject.get(row.projectId);
        if (existing) {
          existing.push(row.tagName);
        } else {
          tagsByProject.set(row.projectId, [row.tagName]);
        }
      }

      const items = sliced.map((p) => ({
        description: p.description,
        id: p.id,
        name: p.name,
        organizationName: p.organizationName,
        organizationSlug: p.organizationSlug,
        slug: p.slug,
        tags: tagsByProject.get(p.id) ?? [],
        updatedAt: p.updatedAt,
      }));

      const last = items.at(-1);

      return {
        items,
        nextCursor: hasMore && last ? { id: last.id, updatedAt: last.updatedAt } : null,
      };
    }),

  create: secureProcedure
    .meta({
      requiredPermissions: ["project.create"],
      route: { path: "/project/create", summary: "Create a new project" },
    })
    .input(OrganizationInputZod.and(schemaZod.ProjectSelectZod.pick({ description: true, name: true, slug: true })))
    .output(schemaZod.ProjectSelectZod)
    .mutation(async ({ ctx, input }) => {
      const orgId = ctx.orgId;
      if (!orgId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Organization ID not found in context (include organizationSlug/organizationId in input)",
        });
      }
      const text = `${input.name}.${input.description}`;
      const embedding = await getEmbeddings({ input: text });

      const project = await db.transaction(async (tx) => {
        const createdProject = await tx
          .insert(schema.project)
          .values({
            description: input.description,
            id: createId(),
            metadata: {
              createdBy: ctx.user.id,
            },
            name: input.name,
            organizationId: orgId,
            slug: input.slug,
          })
          .returning()
          .then((v) => v.at(0));

        if (!createdProject) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to create project",
          });
        }

        await tx.run(
          orm.sql`
            INSERT INTO project_embeddings (id, project_id, text, embedding, created_at, updated_at)
            VALUES (${createId()}, ${createdProject.id}, ${text}, vector32(${JSON.stringify(embedding)}), ${Date.now()}, ${Date.now()})
          `,
        );

        return createdProject;
      });

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
      const text = `${input.name}.${input.description}`;
      const embedding = await getEmbeddings({ input: text });

      const project = await db.transaction(async (tx) => {
        const updatedProject = await tx
          .update(schema.project)
          .set({
            description: input.description,
            documentation: input.documentation,
            name: input.name,
            status: input.status,
            variables: input.variables,
            visibility: input.visibility,
          })
          .where(
            orm.and(
              orm.eq(schema.project.id, input.id),
              // @ts-expect-error - Drizzle transaction type inference issue
              orm.eq(schema.project.organizationId, ctx.orgId),
            ),
          )
          .returning()
          .then((v) => v.at(0));

        if (!updatedProject) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Project not found",
          });
        }

        await tx.run(
          orm.sql`
            INSERT INTO project_embeddings (id, project_id, text, embedding, created_at, updated_at)
            VALUES (${createId()}, ${updatedProject.id}, ${text}, vector32(${JSON.stringify(embedding)}), ${Date.now()}, ${Date.now()})
          `,
        );

        return updatedProject;
      });

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
