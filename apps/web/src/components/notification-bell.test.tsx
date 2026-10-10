// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LazyMotion, domAnimation } from "motion/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  userId: "user_test",
  orgId: "org_test" as string | null,
  orgSlug: "test" as string | null,
  orgLoaded: true,
  authPending: false,
  authenticated: true,
  error: null as Error | null,
  list: vi.fn(),
  unread: vi.fn(),
}));
vi.mock("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({ userId: state.userId, orgId: state.orgId }),
  useOrganization: () => ({
    isLoaded: state.orgLoaded,
    organization: state.orgId ? { id: state.orgId, slug: state.orgSlug } : null,
  }),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isLoading: state.authPending,
    isAuthenticated: state.authenticated,
  }),
  usePaginatedQuery: (...args: unknown[]) => {
    state.list(...args);
    if (state.error) throw state.error;
    return { results: [], status: "Exhausted", loadMore: vi.fn() };
  },
}));
vi.mock("@convex-dev/react-query", () => ({
  convexQuery: (_query: unknown, args: { orgSlug: string }) => ({
    queryKey: ["notifications", state.userId, state.orgId, args],
    queryFn: () => state.unread(args),
  }),
  useConvexMutation: () => vi.fn(),
}));
vi.mock("#/hooks/use-hydrated-reduced-motion", () => ({
  useHydratedReducedMotion: () => true,
}));

import { NotificationBell } from "./notification-bell";

beforeEach(() => {
  state.userId = "user_test";
  state.orgId = "org_test";
  state.orgSlug = "test";
  state.orgLoaded = true;
  state.authPending = false;
  state.authenticated = true;
  state.error = null;
  state.list.mockReset();
  state.unread.mockReset().mockResolvedValue({ unreadCount: 2 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(workspaceReady = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <LazyMotion features={domAnimation}>{children}</LazyMotion>
    </QueryClientProvider>
  );
  const view = render(<NotificationBell workspaceReady={workspaceReady} />, {
    wrapper,
  });
  return {
    rerender: (ready = true) =>
      view.rerender(<NotificationBell workspaceReady={ready} />),
  };
}

async function expectRecovered() {
  const bell = await screen.findByRole("button", {
    name: "Notifications, 2 unread",
  });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(bell);
  expect(await screen.findByText("No notifications yet")).toBeTruthy();
}

describe("notification authentication recovery", () => {
  it("waits for auth and provisioning after organization creation, then loads without navigation", async () => {
    state.orgId = null;
    state.orgSlug = null;
    const { rerender } = setup();
    expect(
      screen.getByRole("button", {
        name: "Select an organization to view notifications",
      }),
    ).toBeTruthy();

    // Clerk publishes the new org before Convex accepts its token or the
    // organization's mirror exists. Querying here reproduced issue #416.
    state.orgId = "org_created";
    state.orgSlug = "created";
    state.authPending = true;
    state.authenticated = false;
    state.error = new Error("Not authenticated");
    rerender(false);
    expect(screen.getByLabelText("Loading notifications")).toBeTruthy();
    expect(state.list).not.toHaveBeenCalled();
    expect(state.unread).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();

    state.authPending = false;
    state.authenticated = true;
    state.error = null;
    rerender(false);
    expect(state.list).not.toHaveBeenCalled();
    expect(state.unread).not.toHaveBeenCalled();

    rerender(true);
    await expectRecovered();
    expect(state.list).toHaveBeenLastCalledWith(
      expect.anything(),
      { orgSlug: "created" },
      { initialNumItems: 20 },
    );
    expect(state.unread).toHaveBeenLastCalledWith({ orgSlug: "created" });
  });

  it("clears a latched authentication error when auth settles for the same org", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.error = new Error("Not authenticated");
    const { rerender } = setup();
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not load notifications",
    );

    state.authPending = true;
    state.authenticated = false;
    rerender();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Loading notifications")).toBeTruthy();

    state.authPending = false;
    state.authenticated = true;
    state.error = null;
    rerender();
    await expectRecovered();
  });

  it.each(["userId", "orgId", "orgSlug"] as const)(
    "resets a failed boundary when %s changes",
    async (field) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      state.error = new Error("Not authenticated");
      const { rerender } = setup();
      expect(screen.getByRole("alert")).toBeTruthy();

      state[field] = "next";
      state.error = null;
      rerender();
      await expectRecovered();
    },
  );

  it("keeps genuine query failures local and manually retryable without a retry loop", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.error = new Error("private backend detail");
    const { rerender } = setup();
    expect(screen.getByRole("alert").textContent).toContain(
      "Check your connection, then retry.",
    );
    expect(screen.queryByText("private backend detail")).toBeNull();
    const attempts = state.list.mock.calls.length;
    rerender();
    expect(state.list).toHaveBeenCalledTimes(attempts);

    state.error = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await expectRecovered();
  });
});
