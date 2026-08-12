import { describe, expect, it } from "vitest";

import { routeErrorReference } from "./route-error";

describe("routeErrorReference", () => {
  it("returns only bounded request identifiers", () => {
    expect(routeErrorReference({ requestId: "req_01:abc" })).toBe("req_01:abc");
    expect(routeErrorReference({ cause: { requestId: "nested.2" } })).toBe(
      "nested.2",
    );
    expect(routeErrorReference({ requestId: "<script>" })).toBeNull();
    expect(routeErrorReference(new Error("database secret"))).toBeNull();
  });
});
