// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FunctionReturnType } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "#/lib/convex-api";
import type { Id } from "#/lib/convex-data-model";

const query = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@convex-dev/react-query", () => ({
  convexQuery: (_reference: unknown, args: unknown) => ({
    queryKey: ["publisher-quality", args],
    queryFn: query.fn,
  }),
}));
import { ProjectQualityPanel } from "./project-quality-panel";

const data: FunctionReturnType<typeof api.quality.getPublisherQuality> = {
  version: "1.0.0",
  quality: null,
  status: "recovering",
  suspensionReason: "The health endpoint failed 3 of its last 5 checks",
  suspendedAt: 100,
  recoveryPasses: 2,
  recoveryRequired: 3,
  probeIntervalMs: 300_000,
  historyLimit: 24,
  probes: [
    {
      id: "probe-2" as Id<"qualityProbeResults">,
      checkedAt: 200,
      outcome: "healthy",
      statusCode: 204,
      latencyMs: 20,
    },
    {
      id: "probe-1" as Id<"qualityProbeResults">,
      checkedAt: 100,
      outcome: "timeout",
      statusCode: null,
      latencyMs: 8000,
    },
  ],
};
function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProjectQualityPanel projectId={"project" as Id<"projects">} />
    </QueryClientProvider>,
  );
}
afterEach(cleanup);
beforeEach(() => query.fn.mockReset());

describe("publisher quality", () => {
  it("shows suspension reason, recovery progress and honest probe history", async () => {
    query.fn.mockResolvedValue(data);
    show();
    expect(await screen.findByText("Recovering")).toBeTruthy();
    expect(screen.getByText(data.suspensionReason!)).toBeTruthy();
    expect(screen.getByText(/2\/3 consecutive healthy checks/)).toBeTruthy();
    expect(screen.getByText(/After 3 consecutive healthy checks/)).toBeTruthy();
    expect(screen.getByText("Timed out")).toBeTruthy();
    expect(screen.getByText("No response")).toBeTruthy();
    expect(screen.getByText("204")).toBeTruthy();
    expect(
      screen.getByText(/do not prove paid API calls succeed/),
    ).toBeTruthy();
    expect(
      screen.getByText("API quality: insufficient data (0/20)"),
    ).toBeTruthy();
  });
  it("shows measured quality and an empty probe history", async () => {
    query.fn.mockResolvedValue({
      ...data,
      status: "active",
      suspendedAt: null,
      suspensionReason: null,
      probes: [],
      quality: {
        reachabilitySampleSize: 3,
        reachabilityMinimumSampleSize: 3,
        reachabilityPercent: 100,
        reachabilityLatencyP50Ms: 12,
        insufficientReachabilityData: false,
        apiSampleSize: 20,
        apiMinimumSampleSize: 20,
        apiSuccessRatePercent: 90,
        apiLatencyP50Ms: 45,
        insufficientApiData: false,
        lastProbeOutcome: "healthy",
        lastProbedAt: 100,
        freshness: {
          publishedAt: 1,
          measuredAt: 100,
          ageMs: 0,
          status: "fresh",
        },
      },
    });
    show();
    expect(
      await screen.findByText("API success 90.0% · 45 ms p50"),
    ).toBeTruthy();
    expect(screen.getByText("No probes yet")).toBeTruthy();
    expect(screen.queryByText("Restore your listing")).toBeNull();
  });
  it("explains unpublished projects", async () => {
    query.fn.mockResolvedValue({
      ...data,
      status: "active",
      version: null,
      suspendedAt: null,
      probes: [],
    });
    show();
    expect(await screen.findByText("Not published")).toBeTruthy();
    expect(
      screen.getByText(/Publish a version with a declared health endpoint/),
    ).toBeTruthy();
  });
  it("uses a skeleton while pending and retries a sanitized error", async () => {
    query.fn
      .mockRejectedValueOnce(new Error("private internal diagnostic"))
      .mockResolvedValue(data);
    show();
    expect(screen.getByLabelText("Loading quality evidence")).toBeTruthy();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText(/private internal diagnostic/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Recovering")).toBeTruthy();
  });
});
