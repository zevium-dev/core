// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    to,
    params,
  }: {
    children: ReactNode;
    to: string;
    params: { publisherHandle: string; projectSlug: string };
  }) => (
    <a
      href={to
        .replace("$publisherHandle", params.publisherHandle)
        .replace("$projectSlug", params.projectSlug)}
    >
      {children}
    </a>
  ),
}));
vi.mock("#/components/motion/fade-in", () => ({
  FadeIn: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@convex-dev/react-query", () => ({
  convexQuery: (_reference: unknown, args: unknown) => ({
    queryKey: ["catalogue", args],
    queryFn: async () => [
      { name: "weather", count: 1 },
      { name: "retired", count: 0 },
    ],
  }),
}));

import { CatalogueList } from "#/components/catalogue-browser";
import { CatalogueShell } from "#/components/catalogue-shell";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fixture({ emptyFirst = false } = {}) {
  const client = new ConvexReactClient("https://test.convex.cloud", {
    disabled: true,
  });
  const listeners = new Set<() => void>();
  const card = (id: number, name = `API ${id}`) => ({
    name,
    slug: `api-${id}`,
    publisherHandle: "publisher",
    orgName: "Publisher",
    tags: [],
    publishedAt: 1,
    pricing: null,
    quality: null,
  });
  let first = {
    page: emptyFirst ? [] : [card(1), card(2)],
    isDone: false,
    continueCursor: "page-2",
  };
  let second = { page: [card(3)], isDone: true, continueCursor: "end" };
  const filtered = {
    page: [card(4)],
    isDone: true,
    continueCursor: "filtered-end",
  };
  const requests: Array<{ search?: string; cursor: unknown }> = [];
  vi.spyOn(client, "watchQuery").mockImplementation((_query, args) => {
    const input = args as {
      search?: string;
      paginationOpts: { cursor: string | null };
    };
    requests.push({
      search: input.search,
      cursor: input.paginationOpts.cursor,
    });
    return {
      onUpdate(callback) {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
      localQueryResult: () =>
        input.search ? filtered : input.paginationOpts.cursor ? second : first,
      localQueryLogs: () => undefined,
      journal: () => undefined,
    };
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (search: string) => (
    <QueryClientProvider client={queryClient}>
      <ConvexProvider client={client}>
        <CatalogueShell inApp>
          <CatalogueList
            search={search}
            activeTag={null}
            onTagChange={vi.fn()}
            sort="newest"
            freeOnly={false}
            maxCost={null}
          />
        </CatalogueShell>
      </ConvexProvider>
    </QueryClientProvider>
  );
  const view = render(tree(""));
  return {
    requests,
    filter: (search: string) => view.rerender(tree(search)),
    update: () =>
      act(() => {
        first = { ...first, page: [card(5), card(1, "Updated API 1")] };
        second = { ...second, page: [card(2), card(3, "Updated API 3")] };
        for (const listener of listeners) listener();
      }),
  };
}

it("keeps every loaded page live, including edits, insertions and moved boundaries", async () => {
  const state = fixture();
  await screen.findByText("2 APIs shown");
  expect(await screen.findByLabelText("Filter by weather")).toBeTruthy();
  expect(screen.queryByLabelText("Filter by retired")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load more APIs" }));
  await screen.findByText("3 APIs shown");
  expect(screen.getByText("API 3").closest("a")?.getAttribute("href")).toBe(
    "/app/catalogue/publisher/api-3",
  );
  state.update();
  expect(screen.getByText("Updated API 1")).toBeTruthy();
  expect(screen.getByText("Updated API 3")).toBeTruthy();
  expect(screen.getAllByText("API 2")).toHaveLength(1);
  expect(screen.getByText("API 5")).toBeTruthy();
  expect(screen.getByText("4 APIs shown")).toBeTruthy();
});

it("resets filters in the same render without issuing a stale-cursor query", async () => {
  const state = fixture();
  fireEvent.click(
    await screen.findByRole("button", { name: "Load more APIs" }),
  );
  await screen.findByText("API 3");
  state.filter("weather");
  expect(screen.queryByText("API 1")).toBeNull();
  expect(screen.getByText("API 4")).toBeTruthy();
  expect(
    state.requests
      .filter((request) => request.search === "weather")
      .every((request) => request.cursor === null),
  ).toBe(true);
  state.filter("");
  expect(screen.queryByText("API 3")).toBeNull();
  expect(screen.getByText("2 APIs shown")).toBeTruthy();
});

it("continues through an empty filtered page", async () => {
  fixture({ emptyFirst: true });
  fireEvent.click(
    await screen.findByRole("button", { name: "Load more APIs" }),
  );
  expect(await screen.findByText("API 3")).toBeTruthy();
});
