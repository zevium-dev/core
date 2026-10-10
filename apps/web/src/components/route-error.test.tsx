// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vitest";

import { RouteError, routeErrorReference } from "./route-error";

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

afterEach(cleanup);

it("keeps one main landmark and skip-link target when a child route fails", async () => {
  const root = createRootRoute({
    component: () => (
      <main id="main-content">
        <Outlet />
      </main>
    ),
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/app",
    loader: () => {
      throw new Error("private database details");
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/app"] }),
    defaultErrorComponent: RouteError,
  });
  await router.load();
  const { container } = render(<RouterProvider router={router} />);
  await screen.findByText("This view could not be loaded");
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(container.querySelectorAll("#main-content")).toHaveLength(1);
  expect(container.textContent).not.toContain("private database details");
});
