import { afterEach, describe, expect, it, vi } from "vitest";

import {
  prefersReducedMotion,
  routeViewTransitionTypes,
} from "./view-transition";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubMotionPreference(reduced: boolean) {
  vi.stubGlobal("window", {
    matchMedia: vi.fn().mockReturnValue({ matches: reduced }),
  });
}

describe("route view-transition policy", () => {
  it("fully disables browser view transitions for reduced motion", () => {
    stubMotionPreference(true);

    expect(prefersReducedMotion()).toBe(true);
    expect(
      routeViewTransitionTypes({
        fromIndex: 1,
        toIndex: 2,
        fromPath: "/catalogue",
        toPath: "/catalogue/acme/weather",
      }),
    ).toBe(false);
  });

  it("preserves direction and list-detail morph types otherwise", () => {
    stubMotionPreference(false);

    expect(
      routeViewTransitionTypes({
        fromIndex: 2,
        toIndex: 1,
        fromPath: "/app/billing",
        toPath: "/app/settings",
      }),
    ).toEqual(["navigate-back", "nav-swap"]);
    expect(
      routeViewTransitionTypes({
        fromIndex: 1,
        toIndex: 2,
        fromPath: "/catalogue",
        toPath: "/catalogue/acme/weather",
      }),
    ).toEqual(["navigate-forward"]);
  });
});
