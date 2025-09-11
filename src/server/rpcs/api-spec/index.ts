import { and, eq } from "drizzle-orm";
import z from "zod";

import { db } from "~/db";
import * as schema from "~/db/schema";
import { createApiSpec, getApiSpecById, getProjectApiSpecs, updateApiSpecStatus } from "~/lib/server/api-spec-service";
import { extractEndpoints, OpenApiValidationError, parseAndValidateOpenApiSpec, type ParsedOpenApiSpec } from "~/lib/server/openapi-validator";
import { protectedProcedure, router } from "~/server/trpc";

// API Spec schema for responses
const apiSpecSchema = z.object({
  createdAt: z.date(),
  format: z.enum(["json", "yaml"]),
  hash: z.string(),
  id: z.string(),
  projectId: z.string(),
  projectName: z.string().optional(),
  status: z.enum(["active", "archived", "deprecated"]),
  title: z.string().nullable(),
  updatedAt: z.date(),
  versionLabel: z.string(),
});

const endpointSchema = z.object({
  createdAt: z.date(),
  deprecated: z.boolean(),
  id: z.string(),
  method: z.string(),
  operationId: z.string().nullable(),
  path: z.string(),
  security: z.array(z.unknown()),
  summary: z.string().nullable(),
  tags: z.array(z.string()),
});

export const apiSpecRouter = router({
  // Get API specification by ID
  getById: protectedProcedure
    .meta({ route: { path: "/api-spec/get-by-id", summary: "Get API specification by ID" } })
    .input(
      z.object({
        specId: z.string(),
      }),
    )
    .output(
      z.object({
        spec: apiSpecSchema.extend({
          endpoints: z.array(endpointSchema),
          originalRaw: z.string().nullable(),
          specJson: z.record(z.string(), z.unknown()),
        }),
      }),
    )
    .query(async ({ ctx, input }) => {
      const spec = await getApiSpecById(input.specId, ctx.user.id);

      return {
        spec,
      };
    }),

  // Get all API specifications for a project
  getByProject: protectedProcedure
    .meta({ route: { path: "/api-spec/get-by-project", summary: "Get API specifications for project" } })
    .input(
      z.object({
        projectId: z.string(),
      }),
    )
    .output(
      z.object({
        specs: z.array(
          apiSpecSchema.extend({
            endpointCount: z.number(),
          }),
        ),
      }),
    )
    .query(async ({ ctx, input }) => {
      const specs = await getProjectApiSpecs(input.projectId, ctx.user.id);

      return {
        specs: specs.map((spec) => ({
          ...spec,
          projectId: input.projectId,
        })),
      };
    }),

  // Get API specifications for a project by version
  getByProjectAndVersion: protectedProcedure
    .meta({ route: { path: "/api-spec/get-by-project-version", summary: "Get API specifications for project by version" } })
    .input(z.object({
      projectId: z.string(),
      versionLabel: z.string(),
    }))
    .output(z.object({
      specs: z.array(apiSpecSchema.extend({
        endpointCount: z.number(),
        endpoints: z.array(endpointSchema),
      })),
    }))
    .query(async ({ ctx, input }) => {
      const specs = await getProjectApiSpecs(input.projectId, ctx.user.id);
      
      // Filter specs by version label
      const filteredSpecs = specs.filter(spec => spec.versionLabel === input.versionLabel);
      
      // Fetch detailed information including endpoints for each spec
      const specsWithEndpoints = await Promise.all(
        filteredSpecs.map(async (spec) => {
          const detailedSpec = await getApiSpecById(spec.id, ctx.user.id);
          return {
            ...spec,
            endpoints: detailedSpec.endpoints,
            projectId: input.projectId,
          };
        })
      );
      
      return {
        specs: specsWithEndpoints,
      };
    }),

  // Update API specification status
  updateStatus: protectedProcedure
    .meta({ route: { path: "/api-spec/update-status", summary: "Update API specification status" } })
    .input(
      z.object({
        specId: z.string(),
        status: z.enum(["active", "archived", "deprecated"]),
      }),
    )
    .output(
      z.object({
        success: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await updateApiSpecStatus(input.specId, input.status, ctx.user.id);

      return {
        success: true,
      };
    }),

  // Upload and create new API specification
  upload: protectedProcedure
    .meta({ route: { path: "/api-spec/upload", summary: "Upload OpenAPI specification" } })
    .input(
      z.object({
        fileContent: z.string().min(1, "File content is required"),
        fileName: z.string().min(1, "File name is required"),
        projectId: z.string().min(1, "Project ID is required"),
        versionLabel: z.string().optional(),
      }),
    )
    .output(
      z.object({
        spec: apiSpecSchema.extend({
          endpointCount: z.number(),
        }),
        success: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        // Validate file content and format
        const parsedSpec = parseAndValidateOpenApiSpec(input.fileContent, input.fileName);

        // Create the API specification
        const spec = await createApiSpec({
          parsedSpec,
          projectId: input.projectId,
          userId: ctx.user.id,
          versionLabel: input.versionLabel,
        });

        return {
          spec: {
            ...spec,
            endpointCount: spec.endpointCount,
            projectId: input.projectId,
          },
          success: true,
        };
      } catch (error) {
        if (error instanceof OpenApiValidationError) {
          throw new Error(`OpenAPI validation failed: ${error.errors.map((e) => e.message).join(", ")}`);
        }
        throw error;
      }
    }),

  // Upload and create new API specification with file upload
  uploadFiles: protectedProcedure
    .meta({ route: { path: "/api-spec/upload-files", summary: "Upload OpenAPI specification files" } })
    .input(z.object({
      files: z.array(z.object({
        content: z.string().min(1, "File content is required"),
        name: z.string().min(1, "File name is required"),
        size: z.number().positive("File size must be positive"),
        type: z.string().optional(),
      })).min(1, "At least one file is required").max(10, "Maximum 10 files allowed"),
      isUpdate: z.boolean().default(false),
      projectId: z.string().min(1, "Project ID is required"),
      versionLabel: z.string().min(1, "Version label is required"),
    }))
    .output(z.object({
      message: z.string(),
      specs: z.array(apiSpecSchema.extend({
        endpointCount: z.number(),
      })),
      success: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
      const ALLOWED_EXTENSIONS = ['.json', '.yaml', '.yml'];
      const ALLOWED_MIME_TYPES = ['application/json', 'text/yaml', 'application/x-yaml', 'text/x-yaml', 'text/plain'];
      
      try {
        // Validate project access and permissions
        const projectMember = await db
          .select({ 
            organizationId: schema.project.organizationId,
            projectName: schema.project.name,
            role: schema.projectMember.role,
          })
          .from(schema.projectMember)
          .innerJoin(schema.project, eq(schema.projectMember.projectId, schema.project.id))
          .where(
            and(
              eq(schema.projectMember.projectId, input.projectId),
              eq(schema.projectMember.userId, ctx.user.id)
            )
          )
          .limit(1);

        if (projectMember.length === 0) {
          throw new Error("Access denied: You don't have access to this project");
        }

        const userRole = projectMember[0]?.role;
        if (userRole === "viewer") {
          throw new Error("Access denied: You don't have permission to upload specifications");
        }

        // Validate each file
        const validationErrors: Array<string> = [];
        const validatedFiles: Array<{ 
          content: string; 
          extension: string; 
          name: string; 
          parsedSpec: ParsedOpenApiSpec; 
        }> = [];

        for (const [index, file] of input.files.entries()) {
          const filePrefix = `File ${index + 1} (${file.name})`;
          
          // Validate file size
          if (file.size > MAX_FILE_SIZE) {
            validationErrors.push(`${filePrefix}: File size exceeds 10MB limit`);
            continue;
          }

          // Validate file extension
          const extension = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
          if (!ALLOWED_EXTENSIONS.includes(extension)) {
            validationErrors.push(`${filePrefix}: Invalid file type. Only .json, .yaml, and .yml files are allowed`);
            continue;
          }

          // Validate MIME type if provided
          if (file.type && !ALLOWED_MIME_TYPES.includes(file.type)) {
            validationErrors.push(`${filePrefix}: Invalid MIME type. Expected JSON or YAML format`);
            continue;
          }

          // Validate content is not empty
          if (!file.content.trim()) {
            validationErrors.push(`${filePrefix}: File content is empty`);
            continue;
          }

          // Check content size vs declared size (basic validation)
          const contentSize = new TextEncoder().encode(file.content).length;
          if (Math.abs(contentSize - file.size) > file.size * 0.1) { // Allow 10% variance
            validationErrors.push(`${filePrefix}: File size mismatch. Content size doesn't match declared size`);
            continue;
          }

          // Validate OpenAPI specification
          try {
            const parsedSpec = parseAndValidateOpenApiSpec(file.content, file.name);
            if ("error" in parsedSpec) {
              validationErrors.push(`${filePrefix}: ${String(parsedSpec.error)}`);
              continue;
            }

            validatedFiles.push({
              content: file.content,
              extension,
              name: file.name,
              parsedSpec,
            });
          } catch (error) {
            validationErrors.push(`${filePrefix}: Failed to parse OpenAPI specification - ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }

        if (validationErrors.length > 0) {
          throw new Error(`File validation failed:\n${validationErrors.join('\n')}`);
        }

        if (validatedFiles.length === 0) {
          throw new Error("No valid files to upload");
        }

        // If updating, check if version exists
        if (input.isUpdate) {
          const existingSpecs = await db
            .select({ id: schema.apiSpec.id })
            .from(schema.apiSpec)
            .where(
              and(
                eq(schema.apiSpec.projectId, input.projectId),
                eq(schema.apiSpec.versionLabel, input.versionLabel)
              )
            );

          if (existingSpecs.length === 0) {
            throw new Error(`Version "${input.versionLabel}" does not exist. Cannot update non-existent version.`);
          }

          // Archive existing specs for this version
          await db
            .update(schema.apiSpec)
            .set({ 
              status: "archived", 
              updatedAt: new Date() 
            })
            .where(
              and(
                eq(schema.apiSpec.projectId, input.projectId),
                eq(schema.apiSpec.versionLabel, input.versionLabel),
                eq(schema.apiSpec.status, "active")
              )
            );
        } else {
          // Check if version already exists for new uploads
          const existingVersion = await db
            .select({ id: schema.apiSpec.id })
            .from(schema.apiSpec)
            .where(
              and(
                eq(schema.apiSpec.projectId, input.projectId),
                eq(schema.apiSpec.versionLabel, input.versionLabel)
              )
            )
            .limit(1);

          if (existingVersion.length > 0) {
            throw new Error(`Version "${input.versionLabel}" already exists. Use update mode to modify existing versions.`);
          }
        }

        // Process and validate each file
        const createdSpecs: Array<{ endpointCount: number } & z.infer<typeof apiSpecSchema>> = [];
        const processingErrors: Array<string> = [];

        for (const file of validatedFiles) {
          try {
            // Check for duplicate specs by hash within this upload
            const isDuplicate = createdSpecs.some(spec => spec.hash === file.parsedSpec.hash);
            if (isDuplicate) {
              processingErrors.push(`${file.name}: Duplicate specification detected within upload`);
              continue;
            }

            // Check if a spec with the same hash already exists in the project (for different version)
            const existingSpecByHash = await db
              .select({ 
                id: schema.apiSpec.id, 
                versionLabel: schema.apiSpec.versionLabel 
              })
              .from(schema.apiSpec)
              .where(
                and(
                  eq(schema.apiSpec.projectId, input.projectId),
                  eq(schema.apiSpec.hash, file.parsedSpec.hash),
                  eq(schema.apiSpec.status, "active")
                )
              )
              .limit(1);

            if (existingSpecByHash.length > 0 && !input.isUpdate) {
              processingErrors.push(`${file.name}: This specification already exists in version "${existingSpecByHash[0]?.versionLabel}"`);
              continue;
            }

            // Create the API specification
            const spec = await createApiSpec({
              parsedSpec: file.parsedSpec,
              projectId: input.projectId,
              userId: ctx.user.id,
              versionLabel: input.versionLabel,
            });

            createdSpecs.push({
              ...spec,
              endpointCount: spec.endpointCount,
            });

          } catch (error) {
            if (error instanceof OpenApiValidationError) {
              processingErrors.push(`${file.name}: OpenAPI validation failed - ${error.errors.map(e => e.message).join(", ")}`);
            } else {
              processingErrors.push(`${file.name}: ${error instanceof Error ? error.message : "Unknown processing error"}`);
            }
          }
        }

        // Check if any specs were successfully created
        if (createdSpecs.length === 0) {
          const errorMessage = processingErrors.length > 0 
            ? `All files failed to process:\n${processingErrors.join('\n')}`
            : "No specifications could be created";
          throw new Error(errorMessage);
        }

        // Prepare response message
        let message = `Successfully uploaded ${createdSpecs.length} specification(s)`;
        if (processingErrors.length > 0) {
          message += `\n\nWarnings:\n${processingErrors.join('\n')}`;
        }

        return {
          message,
          specs: createdSpecs.map(spec => ({
            ...spec,
            projectId: input.projectId,
          })),
          success: true,
        };

      } catch (error) {
        // Log error for debugging (in production, use proper logging)
        console.error('API Spec Upload Error:', error);
        
        throw new Error(error instanceof Error ? error.message : "Failed to upload API specifications");
      }
    }),

  // Validate OpenAPI specification without saving
  validate: protectedProcedure
    .meta({ route: { path: "/api-spec/validate", summary: "Validate OpenAPI specification" } })
    .input(
      z.object({
        fileContent: z.string().min(1, "File content is required"),
        fileName: z.string().min(1, "File name is required"),
      }),
    )
    .output(
      z.object({
        errors: z
          .array(
            z.object({
              code: z.string(),
              message: z.string(),
              path: z.string().optional(),
            }),
          )
          .optional(),
        isValid: z.boolean(),
        spec: z
          .object({
            endpointCount: z.number(),
            format: z.enum(["json", "yaml"]),
            title: z.string(),
            version: z.string(),
          })
          .optional(),
      }),
    )
    .mutation(({ input }) => {
      try {
        const parsedSpec = parseAndValidateOpenApiSpec(input.fileContent, input.fileName);
        const endpoints = extractEndpoints(parsedSpec.specJson);

        return {
          isValid: true,
          spec: {
            endpointCount: endpoints.length,
            format: parsedSpec.format,
            title: parsedSpec.title,
            version: parsedSpec.version,
          },
        };
      } catch (error) {
        if (error instanceof OpenApiValidationError) {
          return {
            errors: error.errors,
            isValid: false,
          };
        }

        return {
          errors: [
            {
              code: "UNKNOWN_ERROR",
              message: error instanceof Error ? error.message : "Unknown validation error",
            },
          ],
          isValid: false,
        };
      }
    }),
});
