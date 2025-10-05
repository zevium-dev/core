import { asc, eq } from "drizzle-orm";

import { db } from "~/db";
import * as schema from "~/db/schema";

// Type definitions
export interface ProjectCategory {
  createdAt: Date;
  description: null | string;
  icon: null | string;
  id: string;
  name: string;
  updatedAt: Date;
  weight: number;
}

/**
 * Create a new project category
 */
export async function createProjectCategory(data: {
  description?: string;
  icon?: string;
  name: string;
  weight?: number;
}): Promise<ProjectCategory> {
  try {
    const id = crypto.randomUUID();

    const [category] = await db
      .insert(schema.projectCategory)
      .values({
        createdAt: new Date(),
        description: data.description ?? null,
        icon: data.icon ?? null,
        id,
        name: data.name,
        updatedAt: new Date(),
        weight: data.weight ?? 0,
      })
      .returning();

    return {
      createdAt: category.createdAt,
      description: category.description,
      icon: category.icon,
      id: category.id,
      name: category.name,
      updatedAt: category.updatedAt,
      weight: category.weight ?? 0,
    };
  } catch (error) {
    console.error("Failed to create project category:", error);
    throw new Error("Failed to create project category");
  }
}

/**
 * Delete a project category
 */
export async function deleteProjectCategory(id: string): Promise<void> {
  try {
    // Check if any projects are using this category
    const projectsUsingCategory = await db
      .select({ id: schema.project.id })
      .from(schema.project)
      .where(eq(schema.project.projectCategoryId, id))
      .limit(1);

    if (projectsUsingCategory.length > 0) {
      throw new Error("Cannot delete category that is in use by projects");
    }

    await db.delete(schema.projectCategory).where(eq(schema.projectCategory.id, id));
  } catch (error) {
    console.error("Failed to delete project category:", error);
    throw new Error("Failed to delete project category");
  }
}

/**
 * Get all project categories ordered by weight and name
 */
export async function getProjectCategories(): Promise<Array<ProjectCategory>> {
  try {
    const categories = await db
      .select()
      .from(schema.projectCategory)
      .orderBy(asc(schema.projectCategory.weight), asc(schema.projectCategory.name));

    return categories.map((category) => ({
      createdAt: category.createdAt,
      description: category.description,
      icon: category.icon,
      id: category.id,
      name: category.name,
      updatedAt: category.updatedAt,
      weight: category.weight ?? 0,
    }));
  } catch (error) {
    console.error("Failed to fetch project categories:", error);
    throw new Error("Failed to fetch project categories");
  }
}

/**
 * Get a specific project category by ID
 */
export async function getProjectCategoryById(id: string): Promise<null | ProjectCategory> {
  try {
    const category = await db.select().from(schema.projectCategory).where(eq(schema.projectCategory.id, id)).limit(1);

    const result = category.at(0);

    if (!result) {
      return null;
    }

    return {
      createdAt: result.createdAt,
      description: result.description,
      icon: result.icon,
      id: result.id,
      name: result.name,
      updatedAt: result.updatedAt,
      weight: result.weight ?? 0,
    };
  } catch (error) {
    console.error("Failed to fetch project category:", error);
    throw new Error("Failed to fetch project category");
  }
}

/**
 * Update an existing project category
 */
export async function updateProjectCategory(
  id: string,
  data: {
    description?: string;
    icon?: string;
    name?: string;
    weight?: number;
  },
): Promise<ProjectCategory> {
  try {
    const [category] = await db
      .update(schema.projectCategory)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(schema.projectCategory.id, id))
      .returning();

    return {
      createdAt: category.createdAt,
      description: category.description,
      icon: category.icon,
      id: category.id,
      name: category.name,
      updatedAt: category.updatedAt,
      weight: category.weight ?? 0,
    };
  } catch (error) {
    console.error("Failed to update project category:", error);
    throw new Error("Failed to update project category");
  }
}
