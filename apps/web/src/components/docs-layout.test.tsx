// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Route as GettingStarted } from "#/routes/docs/index";
import { Route as Publishing } from "#/routes/docs/publishing";
import { Route as Consuming } from "#/routes/docs/consuming";
import { Route as Agents } from "#/routes/docs/agents";

vi.mock("#/components/theme-toggle", () => ({ ThemeToggle: () => null }));
beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("documentation landmarks", () => {
  it.each([
    ["/docs", GettingStarted],
    ["/docs/publishing", Publishing],
    ["/docs/consuming", Consuming],
    ["/docs/agents", Agents],
  ] as const)(
    "gives %s one main landmark and a focusable skip target",
    async (path, source) => {
      const root = createRootRoute();
      const page = createRoute({
        getParentRoute: () => root,
        path,
        component: source.options.component,
      });
      const router = createRouter({
        routeTree: root.addChildren([page]),
        history: createMemoryHistory({ initialEntries: [path] }),
      });
      await router.load();
      const { container } = render(<RouterProvider router={router} />);
      const main = await screen.findByRole("main");
      expect(screen.getAllByRole("main")).toHaveLength(1);
      expect(within(main).getByRole("article")).toBeTruthy();
      expect(within(main).getAllByRole("heading", { level: 1 })).toHaveLength(
        1,
      );
      expect(container.querySelectorAll("#main-content")).toHaveLength(1);
      expect(
        screen
          .getByRole("link", { name: "Skip to content" })
          .getAttribute("href"),
      ).toBe(`#${main.id}`);
      main.focus();
      expect(document.activeElement).toBe(main);
    },
  );
});
