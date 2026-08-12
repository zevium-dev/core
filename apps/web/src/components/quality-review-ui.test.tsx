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
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  aggregateError: false,
  viewerError: false,
  viewer: {
    signedIn: true,
    canReview: true,
    isPublisher: false,
    reason: "Eligible verified consumer",
    review: null as null | {
      _id: string;
      active: boolean;
      rating: number;
      body?: string;
      updatedAt: number;
      hidden: boolean;
    },
  },
  reviews: [] as Array<{
    id: string;
    rating: 1 | 2 | 3 | 4 | 5;
    body: string | null;
    createdAt: number;
    updatedAt: number;
    reviewerLabel: string;
    response: null;
  }>,
  status: "Exhausted" as "Exhausted" | "CanLoadMore" | "LoadingMore",
  loadMore: vi.fn(),
  save: vi.fn(),
  withdraw: vi.fn(),
  report: vi.fn(),
  respond: vi.fn(),
  queryInvocation: 0,
  mutationInvocation: 0,
}));

vi.mock("@convex-dev/react-query", () => ({
  convexQuery: (reference: unknown, args: unknown) => {
    void reference;
    const name =
      state.queryInvocation++ % 2 === 0 ? "getAggregate" : "getViewerState";
    return {
      queryKey: [name, args],
      queryFn: async () => {
        if (name.includes("getAggregate")) {
          if (state.aggregateError) throw new Error("aggregate failed");
          return {
            count: 0,
            averageRating: null,
            distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
          };
        }
        if (state.viewerError) throw new Error("viewer failed");
        return state.viewer;
      },
    };
  },
  useConvexMutation: (reference: unknown) => {
    void reference;
    const mutations = [state.save, state.withdraw, state.report, state.respond];
    return mutations[state.mutationInvocation++ % mutations.length];
  },
}));

vi.mock("convex/react", () => ({
  usePaginatedQuery: () => ({
    results: state.reviews,
    status: state.status,
    loadMore: state.loadMore,
  }),
}));

import { QualityBadges } from "./quality-badges";
import { ReviewSection } from "./review-section";

function Providers({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(cleanup);
beforeEach(() => {
  state.aggregateError = false;
  state.viewerError = false;
  state.reviews = [];
  state.status = "Exhausted";
  state.loadMore.mockReset();
  state.save.mockReset();
  state.withdraw.mockReset();
  state.report.mockReset();
  state.respond.mockReset();
  state.queryInvocation = 0;
  state.mutationInvocation = 0;
  state.save.mockResolvedValue({});
  state.withdraw.mockResolvedValue({});
  state.report.mockResolvedValue({ reported: true });
  state.respond.mockResolvedValue({});
});

describe("quality and real review surface", () => {
  it("shows exact evidence floors and distinct metrics", () => {
    const { rerender } = render(<QualityBadges quality={null} />);
    expect(screen.getByLabelText("API quality evidence").textContent).toContain(
      "0/20",
    );
    expect(screen.getByLabelText("API quality evidence").textContent).toContain(
      "0/3",
    );
    rerender(
      <QualityBadges
        quality={{
          reachabilitySampleSize: 5,
          reachabilityMinimumSampleSize: 3,
          reachabilityPercent: 80,
          reachabilityLatencyP50Ms: 12,
          insufficientReachabilityData: false,
          apiSampleSize: 20,
          apiMinimumSampleSize: 20,
          apiSuccessRatePercent: 75,
          apiLatencyP50Ms: 42,
          insufficientApiData: false,
          lastProbeOutcome: "healthy",
          lastProbedAt: 100,
          freshness: {
            publishedAt: 1,
            measuredAt: 100,
            ageMs: 0,
            status: "fresh",
          },
        }}
      />,
    );
    expect(screen.getByText(/API success 75.0%/)).toBeTruthy();
    expect(screen.getByText(/Reachability 80.0%/)).toBeTruthy();
  });

  it("loads realtime pages through native hook without corrupting page shape", async () => {
    state.reviews = [
      {
        id: "review-1",
        rating: 5,
        body: "Works",
        createdAt: Date.UTC(2026, 0, 2),
        updatedAt: 1,
        reviewerLabel: "Verified consumer",
        response: null,
      },
    ];
    state.status = "CanLoadMore";
    const view = render(<ReviewSection projectId={"project" as never} />, {
      wrapper: Providers,
    });
    expect(await screen.findByText("Works")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more reviews" }));
    expect(state.loadMore).toHaveBeenCalledWith(10);
    state.reviews = [
      ...state.reviews,
      { ...state.reviews[0]!, id: "review-2", body: "Realtime" },
    ];
    state.status = "Exhausted";
    await act(async () =>
      view.rerender(
        <Providers>
          <ReviewSection projectId={"project" as never} />
        </Providers>,
      ),
    );
    expect(screen.getByText("Realtime")).toBeTruthy();
  });

  it("offers eligibility retry and focuses inline mutation failure", async () => {
    state.viewerError = true;
    const view = render(<ReviewSection projectId={"project" as never} />, {
      wrapper: Providers,
    });
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    state.viewerError = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Publish review" }),
      ).toBeTruthy(),
    );
    state.save.mockRejectedValueOnce(new Error("Settlement proof expired"));
    fireEvent.click(screen.getByRole("button", { name: "Publish review" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Settlement proof expired");
    expect(document.activeElement).toBe(alert);
    view.unmount();
  });

  it("keeps report failure associated inside modal and focuses it", async () => {
    state.reviews = [
      {
        id: "review-report",
        rating: 1,
        body: "Suspicious",
        createdAt: Date.UTC(2026, 0, 2),
        updatedAt: 1,
        reviewerLabel: "Verified consumer",
        response: null,
      },
    ];
    state.report.mockRejectedValueOnce(new Error("Report quota reached"));
    render(<ReviewSection projectId={"project" as never} />, {
      wrapper: Providers,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Report review" }),
    );
    const reason = await screen.findByLabelText("Reason");
    fireEvent.change(reason, {
      target: { value: "This review contains abusive content" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit report" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Report quota reached");
    expect(reason.getAttribute("aria-describedby")).toBe("report-error");
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });
});
