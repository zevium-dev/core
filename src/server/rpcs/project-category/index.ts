import z from "zod";

import {
  createProjectCategory,
  deleteProjectCategory,
  getProjectCategories,
  getProjectCategoryById,
  updateProjectCategory,
} from "~/lib/server/project-category-service";
import { protectedProcedure, router } from "~/server/trpc";

// Project category schema for responses
const projectCategorySchema = z.object({
  createdAt: z.date(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  id: z.string(),
  name: z.string(),
  updatedAt: z.date(),
  weight: z.number(),
});

export const projectCategoryRouter = router({
  // Create new category
  create: protectedProcedure
    .meta({ route: { path: "/project-category/create", summary: "Create new project category" } })
    .input(
      z.object({
        description: z.string().optional(),
        icon: z.string().optional(),
        name: z.string().min(1, "Category name is required"),
        weight: z.number().optional(),
      }),
    )
    .output(
      z.object({
        category: projectCategorySchema,
        success: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const category = await createProjectCategory(input);
      return {
        category,
        success: true,
      };
    }),

  // Delete category
  delete: protectedProcedure
    .meta({ route: { path: "/project-category/:id/delete", summary: "Delete project category" } })
    .input(
      z.object({
        id: z.string().min(1, "Category ID is required"),
      }),
    )
    .output(
      z.object({
        success: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      await deleteProjectCategory(input.id);
      return {
        success: true,
      };
    }),

  // Get all categories
  getAll: protectedProcedure
    .meta({ route: { path: "/project-category/all", summary: "Get all project categories" } })
    .input(z.object({}))
    .output(
      z.object({
        categories: z.array(projectCategorySchema),
        success: z.boolean(),
      }),
    )
    .query(async () => {
      const categories = await getProjectCategories();
      return {
        categories,
        success: true,
      };
    }),

  // Get category by ID
  getById: protectedProcedure
    .meta({ route: { path: "/project-category/:id", summary: "Get project category by ID" } })
    .input(
      z.object({
        id: z.string().min(1, "Category ID is required"),
      }),
    )
    .output(
      z.object({
        category: projectCategorySchema.nullable(),
        success: z.boolean(),
      }),
    )
    .query(async ({ input }) => {
      const category = await getProjectCategoryById(input.id);
      return {
        category,
        success: true,
      };
    }),

  // Update category
  update: protectedProcedure
    .meta({ route: { path: "/project-category/:id/update", summary: "Update project category" } })
    .input(
      z.object({
        description: z.string().optional(),
        icon: z.string().optional(),
        id: z.string().min(1, "Category ID is required"),
        name: z.string().optional(),
        weight: z.number().optional(),
      }),
    )
    .output(
      z.object({
        category: projectCategorySchema,
        success: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...updateData } = input;
      const category = await updateProjectCategory(id, updateData);
      return {
        category,
        success: true,
      };
    }),
});
