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
import { afterEach, expect, it } from "vitest";

import { RouteProviders } from "./route-providers";

afterEach(cleanup);

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
