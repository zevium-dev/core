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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  queueError: false,
  moderate: vi.fn(),
  queue: {
    page: [
      {
        kind: "review" as const,
        item: {
          reviewId: "review-1",
          rating: 2,
          body: "Broken contract",
          active: true,
          hidden: false,
          createdAt: Date.UTC(2026, 0, 1),
          projectName: "Weather API",
          publisherName: "Publisher",
          response: null,
          reportCount: 2,
          reports: [
            { reason: "Misleading response", at: Date.UTC(2026, 0, 2) },
          ],
          latestAction: null,
        },
      },
    ],
    nextCursor: null,
  },
}));

vi.mock("@convex-dev/react-query", () => ({
  convexQuery: () => ({
    queryKey: ["moderation-queue"],
    queryFn: async () => {
      if (state.queueError) throw new Error("queue unavailable");
      return state.queue;
    },
  }),
  useConvexMutation: () => state.moderate,
}));

import { AdminReviewsQueue } from "./-reviews-ui";

function Providers({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(cleanup);
beforeEach(() => {
  state.queueError = false;
  state.moderate.mockReset();
  state.moderate.mockResolvedValue({});
});

describe("actual moderation route surface", () => {
  it("recovers queue query through visible retry", async () => {
    state.queueError = true;
    render(<AdminReviewsQueue mode="reported" onModeChange={vi.fn()} />, {
      wrapper: Providers,
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Moderation queue could not be loaded",
    );
    state.queueError = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Broken contract")).toBeTruthy();
    expect(screen.getByText("2 open reports")).toBeTruthy();
  });

  it("associates and focuses inline moderation failure", async () => {
    state.moderate.mockRejectedValueOnce(new Error("Audit store unavailable"));
    render(<AdminReviewsQueue mode="reported" onModeChange={vi.fn()} />, {
      wrapper: Providers,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Hide review" }));
    const reason = await screen.findByLabelText("Reason");
    fireEvent.change(reason, { target: { value: "Policy violation" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm action" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Audit store unavailable");
    expect(reason.getAttribute("aria-describedby")).toBe("moderation-error");
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });

  it("keeps every visible tab controlled by route-owned mode", async () => {
    const onModeChange = vi.fn();
    const rendered = render(
      <AdminReviewsQueue mode="reported" onModeChange={onModeChange} />,
      { wrapper: Providers },
    );
    for (const [mode, label] of [
      ["active", "Active"],
      ["hidden", "Hidden"],
      ["reported", "Reported"],
      ["history", "History"],
    ] as const) {
      rendered.rerender(
        <AdminReviewsQueue mode={mode} onModeChange={onModeChange} />,
      );
      expect(
        (await screen.findByRole("tab", { name: label })).getAttribute(
          "data-state",
        ),
      ).toBe("active");
    }
  });
});
