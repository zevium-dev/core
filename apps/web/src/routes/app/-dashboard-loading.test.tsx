// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ activeOrg: false }));
vi.mock("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({
    userId: "user_test",
    orgId: auth.activeOrg ? "org_test" : null,
  }),
  useOrganization: () => ({
    isLoaded: true,
    organization: auth.activeOrg ? { id: "org_test", slug: "test" } : null,
    membership: { role: "org:admin" },
  }),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => ReactNode }) => ({
    options,
  }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useSuspenseQuery: () => ({
    data: {
      creditsCycle: 0,
      callsToday: 0,
      callsCycle: 0,
      projectedCycleSpend: 0,
      truncated: false,
      scanCap: 100,
      recent: [],
    },
  }),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) =>
    queryKey[0] === "settings"
      ? {
          isSuccess: true,
          isPending: false,
          isError: false,
          data: [],
          refetch: vi.fn(),
        }
      : {
          isSuccess: false,
          isPending: false,
          isError: true,
          data: undefined,
          refetch: vi.fn(),
        },
}));
vi.mock("#/components/motion/number-ticker", () => ({
  NumberTicker: ({ value }: { value: number }) => <span>{value}</span>,
}));
vi.mock("#/lib/api-keys", () => ({ listKeys: vi.fn() }));

import { Route } from "./index";

beforeEach(() => {
  auth.activeOrg = false;
});
afterEach(cleanup);

it("shows organization selection instead of an endless skeleton in a personal session", () => {
  const Page = Route.options.component;
  if (!Page) throw new Error("Missing dashboard component");
  render(<Page />);
  expect(
    screen.getByText("Select an organization to see wallet and usage."),
  ).toBeTruthy();
});

it("keeps dashboard usage visible when legacy wallet verification fails", () => {
  auth.activeOrg = true;
  const Page = Route.options.component;
  if (!Page) throw new Error("Missing dashboard component");
  render(<Page />);
  expect(screen.getByText("Calls this cycle")).toBeTruthy();
  expect(screen.getByText("Recent calls")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry balance" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Top up" })).toBeNull();
  expect(screen.queryByText("Get started")).toBeNull();
});
