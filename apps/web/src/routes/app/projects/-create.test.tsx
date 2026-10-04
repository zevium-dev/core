// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { createProject, navigate } = vi.hoisted(() => ({
  createProject: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@clerk/tanstack-react-start", () => ({
  useOrganization: () => ({
    isLoaded: true,
    organization: { slug: "publisher" },
    membership: { role: "org:admin" },
  }),
}));
vi.mock("@convex-dev/react-query", () => ({
  useConvexMutation: () => createProject,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => ReactNode }) => ({
    options,
  }),
  useNavigate: () => navigate,
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/app/projects">{children}</a>
  ),
}));

import { Route } from "./create";

beforeEach(() => {
  vi.clearAllMocks();
  createProject.mockImplementation(async ({ slug }: { slug: string }) => ({
    slug,
  }));
});
afterEach(cleanup);

function renderForm() {
  const Page = Route.options.component;
  if (!Page) throw new Error("Missing create project component");
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Page />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Weather API" },
  });
  return screen.getByLabelText<HTMLInputElement>("Slug");
}

it("preserves hyphens entered one character at a time and submits the chosen slug", async () => {
  const slug = renderForm();
  expect(slug.value).toBe("weather-api");
  fireEvent.change(slug, { target: { value: "" } });
  for (const character of "custom-weather-api") {
    fireEvent.change(slug, { target: { value: slug.value + character } });
  }
  expect(slug.value).toBe("custom-weather-api");
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await waitFor(() =>
    expect(createProject).toHaveBeenCalledWith({
      orgSlug: "publisher",
      name: "Weather API",
      slug: "custom-weather-api",
      description: undefined,
    }),
  );
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      to: "/app/projects/$projectSlug",
      params: { projectSlug: "custom-weather-api" },
      replace: true,
    }),
  );
});

it.each(["weather-", "weather--api", "weather_api", "-weather"])(
  "blocks invalid slug %s locally and focuses its error",
  (value) => {
    const slug = renderForm();
    fireEvent.change(slug, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(createProject).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(slug);
    expect(slug.getAttribute("aria-invalid")).toBe("true");
    expect(
      screen.getByText(
        "Use lowercase letters, numbers, and single hyphens between words.",
      ),
    ).toBeTruthy();
  },
);
