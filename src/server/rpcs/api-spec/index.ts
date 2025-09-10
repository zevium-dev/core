import z from "zod";

import { createApiSpec, getApiSpecById, getProjectApiSpecs, updateApiSpecStatus } from "~/lib/server/api-spec-service";
import { extractEndpoints, OpenApiValidationError, parseAndValidateOpenApiSpec } from "~/lib/server/openapi-validator";
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
    .input(z.object({
      specId: z.string(),
    }))
    .output(z.object({
      spec: apiSpecSchema.extend({
        endpoints: z.array(endpointSchema),
        originalRaw: z.string().nullable(),
        specJson: z.record(z.string(), z.unknown()),
      }),
    }))
    .query(async ({ ctx, input }) => {
      const spec = await getApiSpecById(input.specId, ctx.user.id);
      
      return {
        spec,
      };
    }),

  // Get all API specifications for a project
  getByProject: protectedProcedure
    .meta({ route: { path: "/api-spec/get-by-project", summary: "Get API specifications for project" } })
    .input(z.object({
      projectId: z.string(),
    }))
    .output(z.object({
      specs: z.array(apiSpecSchema.extend({
        endpointCount: z.number(),
      })),
    }))
    .query(async ({ ctx, input }) => {
      const specs = await getProjectApiSpecs(input.projectId, ctx.user.id);
      
      return {
        specs: specs.map(spec => ({
          ...spec,
          projectId: input.projectId,
        })),
      };
    }),

  // Update API specification status
  updateStatus: protectedProcedure
    .meta({ route: { path: "/api-spec/update-status", summary: "Update API specification status" } })
    .input(z.object({
      specId: z.string(),
      status: z.enum(["active", "archived", "deprecated"]),
    }))
    .output(z.object({
      success: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      await updateApiSpecStatus(input.specId, input.status, ctx.user.id);
      
      return {
        success: true,
      };
    }),

  // Upload and create new API specification
  upload: protectedProcedure
    .meta({ route: { path: "/api-spec/upload", summary: "Upload OpenAPI specification" } })
    .input(z.object({
      fileContent: z.string().min(1, "File content is required"),
      fileName: z.string().min(1, "File name is required"),
      projectId: z.string().min(1, "Project ID is required"),
      versionLabel: z.string().optional(),
    }))
    .output(z.object({
      spec: apiSpecSchema.extend({
        endpointCount: z.number(),
      }),
      success: z.boolean(),
    }))
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
          throw new Error(`OpenAPI validation failed: ${error.errors.map(e => e.message).join(", ")}`);
        }
        throw error;
      }
    }),

  // Validate OpenAPI specification without saving
  validate: protectedProcedure
    .meta({ route: { path: "/api-spec/validate", summary: "Validate OpenAPI specification" } })
    .input(z.object({
      fileContent: z.string().min(1, "File content is required"),
      fileName: z.string().min(1, "File name is required"),
    }))
    .output(z.object({
      errors: z.array(z.object({
        code: z.string(),
        message: z.string(),
        path: z.string().optional(),
      })).optional(),
      isValid: z.boolean(),
      spec: z.object({
        endpointCount: z.number(),
        format: z.enum(["json", "yaml"]),
        title: z.string(),
        version: z.string(),
      }).optional(),
    }))
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
          errors: [{
            code: "UNKNOWN_ERROR",
            message: error instanceof Error ? error.message : "Unknown validation error",
          }],
          isValid: false,
        };
      }
    }),
});
