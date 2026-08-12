import { describe, expect, it } from "vitest";

import { validateActivitySearch } from "./activity";

describe("activity route search boundary", () => {
  it("normalizes bounded public refs and opaque event ids", () => {
    expect(
      validateActivitySearch({
        range: "24h",
        project: "publisher/weather",
        member: "user_colleague",
        method: "post",
        event: "usage_public_event",
      }),
    ).toEqual({
      range: "24h",
      project: "publisher/weather",
      member: "user_colleague",
      method: "POST",
      event: "usage_public_event",
    });
  });

  it("drops oversized deep-link and attribution probes", () => {
    expect(
      validateActivitySearch({
        project: "p".repeat(129),
        member: "m".repeat(129),
        endpoint: "e".repeat(513),
        method: "x".repeat(17),
        event: "i".repeat(129),
      }),
    ).toEqual({});
  });
});
