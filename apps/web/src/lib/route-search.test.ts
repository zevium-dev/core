// @vitest-environment jsdom

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import {
  REVIEW_QUEUE_MODES,
  reviewModerationSearchSchema,
  reviewQueueMode,
} from "#/lib/route-search";

describe("admin moderation tab URL boundary", () => {
  it("deep-links and refreshes every tab, then preserves real back/forward order", async () => {
    const makeRouter = (initialEntry: string) => {
      const root = createRootRoute();
      const reviews = createRoute({
        getParentRoute: () => root,
        path: "/admin/reviews",
        validateSearch: reviewModerationSearchSchema,
      });
      return createRouter({
        isServer: false,
        routeTree: root.addChildren([reviews]),
        history: createMemoryHistory({ initialEntries: [initialEntry] }),
      });
    };
    for (const tab of REVIEW_QUEUE_MODES) {
      const deepLink = makeRouter(`/admin/reviews?tab=${tab}`);
      await deepLink.load();
      expect(reviewQueueMode(deepLink.state.location.search)).toBe(tab);
      const refreshed = makeRouter(deepLink.state.location.href);
      await refreshed.load();
      expect(reviewQueueMode(refreshed.state.location.search)).toBe(tab);
    }

    const router = makeRouter("/admin/reviews?tab=active");
    await router.load();
    for (const tab of ["hidden", "reported", "history"] as const) {
      await router.navigate({
        to: "/admin/reviews",
        search: { tab },
      });
    }
    expect(reviewQueueMode(router.state.location.search)).toBe("history");
    router.history.back();
    await router.load();
    expect(reviewQueueMode(router.state.location.search)).toBe("reported");
    router.history.back();
    await router.load();
    expect(reviewQueueMode(router.state.location.search)).toBe("hidden");
    router.history.forward();
    await router.load();
    expect(reviewQueueMode(router.state.location.search)).toBe("reported");
    router.history.forward();
    await router.load();
    expect(reviewQueueMode(router.state.location.search)).toBe("history");
  });

  it("defaults invalid and absent tabs to reported", () => {
    expect(reviewQueueMode(reviewModerationSearchSchema.parse({}))).toBe(
      "reported",
    );
    expect(
      reviewQueueMode(reviewModerationSearchSchema.parse({ tab: "garbage" })),
    ).toBe("reported");
  });
});
