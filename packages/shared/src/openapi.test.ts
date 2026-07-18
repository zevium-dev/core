import { describe, expect, it } from "vitest";
import {
  extractPricing,
  joinUpstreamUrl,
  matchOperation,
  matchPathTemplate,
  normalizePath,
  parseSpec,
} from "./openapi.js";

const SAMPLE = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Demo", version: "1.0.0" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/health": {
      get: {
        summary: "Health",
        "x-zevium-cost": 1,
      },
    },
    "/users/{id}": {
      get: {
        operationId: "getUser",
        "x-zevium-cost": 5,
        "x-zevium-free-tier": 10,
      },
      post: {
        "x-zevium-cost": 2,
      },
    },
    "/items/{itemId}/tags/{tag}": {
      put: {
        summary: "Tag item",
      },
    },
  },
});

describe("parseSpec", () => {
  it("parses servers, paths, and methods", () => {
    const spec = parseSpec(SAMPLE);
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info?.title).toBe("Demo");
    expect(spec.servers).toEqual([{ url: "https://api.example.com/v1" }]);
    expect(spec.paths["/users/{id}"]?.get?.operationId).toBe("getUser");
    expect(spec.paths["/users/{id}"]?.post).toBeTruthy();
  });

  it("throws on bad JSON", () => {
    expect(() => parseSpec("{nope")).toThrow(/invalid OpenAPI JSON/);
  });

  it("throws on non-object root", () => {
    expect(() => parseSpec("[]")).toThrow(/root must be an object/);
  });

  it("ignores non-http path keys like parameters", () => {
    const spec = parseSpec(
      JSON.stringify({
        paths: {
          "/x": {
            parameters: [{ name: "q", in: "query" }],
            get: { summary: "ok" },
          },
        },
      }),
    );
    expect(spec.paths["/x"]?.get?.summary).toBe("ok");
    expect(spec.paths["/x"]?.parameters).toBeUndefined();
  });
});

describe("matchPathTemplate", () => {
  it("matches static and param segments", () => {
    expect(matchPathTemplate("/users/{id}", "/users/42")).toEqual({
      id: "42",
    });
    expect(
      matchPathTemplate("/items/{itemId}/tags/{tag}", "/items/a/tags/b"),
    ).toEqual({ itemId: "a", tag: "b" });
  });

  it("rejects length or literal mismatches", () => {
    expect(matchPathTemplate("/users/{id}", "/users/42/extra")).toBeNull();
    expect(matchPathTemplate("/users/{id}", "/posts/42")).toBeNull();
    expect(matchPathTemplate("/users", "/users/42")).toBeNull();
  });

  it("normalizes trailing slashes", () => {
    expect(matchPathTemplate("/users/{id}/", "/users/1")).toEqual({ id: "1" });
    expect(matchPathTemplate("/", "/")).toEqual({});
  });
});

describe("matchOperation", () => {
  const spec = parseSpec(SAMPLE);

  it("matches method + path and returns pricing + upstream", () => {
    const hit = matchOperation(spec, "GET", "/users/abc");
    expect(hit).not.toBeNull();
    expect(hit!.method).toBe("get");
    expect(hit!.pathTemplate).toBe("/users/{id}");
    expect(hit!.params).toEqual({ id: "abc" });
    expect(hit!.pricing).toEqual({ cost: 5, freeTier: 10 });
    expect(hit!.upstreamBaseUrl).toBe("https://api.example.com/v1");
    expect(hit!.operation.operationId).toBe("getUser");
  });

  it("defaults cost to 1 when extension missing", () => {
    const hit = matchOperation(spec, "PUT", "/items/1/tags/hot");
    expect(hit!.pricing).toEqual({ cost: 1 });
  });

  it("is case-insensitive on method", () => {
    expect(matchOperation(spec, "Post", "/users/1")?.method).toBe("post");
  });

  it("returns null for unknown route or method", () => {
    expect(matchOperation(spec, "GET", "/nope")).toBeNull();
    expect(matchOperation(spec, "DELETE", "/users/1")).toBeNull();
  });
});

describe("extractPricing", () => {
  it("defaults unspecified cost to 1 and omits freeTier", () => {
    expect(extractPricing({})).toEqual({ cost: 1 });
  });

  it("keeps cost 0 as a valid free-tier cost (no rewrite to 1)", () => {
    expect(extractPricing({ "x-zevium-cost": 0 })).toEqual({ cost: 0 });
  });

  it("accepts positive integer cost and freeTier", () => {
    expect(
      extractPricing({ "x-zevium-cost": 3, "x-zevium-free-tier": 2 }),
    ).toEqual({ cost: 3, freeTier: 2 });
  });

  it("treats freeTier 0 as no free tier", () => {
    expect(
      extractPricing({ "x-zevium-cost": 1, "x-zevium-free-tier": 0 }),
    ).toEqual({ cost: 1 });
  });

  it("rejects fractional cost", () => {
    expect(() => extractPricing({ "x-zevium-cost": 3.9 })).toThrow(/integer/);
  });

  it("rejects fractional freeTier", () => {
    expect(() =>
      extractPricing({ "x-zevium-cost": 1, "x-zevium-free-tier": 2.2 }),
    ).toThrow(/integer/);
  });

  it("rejects negative cost", () => {
    expect(() => extractPricing({ "x-zevium-cost": -2 })).toThrow(
      /non-negative/,
    );
  });

  it("rejects negative freeTier", () => {
    expect(() =>
      extractPricing({ "x-zevium-cost": 1, "x-zevium-free-tier": -1 }),
    ).toThrow(/non-negative/);
  });
});

describe("normalizePath / joinUpstreamUrl", () => {
  it("normalizePath", () => {
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("foo")).toBe("/foo");
    expect(normalizePath("/foo/")).toBe("/foo");
  });

  it("joins base + path", () => {
    expect(joinUpstreamUrl("https://api.example.com/v1", "/users/1")).toBe(
      "https://api.example.com/v1/users/1",
    );
    expect(joinUpstreamUrl("https://api.example.com/", "/")).toMatch(
      /https:\/\/api\.example\.com\/?/,
    );
  });
});
