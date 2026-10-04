// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  failNext: false,
  emptyFirst: false,
  request: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({
    children,
    to,
    params,
  }: {
    children: ReactNode;
    to: string;
    params?: { publisherHandle: string; projectSlug: string };
  }) => (
    <a
      href={
        params
          ? to
              .replace("$publisherHandle", params.publisherHandle)
              .replace("$projectSlug", params.projectSlug)
          : to
      }
    >
      {children}
    </a>
  ),
}));
vi.mock("#/components/motion/fade-in", () => ({
  FadeIn: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@convex-dev/react-query", () => ({
  convexQuery: (_reference: unknown, args: { cursor?: string }) => ({
    queryKey: ["catalogue-test", args],
    queryFn: async () => {
      fixture.request(args);
      if (args.cursor && fixture.failNext)
        throw new Error("Network unavailable");
      const numbers = args.cursor
        ? [24, 25, 26]
        : fixture.emptyFirst
          ? []
          : Array.from({ length: 24 }, (_, index) => index + 1);
      return {
        items: numbers.map((number) => ({
          name: `API ${number}`,
          slug: `api-${number}`,
          publisherHandle: "publisher",
          orgName: "Publisher",
          tags: [],
          publishedAt: 1,
          pricing: null,
          quality: null,
        })),
        nextCursor: args.cursor ? null : "page-2",
        total: 26,
        facets: {
          tags: [
            { name: "weather", count: 1 },
            { name: "retired", count: 0 },
          ],
          freeTierCount: 0,
        },
      };
    },
  }),
}));

import { CatalogueList } from "#/components/catalogue-browser";
import { CatalogueShell } from "#/components/catalogue-shell";

beforeEach(() => {
  fixture.failNext = false;
  fixture.emptyFirst = false;
  fixture.request.mockClear();
});
afterEach(cleanup);

function renderCatalogue(inApp = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const list = (
    <CatalogueList
      search=""
      activeTag={null}
      onTagChange={vi.fn()}
      sort="newest"
      freeOnly={false}
      maxCost={null}
    />
  );
  render(
    <QueryClientProvider client={client}>
      {inApp ? <CatalogueShell inApp>{list}</CatalogueShell> : list}
    </QueryClientProvider>,
  );
}

it("reaches APIs beyond the first 24 and keeps global tag facets accessible", async () => {
  renderCatalogue();
  await screen.findByText("24 APIs shown");
  expect(screen.getByLabelText("Filter by weather")).toBeTruthy();
  expect(screen.queryByLabelText("Filter by retired")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load more APIs" }));
  await screen.findByText("API 26");
  expect(screen.getByText("API 1")).toBeTruthy();
  expect(screen.getAllByText("API 24")).toHaveLength(1);
  expect(screen.getByText("26 APIs shown")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load more APIs" })).toBeNull();
  expect(fixture.request).toHaveBeenCalledWith(
    expect.objectContaining({ cursor: "page-2" }),
  );
});

it("keeps API cards inside the app namespace, including later pages", async () => {
  renderCatalogue(true);
  const firstCard = await screen.findByText("API 1");
  expect(firstCard.closest("a")?.getAttribute("href")).toBe(
    "/app/catalogue/publisher/api-1",
  );
  fireEvent.click(screen.getByText("Load more APIs"));
  const laterCard = await screen.findByText("API 26");
  expect(laterCard.closest("a")?.getAttribute("href")).toBe(
    "/app/catalogue/publisher/api-26",
  );
  expect(laterCard.closest("main")).toBeNull();
});

it("retains existing cards when another page fails and retries that page", async () => {
  fixture.failNext = true;
  renderCatalogue();
  await screen.findByText("24 APIs shown");
  fireEvent.click(screen.getByRole("button", { name: "Load more APIs" }));
  await screen.findByRole("button", { name: "Retry more APIs" });
  expect(screen.getByText("API 1")).toBeTruthy();
  fixture.failNext = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry more APIs" }));
  await screen.findByText("API 26");
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("continues through an empty filtered page instead of claiming no matches", async () => {
  fixture.emptyFirst = true;
  renderCatalogue();
  await screen.findByRole("button", { name: "Load more APIs" });
  expect(screen.queryByText("No public APIs yet")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load more APIs" }));
  await screen.findByText("API 25");
});
