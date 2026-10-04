// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  orgId: "org_qa" as string | null,
  organizationLoaded: true,
  authenticated: true,
  mutation: vi.fn(),
}));
vi.mock("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({ isSignedIn: true, userId: "user_qa" }),
  useOrganization: () => ({
    isLoaded: state.organizationLoaded,
    organization: state.orgId ? { id: state.orgId } : null,
  }),
}));
vi.mock("convex/react", () => ({
  useConvex: () => ({ mutation: state.mutation }),
  useConvexAuth: () => ({
    isLoading: false,
    isAuthenticated: state.authenticated,
  }),
}));
import { useEnsureMirror } from "./use-ensure-mirror";
afterEach(cleanup);
beforeEach(() => {
  state.orgId = "org_qa";
  state.organizationLoaded = true;
  state.authenticated = true;
  state.mutation.mockReset().mockResolvedValue(null);
});
function setup() {
  const client = new QueryClient();
  return renderHook(useEnsureMirror, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}
describe("workspace provisioning gate", () => {
  it("holds tenant queries until both mirror writes finish", async () => {
    let finish!: () => void;
    state.mutation.mockResolvedValueOnce(null).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = setup();
    await waitFor(() => expect(state.mutation).toHaveBeenCalledTimes(2));
    expect(result.current.isReady).toBe(false);
    await act(async () => {
      finish();
    });
    await waitFor(() => expect(result.current.isReady).toBe(true));
  });
  it("gates the next organization and allows a failed preparation to be retried", async () => {
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.isReady).toBe(true));
    state.orgId = "org_next";
    state.mutation.mockRejectedValueOnce(new Error("private backend error"));
    rerender();
    expect(result.current.isReady).toBe(false);
    await waitFor(() => expect(result.current.isError).toBe(true));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(state.mutation).toHaveBeenLastCalledWith(expect.anything(), {
      clerkOrgId: "org_next",
    });
  });
  it("waits for organization and Convex auth before attempting provisioning", async () => {
    state.organizationLoaded = false;
    state.authenticated = false;
    const { result, rerender } = setup();
    expect(result.current.isReady).toBe(false);
    expect(state.mutation).not.toHaveBeenCalled();
    state.organizationLoaded = true;
    state.authenticated = true;
    state.orgId = null;
    rerender();
    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(state.mutation).toHaveBeenCalledTimes(1);
  });
});
