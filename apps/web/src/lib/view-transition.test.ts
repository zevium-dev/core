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

  it.each([
    ["/catalogue", "/catalogue/acme/weather"],
    ["/app/projects", "/app/projects/weather"],
  ])("preserves morphs to and from %s", (list, detail) => {
    stubMotionPreference(false);
    expect(
      routeViewTransitionTypes({
        fromIndex: 1,
        toIndex: 2,
        fromPath: list,
        toPath: detail,
      }),
    ).toEqual(["navigate-forward"]);
    expect(
      routeViewTransitionTypes({
        fromIndex: 2,
        toIndex: 1,
        fromPath: detail,
        toPath: list,
      }),
    ).toEqual(["navigate-back"]);
  });

  it.each([
    ["/app/projects/weather", "/app/billing"],
    ["/app/settings", "/app/projects/weather"],
    ["/app/projects/weather", "/app/projects/other"],
    ["/app/projects", "/app/projects/create"],
    ["/catalogue/acme/weather", "/docs"],
    ["/catalogue/acme/weather", "/catalogue/acme/other"],
    ["/", "/catalogue"],
  ])("keeps unrelated %s → %s on one page surface", (fromPath, toPath) => {
    stubMotionPreference(false);
    expect(
      routeViewTransitionTypes({ fromIndex: 1, toIndex: 2, fromPath, toPath }),
    ).toEqual(["navigate-forward", "nav-swap"]);
  });

  it("preserves the same project's title into its spec editor", () => {
    stubMotionPreference(false);
    expect(
      routeViewTransitionTypes({
        fromIndex: 1,
        toIndex: 2,
        fromPath: "/app/projects/weather/",
        toPath: "/app/projects/weather/spec",
      }),
    ).toEqual(["navigate-forward"]);
  });

  it("leaves Clerk hashes and same-page changes to the mounted UI", () => {
    stubMotionPreference(false);
    expect(
      routeViewTransitionTypes({
        fromIndex: 1,
        toIndex: 2,
        fromPath: "/app/settings/",
        toPath: "/app/settings",
      }),
    ).toBe(false);
  });
});
