import { and, count, desc, eq, inArray } from "drizzle-orm";

import { db } from "~/db";
import * as schema from "~/db/schema";

export interface CreateProjectOptions {
  description?: string;
  metadata?: Record<string, unknown>;
  name: string;
  organizationId: string;
  settings?: Record<string, unknown>;
  userId: string;
  visibility?: "internal" | "private" | "public";
}

export interface UpdateProjectOptions {
  description?: string;
  metadata?: Record<string, unknown>;
  name?: string;
  projectId: string;
  settings?: Record<string, unknown>;
  status?: "active" | "archived" | "beta" | "deprecated" | "inactive";
  userId: string;
  visibility?: "internal" | "private" | "public";
}

/**
 * Creates a new project
 */
export async function createProject({
  description,
  metadata = {},
  name,
  organizationId,
  settings = {},
  userId,
  visibility = "private",
}: CreateProjectOptions) {
  // Check if user is a member of the organization
  const membership = await db
    .select({ role: schema.organizationMember.role })
    .from(schema.organizationMember)
    .where(
      and(
        eq(schema.organizationMember.organizationId, organizationId),
        eq(schema.organizationMember.userId, userId)
      )
    )
    .limit(1);

  if (membership.length === 0) {
    throw new Error("Access denied: You are not a member of this organization");
  }

  // Check if the user has permission to create projects
  const userRole = membership[0]?.role;
  if (userRole === "member") {
    throw new Error("Access denied: You don't have permission to create projects");
  }

  // Generate project ID and slug
  const projectId = crypto.randomUUID();
  const slug = generateProjectSlug(name);

  // Check if slug already exists in this organization
  const existingProject = await db
    .select({ id: schema.project.id })
    .from(schema.project)
    .where(
      and(
        eq(schema.project.organizationId, organizationId),
        eq(schema.project.slug, slug)
      )
    )
    .limit(1);

  if (existingProject.length > 0) {
    throw new Error("A project with this name already exists in the organization");
  }

  // Create the project
  await db
    .insert(schema.project)
    .values({
      createdAt: new Date(),
      createdBy: userId,
      description,
      id: projectId,
      metadata,
      name,
      organizationId,
      settings,
      slug,
      status: "active",
      updatedAt: new Date(),
      visibility,
    });

  // Add the creator as an admin member of the project
  await db.insert(schema.projectMember).values({
    addedBy: userId,
    id: crypto.randomUUID(),
    joinedAt: new Date(),
    permissions: {
      canDeleteProject: true,
      canEditSpecs: true,
      canManageMembers: true,
      canManageSettings: true,
      canUploadSpecs: true,
    },
    projectId: projectId,
    role: "admin",
    userId: userId,
  });

  // Get the created project with creator info, organization details, and statistics
  const createdProject = await db
    .select({
      createdAt: schema.project.createdAt,
      createdBy: schema.project.createdBy,
      creatorName: schema.user.name,
      description: schema.project.description,
      id: schema.project.id,
      metadata: schema.project.metadata,
      name: schema.project.name,
      organizationId: schema.project.organizationId,
      organizationName: schema.organization.name,
      organizationSlug: schema.organization.slug,
      settings: schema.project.settings,
      slug: schema.project.slug,
      status: schema.project.status,
      updatedAt: schema.project.updatedAt,
      visibility: schema.project.visibility,
    })
    .from(schema.project)
    .innerJoin(schema.user, eq(schema.project.createdBy, schema.user.id))
    .innerJoin(schema.organization, eq(schema.project.organizationId, schema.organization.id))
    .where(eq(schema.project.id, projectId))
    .limit(1);

  const result = createdProject[0];

  // Get project statistics (for new project, these will be 0)
  const [memberCountResult, apiSpecCountResult] = await Promise.all([
    db
      .select({ count: count() })
      .from(schema.projectMember)
      .where(eq(schema.projectMember.projectId, projectId)),
    db
      .select({ count: count() })
      .from(schema.apiSpec)
      .where(eq(schema.apiSpec.projectId, projectId))
  ]);

  return {
    ...result,
    apiSpecCount: apiSpecCountResult[0]?.count ?? 0,
    memberCount: memberCountResult[0]?.count ?? 0,
    metadata: result.metadata as Record<string, unknown>,
    settings: result.settings as Record<string, unknown>,
  };
}

/**
 * Gets a project by ID with creator info, organization details, and statistics
 */
export async function getProjectById(projectId: string, userId: string) {
  // Check if user has access to this project
  const projectMember = await db
    .select({ role: schema.projectMember.role })
    .from(schema.projectMember)
    .where(
      and(
        eq(schema.projectMember.projectId, projectId),
        eq(schema.projectMember.userId, userId)
      )
    )
    .limit(1);

  if (projectMember.length === 0) {
    throw new Error("Access denied: You don't have access to this project");
  }

  const projects = await db
    .select({
      createdAt: schema.project.createdAt,
      createdBy: schema.project.createdBy,
      creatorName: schema.user.name,
      description: schema.project.description,
      id: schema.project.id,
      metadata: schema.project.metadata,
      name: schema.project.name,
      organizationId: schema.project.organizationId,
      organizationName: schema.organization.name,
      organizationSlug: schema.organization.slug,
      settings: schema.project.settings,
      slug: schema.project.slug,
      status: schema.project.status,
      updatedAt: schema.project.updatedAt,
      visibility: schema.project.visibility,
    })
    .from(schema.project)
    .innerJoin(schema.user, eq(schema.project.createdBy, schema.user.id))
    .innerJoin(schema.organization, eq(schema.project.organizationId, schema.organization.id))
    .where(eq(schema.project.id, projectId))
    .limit(1);

  if (projects.length === 0) {
    throw new Error("Project not found");
  }

  const project = projects[0];

  // Get project statistics
  const [memberCountResult, apiSpecCountResult] = await Promise.all([
    db
      .select({ count: count() })
      .from(schema.projectMember)
      .where(eq(schema.projectMember.projectId, project.id)),
    db
      .select({ count: count() })
      .from(schema.apiSpec)
      .where(eq(schema.apiSpec.projectId, project.id))
  ]);

  return {
    ...project,
    apiSpecCount: apiSpecCountResult[0]?.count ?? 0,
    memberCount: memberCountResult[0]?.count ?? 0,
    metadata: project.metadata as Record<string, unknown>,
    settings: project.settings as Record<string, unknown>,
  };
}

/**
 * Gets a project by slug with creator info, organization details, and statistics
 */
export async function getProjectBySlug(slug: string, userId: string) {
  // First find the project by slug with organization and creator info
  const projects = await db
    .select({
      createdAt: schema.project.createdAt,
      createdBy: schema.project.createdBy,
      creatorName: schema.user.name,
      description: schema.project.description,
      id: schema.project.id,
      metadata: schema.project.metadata,
      name: schema.project.name,
      organizationId: schema.project.organizationId,
      organizationName: schema.organization.name,
      organizationSlug: schema.organization.slug,
      settings: schema.project.settings,
      slug: schema.project.slug,
      status: schema.project.status,
      updatedAt: schema.project.updatedAt,
      visibility: schema.project.visibility,
    })
    .from(schema.project)
    .innerJoin(schema.user, eq(schema.project.createdBy, schema.user.id))
    .innerJoin(schema.organization, eq(schema.project.organizationId, schema.organization.id))
    .where(eq(schema.project.slug, slug))
    .limit(1);

  if (projects.length === 0) {
    throw new Error("Project not found");
  }

  const project = projects[0];

  // Check if user has access to this project
  const projectMember = await db
    .select({ role: schema.projectMember.role })
    .from(schema.projectMember)
    .where(
      and(
        eq(schema.projectMember.projectId, project.id),
        eq(schema.projectMember.userId, userId)
      )
    )
    .limit(1);

  if (projectMember.length === 0) {
    throw new Error("Access denied: You don't have access to this project");
  }

  // Get project statistics
  const [memberCountResult, apiSpecCountResult] = await Promise.all([
    db
      .select({ count: count() })
      .from(schema.projectMember)
      .where(eq(schema.projectMember.projectId, project.id)),
    db
      .select({ count: count() })
      .from(schema.apiSpec)
      .where(eq(schema.apiSpec.projectId, project.id))
  ]);

  return {
    ...project,
    apiSpecCount: apiSpecCountResult[0]?.count ?? 0,
    memberCount: memberCountResult[0]?.count ?? 0,
    metadata: project.metadata as Record<string, unknown>,
    settings: project.settings as Record<string, unknown>,
  };
}

/**
 * Gets projects for a user across all organizations
 */
export async function getUserProjects(userId: string) {
  const projects = await db
    .select({
      createdAt: schema.project.createdAt,
      createdBy: schema.project.createdBy,
      creatorName: schema.user.name,
      description: schema.project.description,
      id: schema.project.id,
      metadata: schema.project.metadata,
      name: schema.project.name,
      organizationId: schema.project.organizationId,
      organizationName: schema.organization.name,
      organizationSlug: schema.organization.slug,
      settings: schema.project.settings,
      slug: schema.project.slug,
      status: schema.project.status,
      updatedAt: schema.project.updatedAt,
      userRole: schema.projectMember.role,
      visibility: schema.project.visibility,
    })
    .from(schema.project)
    .innerJoin(schema.user, eq(schema.project.createdBy, schema.user.id))
    .innerJoin(schema.organization, eq(schema.project.organizationId, schema.organization.id))
    .innerJoin(schema.projectMember, eq(schema.project.id, schema.projectMember.projectId))
    .where(eq(schema.projectMember.userId, userId))
    .orderBy(desc(schema.project.updatedAt));

  // Get statistics for all projects at once
  const projectIds = projects.map(p => p.id);
  
  if (projectIds.length === 0) {
    return [];
  }
  
  const [memberCounts, apiSpecCounts] = await Promise.all([
    db
      .select({ 
        count: count(),
        projectId: schema.projectMember.projectId
      })
      .from(schema.projectMember)
      .where(inArray(schema.projectMember.projectId, projectIds))
      .groupBy(schema.projectMember.projectId),
    db
      .select({ 
        count: count(),
        projectId: schema.apiSpec.projectId
      })
      .from(schema.apiSpec)
      .where(inArray(schema.apiSpec.projectId, projectIds))
      .groupBy(schema.apiSpec.projectId)
  ]);

  // Create lookup maps for counts
  const memberCountMap = new Map(memberCounts.map(m => [m.projectId, m.count]));
  const apiSpecCountMap = new Map(apiSpecCounts.map(a => [a.projectId, a.count]));

  return projects.map(project => ({
    ...project,
    apiSpecCount: apiSpecCountMap.get(project.id) ?? 0,
    memberCount: memberCountMap.get(project.id) ?? 0,
    metadata: project.metadata as Record<string, unknown>,
    settings: project.settings as Record<string, unknown>,
  }));
}

/**
 * Updates an existing project
 */
export async function updateProject({
  description,
  metadata,
  name,
  projectId,
  settings,
  status,
  userId,
  visibility,
}: UpdateProjectOptions) {
  // Check if user has permission to edit this project
  const projectMember = await db
    .select({ 
      permissions: schema.projectMember.permissions,
      role: schema.projectMember.role, 
    })
    .from(schema.projectMember)
    .where(
      and(
        eq(schema.projectMember.projectId, projectId),
        eq(schema.projectMember.userId, userId)
      )
    )
    .limit(1);

  if (projectMember.length === 0) {
    throw new Error("Access denied: You are not a member of this project");
  }

  const userRole = projectMember[0]?.role;
  if (userRole === "viewer") {
    throw new Error("Access denied: You don't have permission to edit this project");
  }

  // Prepare update data
  const updateData: Partial<typeof schema.project.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (status !== undefined) updateData.status = status;
  if (visibility !== undefined) updateData.visibility = visibility;
  if (metadata !== undefined) updateData.metadata = metadata;
  if (settings !== undefined) updateData.settings = settings;

  // Update the project
  await db
    .update(schema.project)
    .set(updateData)
    .where(eq(schema.project.id, projectId));

  // Get the updated project with creator info, organization details, and statistics
  const projectWithCreator = await db
    .select({
      createdAt: schema.project.createdAt,
      createdBy: schema.project.createdBy,
      creatorName: schema.user.name,
      description: schema.project.description,
      id: schema.project.id,
      metadata: schema.project.metadata,
      name: schema.project.name,
      organizationId: schema.project.organizationId,
      organizationName: schema.organization.name,
      organizationSlug: schema.organization.slug,
      settings: schema.project.settings,
      slug: schema.project.slug,
      status: schema.project.status,
      updatedAt: schema.project.updatedAt,
      visibility: schema.project.visibility,
    })
    .from(schema.project)
    .innerJoin(schema.user, eq(schema.project.createdBy, schema.user.id))
    .innerJoin(schema.organization, eq(schema.project.organizationId, schema.organization.id))
    .where(eq(schema.project.id, projectId))
    .limit(1);

  if (projectWithCreator.length === 0) {
    throw new Error("Project not found after update");
  }

  const result = projectWithCreator[0];

  // Get project statistics
  const [memberCountResult, apiSpecCountResult] = await Promise.all([
    db
      .select({ count: count() })
      .from(schema.projectMember)
      .where(eq(schema.projectMember.projectId, projectId)),
    db
      .select({ count: count() })
      .from(schema.apiSpec)
      .where(eq(schema.apiSpec.projectId, projectId))
  ]);

  return {
    ...result,
    apiSpecCount: apiSpecCountResult[0]?.count ?? 0,
    memberCount: memberCountResult[0]?.count ?? 0,
    metadata: result.metadata as Record<string, unknown>,
    settings: result.settings as Record<string, unknown>,
  };
}

/**
 * Generates a URL-friendly slug from project name
 */
function generateProjectSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
}
