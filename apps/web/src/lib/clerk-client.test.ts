import { afterEach, describe, expect, it, vi } from "vitest";

import { readClientClerkAuth } from "./clerk-client";

const fallback = {
  userId: "user_stale",
  orgId: "org_stale",
  orgSlug: "stale",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readClientClerkAuth", () => {
  it("uses router context while Clerk is unhydrated", () => {
    vi.stubGlobal("window", { Clerk: undefined });

    expect(readClientClerkAuth(fallback)).toEqual(fallback);
  });

  it("does not resurrect router context after Clerk signs out", () => {
    vi.stubGlobal("window", {
      Clerk: { user: null, organization: null, session: null },
    });

    expect(readClientClerkAuth(fallback)).toEqual({
      userId: null,
      orgId: null,
      orgSlug: null,
    });
  });
});
