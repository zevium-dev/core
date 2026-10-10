// @vitest-environment jsdom
import type { Doc, Id } from "#/lib/convex-data-model";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailsCard } from "../project/details-card";
import { PublishPanel } from "./publish-panel";
import { SpecRailEndpoints } from "./rail-endpoints";
import { OPENAPI_TEMPLATE } from "./template";

vi.mock("@convex-dev/react-query", () => ({
  useConvexMutation: () => vi.fn(),
  convexQuery: (ref: Parameters<typeof getFunctionName>[0]) => ({
    queryKey: [getFunctionName(ref)],
    initialData: { current: true },
    queryFn: async () => ({ current: true }),
  }),
}));
vi.mock("convex/react", () => ({ useAction: () => vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/app/projects">{children}</a>
  ),
}));
afterEach(cleanup);
const project: Doc<"projects"> = {
  _id: "project" as Id<"projects">,
  _creationTime: 1,
  organizationId: "org" as Id<"organizations">,
  name: "Original",
  slug: "original",
  tags: ["api"],
  visibility: "private",
  status: "draft",
};
function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  );
}

describe("input survives realtime", () => {
  it("keeps typed settings and derives untouched fields from the current project", () => {
    const view = render(<DetailsCard project={project} />, { wrapper });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Local name" },
    });
    fireEvent.change(screen.getByLabelText("Tags"), {
      target: { value: "mine, draft" },
    });
    view.rerender(
      <DetailsCard
        project={{
          ...project,
          name: "Remote name",
          tags: ["remote"],
          description: "Remote description",
        }}
      />,
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Local name",
    );
    expect((screen.getByLabelText("Tags") as HTMLInputElement).value).toBe(
      "mine, draft",
    );
    expect(
      (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
    ).toBe("Remote description");
  });
  it("does not reset a typed publish version when versions are pushed", async () => {
    const props = {
      projectId: project._id,
      projectSlug: project.slug,
      visibility: project.visibility,
      description: "Description",
      versions: [],
      text: OPENAPI_TEMPLATE,
      dirty: false,
      savePending: false,
      hasClientErrors: false,
      confirmedDraft: OPENAPI_TEMPLATE,
      confirmedDraftHash: "hash",
      pricing: null,
      endpointCount: 1,
      onIssues: vi.fn(),
    };
    const view = render(<PublishPanel {...props} />, { wrapper });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Publish" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    fireEvent.change(screen.getByLabelText("Version"), {
      target: { value: "2.3.4-beta.1" },
    });
    view.rerender(
      <PublishPanel
        {...props}
        versions={[
          {
            _id: "version",
            version: "1.0.0",
            publishedAt: 1,
            deprecatedAt: undefined,
            sunsetAt: undefined,
            deprecationMessage: undefined,
          },
        ]}
      />,
    );
    expect((screen.getByLabelText("Version") as HTMLInputElement).value).toBe(
      "2.3.4-beta.1",
    );
  });
  it("keeps an unfinished decimal through pricing write-back", () => {
    const change = vi.fn();
    const endpoint = { path: "/ping", method: "get" as const, cost: 2 };
    const view = render(
      <SpecRailEndpoints
        endpoints={[endpoint]}
        stale={false}
        onPricingChange={change}
      />,
    );
    fireEvent.change(screen.getByLabelText("Cost for GET /ping"), {
      target: { value: "1." },
    });
    expect(change).toHaveBeenLastCalledWith({
      path: "/ping",
      method: "get",
      cost: 1,
    });
    view.rerender(
      <SpecRailEndpoints
        endpoints={[{ ...endpoint, cost: 1 }]}
        stale={false}
        onPricingChange={change}
      />,
    );
    expect(
      (screen.getByLabelText("Cost for GET /ping") as HTMLInputElement).value,
    ).toBe("1.");
    fireEvent.change(screen.getByLabelText("Cost for GET /ping"), {
      target: { value: "1.5" },
    });
    expect(change).toHaveBeenLastCalledWith({
      path: "/ping",
      method: "get",
      cost: 1.5,
    });
  });
});
