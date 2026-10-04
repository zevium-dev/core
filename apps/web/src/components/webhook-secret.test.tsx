// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "#/lib/convex-data-model";

const state = vi.hoisted(() => ({ rotate: vi.fn(), reveal: vi.fn() }));
vi.mock("@convex-dev/react-query", () => ({
  convexQuery: (reference: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(reference);
    return {
      queryKey: [name],
      queryFn: async () =>
        name.endsWith("getEndpoint")
          ? {
              url: "https://example.com/hooks",
              active: true,
              secretVersion: 1,
              createdAt: 1,
            }
          : { page: [] },
    };
  },
  useConvexMutation: (reference: Parameters<typeof getFunctionName>[0]) =>
    getFunctionName(reference).endsWith("rotateSecret")
      ? state.rotate
      : state.reveal,
}));
import { WebhooksCard } from "./project-settings-panel";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
const project: Doc<"projects"> = {
  _id: "project_qa" as Id<"projects">,
  _creationTime: 1,
  organizationId: "org_qa" as Id<"organizations">,
  name: "QA",
  slug: "qa",
  status: "published",
  visibility: "public",
  tags: [],
};
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <WebhooksCard project={project} />
    </QueryClientProvider>,
  );
  return client;
}
function metadata(version: number) {
  return {
    url: "https://example.com/hooks",
    active: true,
    secretVersion: version,
    createdAt: 1,
  };
}

describe("one-time webhook secrets", () => {
  it.each(["before", "after"])(
    "keeps rotated secret when realtime metadata arrives %s response",
    async (order) => {
      const client = setup();
      await screen.findByRole("button", { name: "Rotate" });
      state.rotate.mockImplementation(async () => {
        if (order === "before")
          await act(async () => {
            client.setQueryData(["webhooks:getEndpoint"], metadata(2));
          });
        return { secret: "qa-rotated-secret", secretVersion: 2 };
      });
      fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
      await waitFor(() =>
        expect(
          (screen.getByLabelText("Webhook signing secret") as HTMLInputElement)
            .value,
        ).toBe("qa-rotated-secret"),
      );
      if (order === "after")
        await act(async () => {
          client.setQueryData(["webhooks:getEndpoint"], metadata(2));
        });
      expect(
        (screen.getByLabelText("Webhook signing secret") as HTMLInputElement)
          .value,
      ).toBe("qa-rotated-secret");
      expect(
        screen
          .getByRole("button", { name: "Copy secret" })
          .hasAttribute("disabled"),
      ).toBe(false);
      await act(async () => {
        client.setQueryData(["webhooks:getEndpoint"], metadata(3));
      });
      await waitFor(() =>
        expect(
          (screen.getByLabelText("Webhook signing secret") as HTMLInputElement)
            .value,
        ).toMatch(/^•+$/),
      );
    },
  );
  it("drops plaintext when hidden and does not restore it through realtime updates", async () => {
    const client = setup();
    state.reveal.mockResolvedValue({ secret: "qa-revealed-secret" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Reveal secret" }),
    );
    await screen.findByRole("button", { name: "Hide secret" });
    fireEvent.click(screen.getByRole("button", { name: "Hide secret" }));
    await act(async () => {
      client.setQueryData(["webhooks:getEndpoint"], {
        ...metadata(1),
        active: false,
      });
    });
    expect(
      (screen.getByLabelText("Webhook signing secret") as HTMLInputElement)
        .value,
    ).toMatch(/^•+$/);
  });
});
