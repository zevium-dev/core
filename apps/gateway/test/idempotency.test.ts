import { describe, expect, it } from "vitest";
import { scopeUpstreamIdempotencyKey } from "../src/idempotency";

const scope = {
  consumerOrgId: "org_buyer",
  projectId: "project_orders",
  method: "POST",
  upstreamUrl: "https://vendor.test/orders?mode=live",
};

describe("upstream idempotency namespace", () => {
  it("preserves retries without forwarding raw caller labels", async () => {
    const key = await scopeUpstreamIdempotencyKey("order-42", scope);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("order-42");
    expect(await scopeUpstreamIdempotencyKey("order-42", scope)).toBe(key);
    expect(
      await scopeUpstreamIdempotencyKey("order-42", {
        ...scope,
        method: "post",
      }),
    ).toBe(key);
  });

  it("isolates consumers, projects, methods, concrete targets, and caller labels", async () => {
    const key = await scopeUpstreamIdempotencyKey("order-42", scope);
    for (const changed of [
      { ...scope, consumerOrgId: "org_other_buyer" },
      { ...scope, projectId: "project_other" },
      { ...scope, method: "PUT" },
      { ...scope, upstreamUrl: "https://vendor.test/orders/42?mode=live" },
      { ...scope, upstreamUrl: "https://vendor.test/orders?mode=test" },
      { ...scope, upstreamUrl: "https://other-vendor.test/orders?mode=live" },
    ]) {
      expect(await scopeUpstreamIdempotencyKey("order-42", changed)).not.toBe(
        key,
      );
    }
    expect(await scopeUpstreamIdempotencyKey("order-43", scope)).not.toBe(key);
  });

  it("keeps tuple boundaries distinct for labels containing delimiters", async () => {
    const left = await scopeUpstreamIdempotencyKey("retry", {
      ...scope,
      consumerOrgId: "org|project",
      projectId: "one",
    });
    const right = await scopeUpstreamIdempotencyKey("retry", {
      ...scope,
      consumerOrgId: "org",
      projectId: "project|one",
    });
    expect(left).not.toBe(right);
  });
});
