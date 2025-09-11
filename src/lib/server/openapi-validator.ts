import * as crypto from "node:crypto";
import * as yaml from "yaml";
import { z } from "zod";

// OpenAPI 3.0+ Schema validation
const openApiInfoSchema = z.object({
  contact: z
    .object({
      email: z.string().email().optional(),
      name: z.string().optional(),
      url: z.string().url().optional(),
    })
    .optional(),
  description: z.string().optional(),
  license: z
    .object({
      name: z.string(),
      url: z.string().url().optional(),
    })
    .optional(),
  title: z.string().min(1, "API title is required"),
  version: z.string().min(1, "API version is required"),
});

const openApiPathItemSchema = z.object({
  delete: z.any().optional(),
  get: z.any().optional(),
  head: z.any().optional(),
  options: z.any().optional(),
  patch: z.any().optional(),
  post: z.any().optional(),
  put: z.any().optional(),
  trace: z.any().optional(),
});

const openApiSchema = z.object({
  components: z.any().optional(),
  externalDocs: z
    .object({
      description: z.string().optional(),
      url: z.string().url(),
    })
    .optional(),
  info: openApiInfoSchema,
  openapi: z.string().regex(/^3\.[0-9]+\.[0-9]+$/, "Must be OpenAPI 3.x.x"),
  paths: z.record(z.string(), openApiPathItemSchema).optional(),
  security: z.array(z.any()).optional(),
  servers: z
    .array(
      z.object({
        description: z.string().optional(),
        url: z.string().url(),
      }),
    )
    .optional(),
  tags: z
    .array(
      z.object({
        description: z.string().optional(),
        name: z.string(),
      }),
    )
    .optional(),
});

export interface ParsedOpenApiSpec {
  format: "json" | "yaml";
  hash: string;
  originalRaw: string;
  specJson: Record<string, unknown>;
  title: string;
  version: string;
}

export interface ValidationError {
  code: string;
  message: string;
  path?: string;
}

export class OpenApiValidationError extends Error {
  public readonly errors: Array<ValidationError>;

  constructor(errors: Array<ValidationError>) {
    super(`OpenAPI validation failed: ${errors.map((e) => e.message).join(", ")}`);
    this.name = "OpenApiValidationError";
    this.errors = errors;
  }
}

/**
 * Extract endpoints from an OpenAPI specification
 */
export function extractEndpoints(spec: Record<string, unknown>) {
  const endpoints: Array<{
    deprecated: boolean;
    method: string;
    operationId?: string;
    path: string;
    security: Array<unknown>;
    summary?: string;
    tags: Array<string>;
  }> = [];

  const paths = spec.paths as Record<string, Record<string, unknown>> | undefined;

  if (!paths) {
    return endpoints;
  }

  const httpMethods = ["get", "post", "put", "delete", "options", "head", "patch", "trace"];

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of httpMethods) {
      const operation = pathItem[method] as Record<string, unknown> | undefined;

      if (operation) {
        endpoints.push({
          deprecated: Boolean(operation.deprecated),
          method: method.toUpperCase(),
          operationId: operation.operationId as string | undefined,
          path,
          security: (operation.security as Array<unknown> | undefined) ?? [],
          summary: operation.summary as string | undefined,
          tags: (operation.tags as Array<string> | undefined) ?? [],
        });
      }
    }
  }

  return endpoints;
}

/**
 * Parse and validate an OpenAPI specification file
 */
export function parseAndValidateOpenApiSpec(fileContent: string, fileName: string): ParsedOpenApiSpec {
  const errors: Array<ValidationError> = [];

  // Determine file format
  const isYaml = fileName.toLowerCase().endsWith(".yaml") || fileName.toLowerCase().endsWith(".yml");
  const isJson = fileName.toLowerCase().endsWith(".json");

  if (!isYaml && !isJson) {
    errors.push({
      code: "INVALID_FILE_TYPE",
      message: "File must be a JSON (.json) or YAML (.yaml/.yml) file",
    });
    throw new OpenApiValidationError(errors);
  }

  let parsedContent: unknown;
  let format: "json" | "yaml";

  // Parse the content
  try {
    if (isYaml) {
      parsedContent = (yaml as unknown as { parse: (content: string) => unknown }).parse(fileContent);
      format = "yaml";
    } else {
      parsedContent = JSON.parse(fileContent);
      format = "json";
    }
  } catch (parseError) {
    errors.push({
      code: "PARSE_ERROR",
      message: `Failed to parse ${isYaml ? "YAML" : "JSON"}: ${parseError instanceof Error ? parseError.message : "Unknown error"}`,
    });
    throw new OpenApiValidationError(errors);
  }

  // Validate against OpenAPI schema
  const validationResult = openApiSchema.safeParse(parsedContent);

  if (!validationResult.success) {
    for (const issue of validationResult.error.issues) {
      errors.push({
        code: issue.code,
        message: issue.message,
        path: issue.path.join("."),
      });
    }
    throw new OpenApiValidationError(errors);
  }

  const spec = validationResult.data;

  // Additional semantic validation
  if (spec.paths && Object.keys(spec.paths).length === 0) {
    errors.push({
      code: "EMPTY_PATHS",
      message: "OpenAPI specification must contain at least one path",
      path: "paths",
    });
  }

  // Validate that each path starts with /
  if (spec.paths) {
    for (const [path] of Object.entries(spec.paths)) {
      if (!path.startsWith("/")) {
        errors.push({
          code: "INVALID_PATH_FORMAT",
          message: `Path "${path}" must start with "/"`,
          path: `paths.${path}`,
        });
      }
    }
  }

  if (errors.length > 0) {
    throw new OpenApiValidationError(errors);
  }

  // Create normalized JSON for hash calculation
  const normalizedJson = JSON.stringify(spec, null, 2);
  const hash = crypto.createHash("sha256").update(normalizedJson).digest("hex");

  return {
    format,
    hash,
    originalRaw: fileContent,
    specJson: spec as Record<string, unknown>,
    title: spec.info.title,
    version: spec.info.version,
  };
}

/**
 * Validate file size and content
 */
export function validateFileUpload(file: File): Array<ValidationError> {
  const errors: Array<ValidationError> = [];

  // Check file size (5MB limit)
  const maxSize = 5 * 1024 * 1024; // 5MB
  if (file.size > maxSize) {
    errors.push({
      code: "FILE_TOO_LARGE",
      message: "File size must be less than 5MB",
    });
  }

  // Check file type
  const allowedTypes = [
    "application/json",
    "text/yaml",
    "application/yaml",
    "text/x-yaml",
    "application/x-yaml",
    "text/plain",
  ];

  const fileName = file.name.toLowerCase();
  const isValidExtension = fileName.endsWith(".json") || fileName.endsWith(".yaml") || fileName.endsWith(".yml");

  if (!allowedTypes.includes(file.type) && !isValidExtension) {
    errors.push({
      code: "INVALID_FILE_TYPE",
      message: "File must be a JSON or YAML file",
    });
  }

  return errors;
}
