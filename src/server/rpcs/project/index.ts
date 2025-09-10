import { and, eq } from "drizzle-orm";
import z from "zod";

import { db } from "~/db";
import * as schema from "~/db/schema";
import {
  createProject,
  getProjectById,
  getProjectBySlug,
  getUserProjects,
  updateProject,
} from "~/lib/server/project-service";
import { protectedProcedure, router } from "~/server/trpc";

// Project schema for responses
const projectSchema = z.object({
  apiSpecCount: z.number(),
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  createdAt: z.date(),
  createdBy: z.string(),
  creatorName: z.string(),
  description: z.string().nullable(),
  id: z.string(),
  memberCount: z.number(),
  metadata: z.record(z.string(), z.unknown()),
  name: z.string(),
  organizationId: z.string(),
  organizationName: z.string(),
  organizationSlug: z.string(),
  settings: z.record(z.string(), z.unknown()),
  slug: z.string(),
  status: z.enum(["active", "archived", "beta", "deprecated", "inactive"]),
  updatedAt: z.date(),
  visibility: z.enum(["internal", "private", "public"]),
});

export const projectRouter = router({
  // Create new project
  create: protectedProcedure
    .meta({ route: { path: "/project/create", summary: "Create new project" } })
    .input(
      z.object({
        description: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        name: z.string().min(1, "Project name is required"),
        organizationId: z.string().min(1, "Organization ID is required"),
        settings: z.record(z.string(), z.unknown()).optional(),
        visibility: z.enum(["internal", "private", "public"]).optional(),
      }),
    )
    .output(
      z.object({
        project: projectSchema,
        success: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await createProject({
        description: input.description,
        metadata: input.metadata,
        name: input.name,
        organizationId: input.organizationId,
        settings: input.settings,
        userId: ctx.user.id,
        visibility: input.visibility,
      });

      return {
        project,
        success: true,
      };
    }),

  // Get project by ID
  getById: protectedProcedure
    .meta({ route: { path: "/project/get-by-id", summary: "Get project by ID" } })
    .input(
      z.object({
        projectId: z.string(),
      }),
    )
    .output(
      z.object({
        project: projectSchema,
      }),
    )
    .query(async ({ ctx, input }) => {
      const project = await getProjectById(input.projectId, ctx.user.id);

      return {
        project,
      };
    }),

  // Get project by slug
  getBySlug: protectedProcedure
    .meta({ route: { path: "/project/get-by-slug", summary: "Get project by slug" } })
    .input(
      z.object({
        slug: z.string(),
      }),
    )
    .output(
      z.object({
        project: projectSchema,
      }),
    )
    .query(async ({ ctx, input }) => {
      const project = await getProjectBySlug(input.slug, ctx.user.id);

      return {
        project,
      };
    }),

  // Get project members
  getMembers: protectedProcedure
    .meta({ route: { path: "/project/get-members", summary: "Get project members" } })
    .input(
      z.object({
        projectId: z.string(),
      }),
    )
    .output(
      z.object({
        members: z.array(
          z.object({
            addedBy: z.string().nullable(),
            id: z.string(),
            joinedAt: z.date(),
            permissions: z.record(z.string(), z.unknown()),
            role: z.enum(["admin", "editor", "viewer"]),
            userEmail: z.string(),
            userId: z.string(),
            userImage: z.string().nullable(),
            userName: z.string(),
          }),
        ),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Check if user has access to this project
      const projectMember = await db
        .select({ role: schema.projectMember.role })
        .from(schema.projectMember)
        .where(and(eq(schema.projectMember.projectId, input.projectId), eq(schema.projectMember.userId, ctx.user.id)))
        .limit(1);

      if (projectMember.length === 0) {
        throw new Error("Access denied: You are not a member of this project");
      }

      // Get all project members with user details
      const members = await db
        .select({
          addedBy: schema.projectMember.addedBy,
          id: schema.projectMember.id,
          joinedAt: schema.projectMember.joinedAt,
          permissions: schema.projectMember.permissions,
          role: schema.projectMember.role,
          userEmail: schema.user.email,
          userId: schema.user.id,
          userImage: schema.user.image,
          userName: schema.user.name,
        })
        .from(schema.projectMember)
        .innerJoin(schema.user, eq(schema.projectMember.userId, schema.user.id))
        .where(eq(schema.projectMember.projectId, input.projectId))
        .orderBy(schema.projectMember.joinedAt);

      return {
        members: members.map((member) => ({
          ...member,
          permissions: member.permissions as Record<string, unknown>,
        })),
      };
    }),

  // Get all user projects
  getUserProjects: protectedProcedure
    .meta({ route: { path: "/project/get-user-projects", summary: "Get all user projects" } })
    .output(
      z.object({
        projects: z.array(
          projectSchema.extend({
            organizationName: z.string(),
            userRole: z.enum(["admin", "editor", "viewer"]),
          }),
        ),
      }),
    )
    .query(async ({ ctx }) => {
      const projects = await getUserProjects(ctx.user.id);

      return {
        projects,
      };
    }),

  // Update project
  update: protectedProcedure
    .meta({ route: { path: "/project/update", summary: "Update project" } })
    .input(
      z.object({
        description: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        name: z.string().optional(),
        projectCategoryId: z.string().nullable().optional(),
        projectId: z.string(),
        settings: z.record(z.string(), z.unknown()).optional(),
        status: z.enum(["active", "archived", "beta", "deprecated", "inactive"]).optional(),
        visibility: z.enum(["internal", "private", "public"]).optional(),
      }),
    )
    .output(
      z.object({
        project: projectSchema,
        success: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await updateProject({
        description: input.description,
        metadata: input.metadata,
        name: input.name,
        projectCategoryId: input.projectCategoryId,
        projectId: input.projectId,
        settings: input.settings,
        status: input.status,
        userId: ctx.user.id,
        visibility: input.visibility,
      });

      return {
        project,
        success: true,
      };
    }),
});
