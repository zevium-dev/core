import { describe, expect, it } from "vitest";

import { OpenApiDraftParseError, parseOpenApiDraft } from "./parse-draft";

describe("parseOpenApiDraft", () => {
  it("parses valid JSON", () => {
    const result = parseOpenApiDraft('{"openapi":"3.1.0","info":{"title":"Demo","version":"1.0.0"}}');

    expect(result).toMatchObject({
      info: { title: "Demo", version: "1.0.0" },
      openapi: "3.1.0",
    });
  });

  it("parses valid YAML", () => {
    const yamlDraft = `openapi: 3.1.0\ninfo:\n  title: Demo\n  version: 1.0.0`;

    const result = parseOpenApiDraft(yamlDraft);

    expect(result).toMatchObject({
      info: { title: "Demo", version: "1.0.0" },
      openapi: "3.1.0",
    });
  });

  it("rejects empty input", () => {
    expect(() => parseOpenApiDraft("   ")).toThrow(OpenApiDraftParseError);
  });

  it("rejects non-object payloads", () => {
    expect(() => parseOpenApiDraft("[]")).toThrow(OpenApiDraftParseError);
  });

  it("returns validator errors", () => {
    const invalid = JSON.stringify({
      info: { title: "", version: "1.0.0" },
      openapi: "3.1.0",
    });

    expect(() => parseOpenApiDraft(invalid)).toThrow("info.title: API title is required");
  });
});
