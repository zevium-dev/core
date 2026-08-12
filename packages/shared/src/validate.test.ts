import { describe, expect, it } from "vitest";
import {
  collectOpenApiSpecIssues,
  hasErrors,
  hasValidationErrors,
  isValidSemver,
  isValidSlug,
  validateOpenApiSpec,
} from "./validate.js";
import {
  MAX_DAILY_FREE_TIER_CALLS,
  MAX_ENDPOINT_COST_CREDITS,
} from "./pricing.js";

const validBase = {
  openapi: "3.1.0",
  info: { title: "Demo", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/health": {
      get: {
        summary: "Health",
        "x-zevium-cost": 1,
        "x-zevium-health-check": true,
      },
    },
  },
};

describe("isValidSlug", () => {
  it("accepts kebab-case", () => {
    expect(isValidSlug("my-api")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
  });

  it("rejects bad slugs", () => {
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("My-API")).toBe(false);
    expect(isValidSlug("-nope")).toBe(false);
  });
});

describe("isValidSemver", () => {
  it("accepts core and pre-release", () => {
    expect(isValidSemver("0.1.0")).toBe(true);
    expect(isValidSemver("1.2.3-alpha.1")).toBe(true);
  });

  it("rejects leading zeros and junk", () => {
    expect(isValidSemver("01.0.0")).toBe(false);
    expect(isValidSemver("v1.0.0")).toBe(false);
    expect(isValidSemver("1.0")).toBe(false);
  });
});

describe("validateOpenApiSpec", () => {
  it("flags bad json as error at $", () => {
    const result = validateOpenApiSpec("{nope");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("$");
    expect(result.errors[0]?.message).toMatch(/Invalid JSON/);
    expect(result.warnings).toHaveLength(0);
    expect(hasValidationErrors(result)).toBe(true);
  });

  it("flags non-object root", () => {
    const result = validateOpenApiSpec("[]");
    expect(result.errors).toEqual([
      {
        level: "error",
        path: "$",
        message: "Root must be a JSON object",
      },
    ]);
  });

  it("flags missing openapi", () => {
    const result = validateOpenApiSpec(
      JSON.stringify({
        servers: [{ url: "https://api.example.com" }],
        paths: {},
      }),
    );
    expect(result.errors.some((e) => e.path === "$.openapi")).toBe(true);
  });

  it("flags bad servers", () => {
    const missing = validateOpenApiSpec(
      JSON.stringify({ openapi: "3.1.0", paths: {} }),
    );
    expect(missing.errors.some((e) => e.path === "$.servers")).toBe(true);

    const badUrl = validateOpenApiSpec(
      JSON.stringify({
        openapi: "3.1.0",
        servers: [{ url: "ftp://nope.example" }],
        paths: {},
      }),
    );
    expect(badUrl.errors.some((e) => e.path === "$.servers[0].url")).toBe(true);
    expect(badUrl.errors[0]?.message).toMatch(/http\(s\)/);
  });

  it("flags bad x-zevium-cost type as error", () => {
    const result = validateOpenApiSpec(
      JSON.stringify({
        ...validBase,
        paths: {
          "/x": {
            get: { "x-zevium-cost": "nope" },
          },
        },
      }),
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe('$.paths["/x"].get.x-zevium-cost');
    expect(result.errors[0]?.message).toMatch(/safe non-negative integer/);
  });

  it.each([
    ["fractional", 1.5],
    ["negative", -1],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["overflow", 1e309],
    ["string", "1"],
    ["null", null],
  ])("rejects %s x-zevium-cost", (_label, value) => {
    const text = JSON.stringify(validBase).replace(
      '"x-zevium-cost":1',
      `"x-zevium-cost":${value === Infinity ? "1e309" : JSON.stringify(value)}`,
    );
    const result = validateOpenApiSpec(text);
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: '$.paths["/health"].get.x-zevium-cost',
      }),
    ]);
  });

  it.each([
    ["fractional", 1.5],
    ["negative", -1],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["overflow", 1e309],
    ["string", "1"],
    ["null", null],
  ])("rejects %s x-zevium-free-tier", (_label, value) => {
    const spec = JSON.stringify(validBase).replace(
      '"summary":"Health",',
      `"summary":"Health","x-zevium-free-tier":${value === Infinity ? "1e309" : JSON.stringify(value)},`,
    );
    const result = validateOpenApiSpec(spec);
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: '$.paths["/health"].get.x-zevium-free-tier',
      }),
    ]);
  });

  it.each([0, 1, MAX_ENDPOINT_COST_CREDITS])(
    "accepts configured pricing boundary %s",
    (value) => {
      const spec = JSON.stringify({
        ...validBase,
        paths: {
          "/x": {
            get: {
              "x-zevium-cost": value,
              "x-zevium-free-tier": value,
            },
          },
        },
      });
      expect(validateOpenApiSpec(spec).errors).toEqual([]);
    },
  );

  it("rejects pricing above configured economic ceilings", () => {
    const spec = JSON.stringify({
      ...validBase,
      paths: {
        "/x": {
          get: {
            "x-zevium-cost": MAX_ENDPOINT_COST_CREDITS + 1,
            "x-zevium-free-tier": MAX_DAILY_FREE_TIER_CALLS + 1,
          },
        },
      },
    });
    expect(validateOpenApiSpec(spec).errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/at most/) }),
      expect.objectContaining({ message: expect.stringMatching(/at most/) }),
    ]);
  });

  it("warns on missing cost", () => {
    const result = validateOpenApiSpec(
      JSON.stringify({
        ...validBase,
        paths: {
          "/x": {
            get: { summary: "no cost", "x-zevium-health-check": true },
          },
        },
      }),
    );
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.path).toBe('$.paths["/x"].get.x-zevium-cost');
    expect(result.warnings[0]?.message).toMatch(/Missing x-zevium-cost/);
  });

  it("returns clean for valid priced spec", () => {
    const result = validateOpenApiSpec(JSON.stringify(validBase));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(hasValidationErrors(result)).toBe(false);
  });

  it("collectOpenApiSpecIssues preserves discovery order", () => {
    const issues = collectOpenApiSpecIssues(
      JSON.stringify({
        openapi: "3.1.0",
        servers: [{ url: "https://api.example.com" }],
        paths: {
          "/a": { get: { "x-zevium-health-check": true } },
          "/b": { get: { "x-zevium-cost": -1 } },
        },
      }),
    );
    expect(issues.map((i) => i.level)).toEqual(["warning", "error"]);
    expect(hasErrors(issues)).toBe(true);
  });

  it("requires one parameter-free safe health operation", () => {
    const multiple = validateOpenApiSpec(
      JSON.stringify({
        ...validBase,
        paths: {
          "/health": { get: { "x-zevium-health-check": true } },
          "/ready": { head: { "x-zevium-health-check": true } },
        },
      }),
    );
    expect(multiple.errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("Exactly one"),
      }),
    ]);
    const parameterized = validateOpenApiSpec(
      JSON.stringify({
        ...validBase,
        paths: {
          "/users/{id}": { get: { "x-zevium-health-check": true } },
        },
      }),
    );
    expect(parameterized.errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("parameter-free"),
      }),
    ]);
  });
});
