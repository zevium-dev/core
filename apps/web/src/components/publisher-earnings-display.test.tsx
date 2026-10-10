// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectAnalyticsPanel } from "#/routes/app/projects/$projectSlug";
import { ProjectEarningsPanel } from "./project-earnings-panel";

const { queryData } = vi.hoisted(() => ({ queryData: vi.fn() }));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useSuspenseQuery: () => ({ data: queryData() }),
}));
vi.mock("./project-settings-panel", () => ({
  ProjectSettingsPanel: () => null,
}));
afterEach(cleanup);

describe("publisher earnings presentation", () => {
  it("shows 13.30 credits for two seven-credit calls in analytics and project earnings", () => {
    queryData.mockReturnValue({
      calls: 2,
      netCredits: 13.3,
      rangeDays: 7,
      rangeStart: Date.UTC(2026, 9, 10),
      callsByDay: [2],
      successRate: 1,
      p50: 1,
      p95: 1,
      p99: 1,
      errors4xx: 0,
      errors5xx: 0,
      endpoints: [],
      truncated: false,
    });
    const analytics = render(
      <ProjectAnalyticsPanel
        orgSlug="publisher"
        projectSlug="forecast"
        rangeDays={7}
        onRangeChange={() => {}}
      />,
    );
    expect(screen.getByText("13.30")).toBeDefined();
    expect(screen.getByText(/\$0\.0013 publisher share/)).toBeDefined();
    analytics.unmount();
    const totals = { calls: 2, grossCredits: 14, netCredits: 13.3 };
    queryData.mockReturnValue({
      byProject: [{ slug: "forecast", ...totals }],
      month: totals,
      allTime: totals,
    });
    render(<ProjectEarningsPanel orgSlug="publisher" projectSlug="forecast" />);
    expect(screen.getAllByText("13.30")).toHaveLength(3);
    expect(screen.getAllByText("$0.0013 publisher share")).toHaveLength(3);
  });
});
