import { describe, expect, it } from "vitest";

import { getApiKeyLifecycle } from "./api-key-lifecycle";

describe("getApiKeyLifecycle", () => {
  const now = 10_000;

  it("distinguishes current, grace-only, expired, and disabled keys", () => {
    expect(getApiKeyLifecycle(undefined, now)).toBe("current");
    expect(
      getApiKeyLifecycle({ disabled: false, graceUntil: now + 1 }, now),
    ).toBe("grace");
    expect(getApiKeyLifecycle({ disabled: false, graceUntil: now }, now)).toBe(
      "expired",
    );
    expect(
      getApiKeyLifecycle({ disabled: true, graceUntil: now + 1 }, now),
    ).toBe("disabled");
  });
});
