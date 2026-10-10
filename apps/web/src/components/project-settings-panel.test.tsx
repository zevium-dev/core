// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "#/lib/convex-data-model";
import { ProjectSettingsPanel } from "./project-settings-panel";

const state = vi.hoisted(() => ({ mode: "ready", role: "org:admin" }));
vi.mock("@clerk/tanstack-react-start", () => ({
  useOrganization: () => ({ membership: { role: state.role } }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@convex-dev/react-query", () => ({
  convexQuery: (reference: Parameters<typeof getFunctionName>[0]) => ({
    queryKey: [getFunctionName(reference)],
  }),
  useConvexMutation: () => vi.fn(),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    isPending: state.mode === "pending",
    isError: state.mode === "error",
    isSuccess: state.mode === "ready",
    error: new Error("Unavailable"),
    refetch: vi.fn(),
    data: queryKey[0].endsWith("listForProject")
      ? []
      : queryKey[0].endsWith("listDeliveries")
        ? { page: [] }
        : null,
  }),
}));

const project: Doc<"projects"> = {
  _id: "project_test" as Id<"projects">,
  _creationTime: 1,
  organizationId: "org_test" as Id<"organizations">,
  name: "Test API",
  slug: "test-api",
  status: "draft",
  visibility: "private",
  tags: [],
};
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  state.mode = "ready";
  state.role = "org:admin";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(canAdminister = true) {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <h1>{project.name}</h1>
      <ProjectSettingsPanel
        project={project}
        orgSlug="test"
        canAdminister={canAdminister}
      />
    </QueryClientProvider>,
  );
}
function headings() {
  return screen.getAllByRole("heading").map((heading) => ({
    name: heading.textContent,
    level: Number(
      heading.getAttribute("aria-level") ?? heading.tagName.slice(1),
    ),
  }));
}

describe("project settings heading hierarchy", () => {
  it("exposes every settings card under the page heading and deliveries under Webhooks", () => {
    setup();
    expect(headings()).toEqual([
      { name: "Test API", level: 1 },
      { name: "Project details", level: 2 },
      { name: "Visibility", level: 2 },
      { name: "Upstream credentials", level: 2 },
      { name: "Webhooks", level: 2 },
      { name: "Recent deliveries", level: 3 },
      { name: "Danger zone", level: 2 },
    ]);
  });
  it.each(["pending", "error"])(
    "preserves section heading levels while queries are %s",
    (mode) => {
      state.mode = mode;
      setup();
      expect(headings().map(({ level }) => level)).toEqual([1, 2, 2, 2, 2, 2]);
    },
  );
  it.each([true, false])(
    "exposes the access notice as a section for members (capability %s)",
    (canAdminister) => {
      state.role = "org:member";
      setup(canAdminister);
      expect(
        screen.getByRole("heading", {
          name: "Admin access required",
          level: 2,
        }),
      ).toBeTruthy();
    },
  );
});
