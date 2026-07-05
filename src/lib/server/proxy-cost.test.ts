import { describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => {
  const results: unknown[] = [];
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "where", "orderBy", "limit", "groupBy", "having"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (val: unknown) => void) => resolve(results.shift() ?? []);
  return { chain, results };
});

vi.mock("~/db", () => ({
  db: { select: vi.fn(() => mock.chain) },
  orm: { desc: vi.fn() },
  schema: {
    openAPISchema: { projectId: "project_id" },
    openAPISchemaVersion: {
      createdAt: "created_at",
      openAPISchemaId: "openapi_schema_id",
      schema: "schema",
    },
    organization: { id: "id", slug: "slug" },
    project: { id: "id", organizationId: "organization_id", slug: "slug", status: "status" },
  },
}));

import { extractHostname, resolveProxyTarget } from "./proxy-cost";

describe("proxy-cost", () => {
  describe("extractHostname", () => {
    it("extracts hostname from URL", () => {
      expect(extractHostname("https://api.openai.com/v1/chat")).toBe("api.openai.com");
    });

    it("returns empty string for invalid URL", () => {
      expect(extractHostname("not-a-url")).toBe("");
    });
  });

  describe("resolveProxyTarget", () => {
    it("returns target with cost + upstream URL for valid project + spec", async () => {
      mock.results.push(
        [{ id: "proj_123" }], // project query result
        [
          {
            schema: JSON.stringify({
              servers: [{ url: "https://api.openai.com" }],
              paths: {
                "/v1/chat/completions": {
                  post: { "x-zevium-cost": 10 },
                },
              },
            }),
          },
        ], // version query result
      );

      const result = await resolveProxyTarget("myorg", "myapi", "POST", "/v1/chat/completions");
      expect(result).toEqual({
        cost: 10,
        upstreamUrl: "https://api.openai.com/v1/chat/completions",
      });
    });

    it("defaults to 1 credit when x-zevium-cost is missing", async () => {
      mock.results.push(
        [{ id: "proj_123" }],
        [
          {
            schema: JSON.stringify({
              servers: [{ url: "https://api.example.com" }],
              paths: {
                "/status": { get: {} },
              },
            }),
          },
        ],
      );

      const result = await resolveProxyTarget("myorg", "myapi", "GET", "/status");
      expect(result?.cost).toBe(1);
    });

    it("returns null when project not found or not active", async () => {
      mock.results.push([]); // empty project query
      const result = await resolveProxyTarget("noorg", "noapi", "GET", "/test");
      expect(result).toBeNull();
    });

    it("returns null when no published spec version exists", async () => {
      mock.results.push(
        [{ id: "proj_123" }], // project found
        [], // no versions
      );
      const result = await resolveProxyTarget("myorg", "myapi", "GET", "/test");
      expect(result).toBeNull();
    });
  });
});
