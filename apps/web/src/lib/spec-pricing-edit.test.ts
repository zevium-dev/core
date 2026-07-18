import { describe, expect, it } from "vitest";

import { applyPricingEdit } from "./spec-pricing-edit";

const BASE = JSON.stringify({
  openapi: "3.1.0",
  paths: {
    "/health": {
      get: { summary: "ok", "x-zevium-cost": 1 },
    },
    "/users": {
      post: { "x-zevium-cost": 5, "x-zevium-free-tier": 10 },
    },
  },
});

describe("applyPricingEdit", () => {
  it("updates an existing cost", () => {
    const r = applyPricingEdit(BASE, {
      path: "/health",
      method: "get",
      cost: 7,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.text) as {
      paths: { "/health": { get: { "x-zevium-cost": number } } };
    };
    expect(parsed.paths["/health"].get["x-zevium-cost"]).toBe(7);
  });

  it("adds a cost when absent (key appends at end)", () => {
    const noCost = JSON.stringify({
      paths: { "/ping": { get: { summary: "pong" } } },
    });
    const r = applyPricingEdit(noCost, {
      path: "/ping",
      method: "get",
      cost: 3,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.text) as {
      paths: { "/ping": { get: Record<string, unknown> } };
    };
    const keys = Object.keys(parsed.paths["/ping"].get);
    expect(parsed.paths["/ping"].get["x-zevium-cost"]).toBe(3);
    // newly added key lands last; existing key order before it preserved
    expect(keys.indexOf("summary")).toBeLessThan(keys.indexOf("x-zevium-cost"));
  });

  it("deletes the cost key when cleared (null)", () => {
    const r = applyPricingEdit(BASE, {
      path: "/health",
      method: "get",
      cost: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.text) as {
      paths: { "/health": { get: Record<string, unknown> } };
    };
    expect("x-zevium-cost" in parsed.paths["/health"].get).toBe(false);
  });

  it("sets and clears free-tier", () => {
    const set = applyPricingEdit(BASE, {
      path: "/health",
      method: "get",
      freeTier: 25,
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const withFree = JSON.parse(set.text) as {
      paths: { "/health": { get: { "x-zevium-free-tier"?: number } } };
    };
    expect(withFree.paths["/health"].get["x-zevium-free-tier"]).toBe(25);

    const cleared = applyPricingEdit(set.text, {
      path: "/health",
      method: "get",
      freeTier: null,
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const withoutFree = JSON.parse(cleared.text) as {
      paths: { "/health": { get: Record<string, unknown> } };
    };
    expect("x-zevium-free-tier" in withoutFree.paths["/health"].get).toBe(
      false,
    );
  });

  it("leaves a field untouched when undefined", () => {
    const r = applyPricingEdit(BASE, {
      path: "/users",
      method: "post",
      cost: 9,
      // freeTier omitted -> must remain 10
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.text) as {
      paths: {
        "/users": {
          post: { "x-zevium-cost": number; "x-zevium-free-tier": number };
        };
      };
    };
    expect(parsed.paths["/users"].post["x-zevium-cost"]).toBe(9);
    expect(parsed.paths["/users"].post["x-zevium-free-tier"]).toBe(10);
  });

  it("keeps numbers as numbers, not strings", () => {
    const r = applyPricingEdit(BASE, {
      path: "/health",
      method: "get",
      cost: 42,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // raw text must contain the bare number, not a quoted string
    expect(r.text).toContain('"x-zevium-cost": 42');
    expect(r.text).not.toContain('"x-zevium-cost": "42"');
  });

  it("matches method case-insensitively", () => {
    const r = applyPricingEdit(BASE, {
      path: "/health",
      method: "GET" as never,
      cost: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.text) as {
      paths: { "/health": { get: { "x-zevium-cost": number } } };
    };
    expect(parsed.paths["/health"].get["x-zevium-cost"]).toBe(2);
  });

  it("preserves top-level key order", () => {
    const r = applyPricingEdit(BASE, {
      path: "/health",
      method: "get",
      cost: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.text) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    expect(keys).toEqual(["openapi", "paths"]);
  });

  it("fails on invalid json", () => {
    expect(
      applyPricingEdit("{not json", { path: "/x", method: "get", cost: 1 }).ok,
    ).toBe(false);
  });

  it("fails when root is not an object", () => {
    expect(
      applyPricingEdit("[1,2,3]", { path: "/x", method: "get", cost: 1 }).ok,
    ).toBe(false);
  });

  it("fails when path is missing", () => {
    expect(
      applyPricingEdit(BASE, { path: "/nope", method: "get", cost: 1 }).ok,
    ).toBe(false);
  });

  it("fails when method is missing", () => {
    expect(
      applyPricingEdit(BASE, { path: "/health", method: "put", cost: 1 }).ok,
    ).toBe(false);
  });

  it("fails when paths is absent", () => {
    expect(
      applyPricingEdit('{"openapi":"3.1.0"}', {
        path: "/x",
        method: "get",
        cost: 1,
      }).ok,
    ).toBe(false);
  });
});
