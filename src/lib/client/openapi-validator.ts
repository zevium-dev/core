import { z } from "zod";

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
  specJson: Record<string, unknown>;
}

export interface ValidationError {
  code: string;
  column?: number;
  line?: number;
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

const buildParseError = (message: string, line?: number, column?: number): ValidationError => ({
  code: "PARSE_ERROR",
  column,
  line,
  message,
});

const additionalSemanticErrors = (spec: Record<string, unknown>) => {
  const errors: Array<ValidationError> = [];
  const paths = spec.paths as Record<string, Record<string, unknown>> | undefined;

  if (paths && Object.keys(paths).length === 0) {
    errors.push({
      code: "EMPTY_PATHS",
      message: "OpenAPI specification must contain at least one path",
      path: "paths",
    });
  }

  if (paths) {
    for (const [path] of Object.entries(paths)) {
      if (!path.startsWith("/")) {
        errors.push({
          code: "INVALID_PATH_FORMAT",
          message: `Path "${path}" must start with "/"`,
          path: `paths.${path}`,
        });
      }
    }
  }

  return errors;
};

type ValidationResult = { errors: Array<ValidationError> } & ParsedOpenApiSpec;

export function validateOpenApiDraft(rawDraft: string, _filenameHint: string): ValidationResult {
  const errors: Array<ValidationError> = [];
  const draft = rawDraft.trim();

  if (!draft) {
    errors.push({ code: "EMPTY", message: "OpenAPI spec cannot be empty." });
    throw new OpenApiValidationError(errors);
  }

  let parsedContent: unknown;

  try {
    parsedContent = JSON.parse(draft);
  } catch (parseError) {
    throw new OpenApiValidationError([
      buildParseError(parseError instanceof Error ? parseError.message : "Failed to parse JSON specification"),
    ]);
  }

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

  const spec = validationResult.data as Record<string, unknown>;
  const semanticErrors = additionalSemanticErrors(spec);
  if (semanticErrors.length > 0) {
    throw new OpenApiValidationError(semanticErrors);
  }

  return {
    errors: [],
    specJson: spec,
  };
}

export const validationErrorsToDiagnostics = (errors: Array<ValidationError>) =>
  errors.map((error) => ({
    column: error.column ?? 1,
    line: error.line ?? 1,
    message: error.message,
    path: error.path,
  }));
