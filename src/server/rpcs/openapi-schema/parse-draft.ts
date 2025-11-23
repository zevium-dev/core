import { OpenApiValidationError, parseAndValidateOpenApiSpec } from "~/lib/server/openapi-validator";

export class OpenApiDraftParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenApiDraftParseError";
  }
}

const formatValidationErrors = (error: OpenApiValidationError) =>
  error.errors
    .map((issue) => {
      if (issue.path) {
        return `${issue.path}: ${issue.message}`;
      }

      return issue.message;
    })
    .join("\n");

const runValidation = (draft: string, fileName: string) => parseAndValidateOpenApiSpec(draft, fileName).specJson;

const toDraftError = (error: unknown) => {
  if (error instanceof OpenApiValidationError) {
    return new OpenApiDraftParseError(formatValidationErrors(error), { cause: error });
  }

  if (error instanceof Error) {
    return new OpenApiDraftParseError(error.message, { cause: error });
  }

  return new OpenApiDraftParseError("Invalid OpenAPI spec. Provide valid JSON or YAML.");
};

export const parseOpenApiDraft = (rawDraft: string): Record<string, unknown> => {
  const draft = rawDraft.trim();

  if (!draft) {
    throw new OpenApiDraftParseError("OpenAPI spec cannot be empty.");
  }

  try {
    return runValidation(draft, "draft.json");
  } catch (jsonError) {
    if (jsonError instanceof OpenApiValidationError && jsonError.errors.some((issue) => issue.code === "PARSE_ERROR")) {
      try {
        return runValidation(draft, "draft.yaml");
      } catch (yamlError) {
        throw toDraftError(yamlError);
      }
    }

    throw toDraftError(jsonError);
  }
};
