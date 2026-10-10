// @vitest-environment jsdom
import type { Id } from "#/lib/convex-data-model";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENAPI_TEMPLATE } from "./template";
import { useSpecDraft } from "./use-spec-draft";
const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@convex-dev/react-query", () => ({
  useConvexMutation: () => mocks.save,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const initial = {
  projectId: "p" as Id<"projects">,
  savedDraft: OPENAPI_TEMPLATE,
  savedDraftHash: "base",
  lastSavedAt: 1,
};
const local = OPENAPI_TEMPLATE.replace("0.1.0", "0.2.0");
const remote = OPENAPI_TEMPLATE.replace("0.1.0", "0.3.0");
function setup() {
  const client = new QueryClient();
  return renderHook(useSpecDraft, {
    initialProps: initial,
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}
describe("draft concurrency", () => {
  it("holds the original base through remote pushes, then explicitly overwrites with the remote hash", async () => {
    const { result, rerender } = setup();
    act(() => result.current.edit(local));
    rerender({
      ...initial,
      savedDraft: remote,
      savedDraftHash: "remote",
      lastSavedAt: 2,
    });
    expect(result.current.text).toBe(local);
    expect(result.current.confirmedDraftHash).toBe("base");
    mocks.save.mockResolvedValueOnce({
      ok: false,
      conflict: true,
      draft: remote,
      draftHash: "remote",
      lastSavedAt: 2,
      issues: [],
    });
    act(() => result.current.save());
    await waitFor(() => expect(result.current.conflict).not.toBeNull());
    expect(mocks.save).toHaveBeenLastCalledWith({
      projectId: "p",
      spec: local,
      baseHash: "base",
    });
    act(() => result.current.edit(local + "\n"));
    expect(result.current.conflict).not.toBeNull();
    mocks.save.mockResolvedValueOnce({
      ok: true,
      draft: local + "\n",
      draftHash: "local",
      lastSavedAt: 3,
      issues: [],
    });
    act(() => result.current.overwrite());
    await waitFor(() => expect(result.current.dirty).toBe(false));
    expect(mocks.save).toHaveBeenLastCalledWith({
      projectId: "p",
      spec: local + "\n",
      baseHash: "remote",
    });
  });
  it("reloads a conflicting saved draft without saving local text", async () => {
    const { result } = setup();
    act(() => result.current.edit(local));
    mocks.save.mockResolvedValue({
      ok: false,
      conflict: true,
      draft: remote,
      draftHash: "remote",
      lastSavedAt: 2,
      issues: [],
    });
    act(() => result.current.save());
    await waitFor(() => expect(result.current.conflict).not.toBeNull());
    act(() => result.current.reload());
    expect(result.current.text).toBe(remote);
    expect(result.current.dirty).toBe(false);
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
  it("preserves edits typed while a save is in flight", async () => {
    const { result } = setup();
    let resolve!: (value: unknown) => void;
    mocks.save.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    act(() => result.current.edit(local));
    act(() => result.current.save());
    await waitFor(() => expect(result.current.savePending).toBe(true));
    act(() => result.current.edit(remote));
    await act(async () =>
      resolve({
        ok: true,
        draft: local,
        draftHash: "local",
        lastSavedAt: 2,
        issues: [],
      }),
    );
    await waitFor(() => expect(result.current.savePending).toBe(false));
    expect(result.current.text).toBe(remote);
    expect(result.current.confirmedDraft).toBe(local);
    expect(result.current.dirty).toBe(true);
  });
});
