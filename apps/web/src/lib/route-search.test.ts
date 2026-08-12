import { MAX_ENDPOINT_COST_CREDITS } from "@zevium/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import {
  REVIEW_QUEUE_MODES,
  catalogueSearchSchema,
  parseCatalogueMaxInput,
  reviewModerationSearchSchema,
  reviewQueueMode,
} from "#/lib/route-search";

describe("catalogue URL search boundary", () => {
  it("accepts only bounded safe-integer maximum costs", () => {
    expect(catalogueSearchSchema.parse({ max: 0 }).max).toBe(0);
    expect(
      catalogueSearchSchema.parse({ max: String(MAX_ENDPOINT_COST_CREDITS) })
        .max,
    ).toBe(MAX_ENDPOINT_COST_CREDITS);

    for (const max of [
      -1,
      1.5,
      "1e3",
      "Infinity",
      Number.MAX_SAFE_INTEGER + 1,
      String(Number.MAX_SAFE_INTEGER + 1),
      MAX_ENDPOINT_COST_CREDITS + 1,
      {},
    ]) {
      expect(catalogueSearchSchema.parse({ max }).max).toBeUndefined();
    }
  });

  it("validates input writes with the same integer and product bound", () => {
    expect(parseCatalogueMaxInput("")).toBeNull();
    expect(parseCatalogueMaxInput("00012")).toBe(12);
    expect(parseCatalogueMaxInput(String(MAX_ENDPOINT_COST_CREDITS))).toBe(
      MAX_ENDPOINT_COST_CREDITS,
    );
    expect(parseCatalogueMaxInput("1.2")).toBeUndefined();
    expect(
      parseCatalogueMaxInput(String(MAX_ENDPOINT_COST_CREDITS + 1)),
    ).toBeUndefined();
    expect(
      parseCatalogueMaxInput(String(Number.MAX_SAFE_INTEGER + 1)),
    ).toBeUndefined();
  });

  it("replays real router deep-link, refresh, back, and forward state", async () => {
    const makeRouter = (initialEntry: string) => {
      const root = createRootRoute();
      const catalogue = createRoute({
        getParentRoute: () => root,
        path: "/catalogue",
        validateSearch: catalogueSearchSchema,
      });
      return createRouter({
        routeTree: root.addChildren([catalogue]),
        history: createMemoryHistory({ initialEntries: [initialEntry] }),
      });
    };
    const router = makeRouter("/catalogue?q=first&max=10&sort=name");
    await router.load();
    expect(router.state.location.search).toMatchObject({
      q: "first",
      max: 10,
      sort: "name",
    });

    const refreshed = makeRouter(router.state.location.href);
    await refreshed.load();
    expect(refreshed.state.location.search).toEqual(
      router.state.location.search,
    );

    await router.navigate({
      to: "/catalogue",
      search: { q: "second", max: 20, free: true },
    });
    await router.navigate({
      to: "/catalogue",
      search: { q: "third", max: 30, semantic: true },
    });
    expect(router.state.location.search).toMatchObject({
      q: "third",
      max: 30,
      semantic: true,
    });

    router.history.back();
    await router.load();
    expect(router.state.location.search).toMatchObject({
      q: "second",
      max: 20,
      free: true,
    });
    router.history.back();
    await router.load();
    expect(router.state.location.search).toMatchObject({
      q: "first",
      max: 10,
      sort: "name",
    });
    router.history.forward();
    await router.load();
    expect(router.state.location.search).toMatchObject({
      q: "second",
      max: 20,
      free: true,
    });
  });
});

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
