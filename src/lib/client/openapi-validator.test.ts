import { describe, expect, it } from "vitest";

import { OpenApiValidationError, validateOpenApiDraft, validationErrorsToDiagnostics } from "./openapi-validator";

const getDiagnosticsForInvalidDraft = (draft: string) => {
  try {
    validateOpenApiDraft(draft, "draft.json");
    throw new Error("Expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(OpenApiValidationError);
    return validationErrorsToDiagnostics((error as OpenApiValidationError).errors, draft);
  }
};

describe("validationErrorsToDiagnostics", () => {
  it("maps parse errors to a non-default column", () => {
    const diagnostics = getDiagnosticsForInvalidDraft('{"openapi":"3.1.0","info":}');

    expect(diagnostics.at(0)?.line).toBe(1);
    expect(diagnostics.at(0)?.column).toBeGreaterThan(1);
  });

  it("maps schema path errors to the exact field value", () => {
    const diagnostics = getDiagnosticsForInvalidDraft(`{
  "openapi": "3.1.0",
  "info": {
    "title": "",
    "version": "1.0.0"
  }
}`);

    const titleError = diagnostics.find((diagnostic) => diagnostic.path === "info.title");

    expect(titleError).toBeDefined();
    expect(titleError?.line).toBe(4);
    expect(titleError?.column).toBe(14);
  });

  it("falls back to parent object when a required field is missing", () => {
    const diagnostics = getDiagnosticsForInvalidDraft(`{
  "openapi": "3.1.0",
  "info": {
    "title": "Demo"
  }
}`);

    const missingVersionError = diagnostics.find((diagnostic) => diagnostic.path === "info.version");

    expect(missingVersionError).toBeDefined();
    expect(missingVersionError?.line).toBe(3);
    expect(missingVersionError?.column).toBe(11);
  });

  it("maps semantic path errors to the offending path key", () => {
    const diagnostics = getDiagnosticsForInvalidDraft(`{
  "openapi": "3.1.0",
  "info": {
    "title": "Demo",
    "version": "1.0.0"
  },
  "paths": {
    "users": {}
  }
}`);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics.at(0)?.line).toBe(8);
    expect(diagnostics.at(0)?.column).toBe(14);
  });
});
