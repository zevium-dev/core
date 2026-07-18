import { describe, expect, it } from "vitest";
import { parseImportSpecUrl } from "./spec-import";

describe("parseImportSpecUrl", () => {
  it("accepts http(s) urls", () => {
    expect(
      parseImportSpecUrl({ url: "https://example.com/openapi.json" }),
    ).toEqual({
      ok: true,
      data: { url: "https://example.com/openapi.json" },
    });
    expect(
      parseImportSpecUrl({ url: "  http://localhost:3000/spec.yaml  " }),
    ).toEqual({
      ok: true,
      data: { url: "http://localhost:3000/spec.yaml" },
    });
  });

  it("rejects non-http and junk", () => {
    const ftp = parseImportSpecUrl({ url: "ftp://example.com/x" });
    expect(ftp.ok).toBe(false);

    const empty = parseImportSpecUrl({ url: "" });
    expect(empty.ok).toBe(false);

    const notUrl = parseImportSpecUrl({ url: "not-a-url" });
    expect(notUrl.ok).toBe(false);
  });
});
