// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { ConvexProvider, ConvexReactClient, useConvex } from "convex/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { ReactNode, ComponentProps } from "react";
import { createPrincipalCache } from "#/lib/principal-cache";

vi.mock("./authenticated-providers", () => ({
  AuthenticatedProviders: ({
    client,
    children,
  }: {
    client: ComponentProps<typeof ConvexProvider>["client"];
    children: ReactNode;
  }) => (
    <ConvexProvider client={client}>
      <div data-testid="authenticated-public-provider">{children}</div>
    </ConvexProvider>
  ),
}));

import { RouteProviders } from "./route-providers";

afterEach(cleanup);

it.each([
  ["/catalogue/publisher/api", "user_qa", true],
  ["/catalogue/publisher/api", null, false],
  ["/catalogue", "user_qa", false],
  ["/docs", "user_qa", false],
])(
  "selects catalogue auth for %s with principal %s",
  async (path, userId, authenticated) => {
    const client = new ConvexReactClient("https://example.convex.cloud");
    const principalCache = createPrincipalCache(() => new QueryClient());
    const root = createRootRoute({
      beforeLoad: () => ({ userId }),
      component: () => (
        <RouteProviders client={client} principalCache={principalCache}>
          <Outlet />
        </RouteProviders>
      ),
    });
    function Consumer() {
      expect(useConvex()).toBe(client);
      return <p>Public content</p>;
    }
    const page = createRoute({
      getParentRoute: () => root,
      path,
      component: Consumer,
    });
    const router = createRouter({
      routeTree: root.addChildren([page]),
      history: createMemoryHistory({ initialEntries: [path] }),
    });
    await router.load();
    render(<RouterProvider router={router} />);
    await screen.findByText("Public content");
    expect(Boolean(screen.queryByTestId("authenticated-public-provider"))).toBe(
      authenticated,
    );
    await client.close();
  },
);

it("keeps the outgoing public Convex consumer mounted until protected navigation commits", async () => {
  const client = new ConvexReactClient("https://example.convex.cloud");
  let finish!: () => void;
  let started!: () => void;
  const loading = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const loaderStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const errors: unknown[] = [];
  function Consumer({ name }: { name: string }) {
    expect(useConvex()).toBe(client);
    return <p>{name}</p>;
  }
  const root = createRootRoute({
    component: () => (
      <RouteProviders client={client}>
        <Outlet />
      </RouteProviders>
    ),
    errorComponent: ({ error }: ErrorComponentProps) => {
      errors.push(error);
      return <p>Provider failed</p>;
    },
  });
  const publicRoute = createRoute({
    getParentRoute: () => root,
    path: "/catalogue",
    component: () => <Consumer name="Catalogue content" />,
  });
  const appRoute = createRoute({
    getParentRoute: () => root,
    path: "/app",
    pendingMs: Infinity,
    loader: async () => {
      started();
      await loading;
    },
    component: () => (
      <ConvexProvider client={client}>
        <Consumer name="Account content" />
      </ConvexProvider>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([publicRoute, appRoute]),
    history: createMemoryHistory({ initialEntries: ["/catalogue"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByText("Catalogue content");
  let navigation!: Promise<void>;
  await act(async () => {
    navigation = router.navigate({ to: "/app" });
    await loaderStarted;
  });
  expect(router.state.location.pathname).toBe("/app");
  expect(screen.getByText("Catalogue content")).toBeTruthy();
  expect(errors).toEqual([]);
  await act(async () => {
    finish();
    await navigation;
  });
  await screen.findByText("Account content");
  await act(async () => {
    await router.navigate({ to: "/catalogue" });
  });
  await waitFor(() =>
    expect(screen.getByText("Catalogue content")).toBeTruthy(),
  );
  expect(errors).toEqual([]);
  await client.close();
});
