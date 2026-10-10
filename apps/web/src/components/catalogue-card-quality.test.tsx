// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { QualitySnapshotContract } from "@zevium/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/catalogue/publisher/api">{children}</a>
  ),
}));

import { CatalogueCard } from "./catalogue-browser";
import { QualityBadges } from "./quality-badges";

const quality: QualitySnapshotContract = {
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
  freshness: { publishedAt: 1, measuredAt: 100, ageMs: 0, status: "fresh" },
};
const item = {
  name: "Quality API",
  slug: "api",
  description: "API description",
  tags: [],
  orgName: "Publisher",
  publisherHandle: "publisher",
  publishedAt: 1,
  pricing: { minCost: 1, maxCost: 1, endpointCount: 1, hasFreeTier: false },
  quality,
};
afterEach(cleanup);

describe("catalogue card quality", () => {
  it("renders the same metrics as detail without needing query providers", () => {
    const { unmount } = render(<QualityBadges quality={quality} />);
    const evidence = screen.getByLabelText("API quality evidence").textContent;
    unmount();
    render(<CatalogueCard item={item} />);
    expect(screen.getByLabelText("API quality evidence").textContent).toBe(
      evidence,
    );
    expect(screen.getByText("API success 75.0% · 42 ms p50")).toBeTruthy();
    expect(screen.getByText("Reachability 80.0% · 12 ms p50")).toBeTruthy();
    expect(screen.getByText(/not paid operations/)).toBeTruthy();
  });
  it("shows absent and below-floor data honestly", () => {
    const { rerender } = render(
      <CatalogueCard item={{ ...item, quality: null }} />,
    );
    expect(
      screen.getByText("API quality: insufficient data (0/20)"),
    ).toBeTruthy();
    expect(
      screen.getByText("Reachability: insufficient data (0/3)"),
    ).toBeTruthy();
    rerender(
      <CatalogueCard
        item={{
          ...item,
          score: 0.9,
          quality: {
            ...quality,
            apiSampleSize: 19,
            reachabilitySampleSize: 2,
            insufficientApiData: true,
            insufficientReachabilityData: true,
          },
        }}
      />,
    );
    expect(
      screen.getByText("API quality: insufficient data (19/20)"),
    ).toBeTruthy();
    expect(
      screen.getByText("Reachability: insufficient data (2/3)"),
    ).toBeTruthy();
    expect(screen.queryByText(/API success/)).toBeNull();
  });
  it.each([undefined, null, NaN, Infinity])(
    "never prints invalid percentages (%s)",
    (invalid) => {
      // Exercise malformed legacy payloads at runtime as well as the typed contract.
      const malformed = {
        ...quality,
        apiSuccessRatePercent: invalid,
        reachabilityPercent: invalid,
      } as QualitySnapshotContract;
      render(<CatalogueCard item={{ ...item, quality: malformed }} />);
      expect(screen.getAllByText(/insufficient data/)).toHaveLength(2);
      expect(screen.queryByText(/undefined%|NaN%|Infinity%|0.0%/)).toBeNull();
    },
  );
});
