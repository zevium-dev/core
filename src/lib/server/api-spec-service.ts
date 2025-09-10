import { and, eq } from "drizzle-orm";

import { db } from "~/db";
import * as schema from "~/db/schema";

import { extractEndpoints, type ParsedOpenApiSpec } from "./openapi-validator";

export interface CreateApiSpecOptions {
  parsedSpec: ParsedOpenApiSpec;
  projectId: string;
  userId: string;
  versionLabel?: string;
}

export interface UpdateApiSpecOptions {
  parsedSpec: ParsedOpenApiSpec;
  specId: string;
  userId: string;
  versionLabel?: string;
}

/**
 * Creates a new API specification and its endpoints
 */
export async function createApiSpec({
  parsedSpec,
  projectId,
  userId,
  versionLabel,
}: CreateApiSpecOptions) {
  // Check if user has access to the project
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

  // Check if user has permission to upload specs
  const userRole = projectMember[0]?.role;
  if (userRole === "viewer") {
    throw new Error("Access denied: You don't have permission to upload specifications");
  }

  // Check if a spec with the same hash already exists for this project
  const existingSpec = await db
    .select({ id: schema.apiSpec.id })
    .from(schema.apiSpec)
    .where(
      and(
        eq(schema.apiSpec.projectId, projectId),
        eq(schema.apiSpec.hash, parsedSpec.hash)
      )
    )
    .limit(1);

  if (existingSpec.length > 0) {
    throw new Error("This OpenAPI specification already exists for this project");
  }

  // Generate spec ID
  const specId = crypto.randomUUID();
  const finalVersionLabel = versionLabel ?? parsedSpec.version;

  // Check if version label is unique within the project
  const existingVersion = await db
    .select({ id: schema.apiSpec.id })
    .from(schema.apiSpec)
    .where(
      and(
        eq(schema.apiSpec.projectId, projectId),
        eq(schema.apiSpec.versionLabel, finalVersionLabel)
      )
    )
    .limit(1);

  if (existingVersion.length > 0) {
    throw new Error(`Version label "${finalVersionLabel}" already exists for this project`);
  }

  // Create the API specification
  await db
    .insert(schema.apiSpec)
    .values({
      createdAt: new Date(),
      format: parsedSpec.format,
      hash: parsedSpec.hash,
      id: specId,
      originalRaw: parsedSpec.originalRaw,
      projectId,
      specJson: parsedSpec.specJson,
      status: "active",
      title: parsedSpec.title,
      updatedAt: new Date(),
      versionLabel: finalVersionLabel,
    });

  // Extract and create endpoints
  const endpoints = extractEndpoints(parsedSpec.specJson);
  
  if (endpoints.length > 0) {
    const endpointInserts = endpoints.map(endpoint => ({
      createdAt: new Date(),
      deprecated: endpoint.deprecated,
      id: crypto.randomUUID(),
      method: endpoint.method,
      operationId: endpoint.operationId,
      path: endpoint.path,
      security: endpoint.security,
      specId: specId,
      summary: endpoint.summary,
      tags: endpoint.tags,
    }));

    await db.insert(schema.apiEndpoint).values(endpointInserts);
  }

  // Get the created spec with project info
  const createdSpec = await db
    .select({
      createdAt: schema.apiSpec.createdAt,
      format: schema.apiSpec.format,
      hash: schema.apiSpec.hash,
      id: schema.apiSpec.id,
      originalRaw: schema.apiSpec.originalRaw,
      projectId: schema.apiSpec.projectId,
      projectName: schema.project.name,
      specJson: schema.apiSpec.specJson,
      status: schema.apiSpec.status,
      title: schema.apiSpec.title,
      updatedAt: schema.apiSpec.updatedAt,
      versionLabel: schema.apiSpec.versionLabel,
    })
    .from(schema.apiSpec)
    .innerJoin(schema.project, eq(schema.apiSpec.projectId, schema.project.id))
    .where(eq(schema.apiSpec.id, specId))
    .limit(1);

  const result = createdSpec[0];

  return {
    ...result,
    endpointCount: endpoints.length,
    specJson: result.specJson as Record<string, unknown>,
  };
}

/**
 * Gets an API specification by ID
 */
export async function getApiSpecById(specId: string, userId: string) {
  // Get spec with project info
  const spec = await db
    .select({
      createdAt: schema.apiSpec.createdAt,
      format: schema.apiSpec.format,
      hash: schema.apiSpec.hash,
      id: schema.apiSpec.id,
      originalRaw: schema.apiSpec.originalRaw,
      projectId: schema.apiSpec.projectId,
      projectName: schema.project.name,
      specJson: schema.apiSpec.specJson,
      status: schema.apiSpec.status,
      title: schema.apiSpec.title,
      updatedAt: schema.apiSpec.updatedAt,
      versionLabel: schema.apiSpec.versionLabel,
    })
    .from(schema.apiSpec)
    .innerJoin(schema.project, eq(schema.apiSpec.projectId, schema.project.id))
    .where(eq(schema.apiSpec.id, specId))
    .limit(1);

  if (spec.length === 0) {
    throw new Error("API specification not found");
  }

  // Check if user has access to the project
  const projectMember = await db
    .select({ role: schema.projectMember.role })
    .from(schema.projectMember)
    .where(
      and(
        eq(schema.projectMember.projectId, spec[0]?.projectId || ""),
        eq(schema.projectMember.userId, userId)
      )
    )
    .limit(1);

  if (projectMember.length === 0) {
    throw new Error("Access denied: You don't have access to this project");
  }

  // Get endpoints for this spec
  const endpoints = await db
    .select({
      createdAt: schema.apiEndpoint.createdAt,
      deprecated: schema.apiEndpoint.deprecated,
      id: schema.apiEndpoint.id,
      method: schema.apiEndpoint.method,
      operationId: schema.apiEndpoint.operationId,
      path: schema.apiEndpoint.path,
      security: schema.apiEndpoint.security,
      summary: schema.apiEndpoint.summary,
      tags: schema.apiEndpoint.tags,
    })
    .from(schema.apiEndpoint)
    .where(eq(schema.apiEndpoint.specId, specId));

  const result = spec[0];

  return {
    ...result,
    endpoints: endpoints.map(endpoint => ({
      ...endpoint,
      security: endpoint.security as Array<unknown>,
      tags: endpoint.tags as Array<string>,
    })),
    specJson: result.specJson as Record<string, unknown>,
  };
}

/**
 * Gets all API specifications for a project
 */
export async function getProjectApiSpecs(projectId: string, userId: string) {
  // Check if user has access to the project
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

  // Get all specs for the project
  const specs = await db
    .select({
      createdAt: schema.apiSpec.createdAt,
      format: schema.apiSpec.format,
      hash: schema.apiSpec.hash,
      id: schema.apiSpec.id,
      status: schema.apiSpec.status,
      title: schema.apiSpec.title,
      updatedAt: schema.apiSpec.updatedAt,
      versionLabel: schema.apiSpec.versionLabel,
    })
    .from(schema.apiSpec)
    .where(eq(schema.apiSpec.projectId, projectId))
    .orderBy(schema.apiSpec.createdAt);

  // Get endpoint counts for each spec
  const specsWithCounts = await Promise.all(
    specs.map(async (spec) => {
      const endpoints = await db
        .select()
        .from(schema.apiEndpoint)
        .where(eq(schema.apiEndpoint.specId, spec.id));

      return {
        ...spec,
        endpointCount: endpoints.length,
      };
    })
  );

  return specsWithCounts;
}

/**
 * Updates an API specification status
 */
export async function updateApiSpecStatus(
  specId: string,
  status: "active" | "archived" | "deprecated",
  userId: string
) {
  // Get spec info to check project access
  const spec = await db
    .select({
      id: schema.apiSpec.id,
      projectId: schema.apiSpec.projectId,
    })
    .from(schema.apiSpec)
    .where(eq(schema.apiSpec.id, specId))
    .limit(1);

  if (spec.length === 0) {
    throw new Error("API specification not found");
  }

  // Check if user has access to the project
  const projectMember = await db
    .select({ role: schema.projectMember.role })
    .from(schema.projectMember)
    .where(
      and(
        eq(schema.projectMember.projectId, spec[0]?.projectId || ""),
        eq(schema.projectMember.userId, userId)
      )
    )
    .limit(1);

  if (projectMember.length === 0) {
    throw new Error("Access denied: You don't have access to this project");
  }

  const userRole = projectMember[0]?.role;
  if (userRole === "viewer") {
    throw new Error("Access denied: You don't have permission to modify specifications");
  }

  // Update the spec status
  await db
    .update(schema.apiSpec)
    .set({
      status,
      updatedAt: new Date(),
    })
    .where(eq(schema.apiSpec.id, specId));

  return { success: true };
}
