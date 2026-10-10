import { describe, expect, it } from "vitest";
import { listSpecEndpoints } from "./spec-endpoints";

describe("listSpecEndpoints", () => {
  it("lists methods with pricing", () => {
    const rows = listSpecEndpoints(
      JSON.stringify({
        openapi: "3.1.0",
        servers: [{ url: "https://api.example.com" }],
        paths: {
          "/health": {
            get: { summary: "ok", "x-zevium-cost": 1 },
          },
          "/users": {
            post: { "x-zevium-cost": 5, "x-zevium-free-tier": 10 },
          },
        },
      }),
    );
    expect(rows).toEqual([
      {
        method: "get",
        path: "/health",
        cost: 1,
        freeTier: undefined,
        summary: "ok",
      },
      {
        method: "post",
        path: "/users",
        cost: 5,
        freeTier: 10,
        summary: undefined,
      },
    ]);
  });

  it("returns null on invalid json", () => {
    expect(listSpecEndpoints("{nope")).toBeNull();
  });

  it("returns empty for blank", () => {
    expect(listSpecEndpoints("")).toEqual([]);
  });
});

it("keeps missing prices editable without inventing a price", () => {
  const rows = listSpecEndpoints(
    JSON.stringify({
      paths: {
        "/hidden": { get: { "x-zevium-free-tier": 4 } },
        "/free": { get: { "x-zevium-cost": 0 } },
        "/paid": { get: { "x-zevium-cost": 5 } },
      },
    }),
  );
  expect(rows?.map(({ cost, freeTier }) => ({ cost, freeTier }))).toEqual([
    { cost: null, freeTier: 4 },
    { cost: 0, freeTier: undefined },
    { cost: 5, freeTier: undefined },
  ]);
});
