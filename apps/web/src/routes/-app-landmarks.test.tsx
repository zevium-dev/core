// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ mobile: false, ready: true, error: false }));
vi.mock("#/hooks/use-mobile", () => ({ useIsMobile: () => state.mobile }));
vi.mock("#/hooks/use-ensure-mirror", () => ({
  useEnsureMirror: () => ({
    isReady: state.ready,
    isError: state.error,
    isPending: !state.ready && !state.error,
    retry: vi.fn(),
  }),
}));
vi.mock("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
  useOrganization: () => ({ isLoaded: true, organization: { id: "org_test" } }),
  useOrganizationList: () => ({
    isLoaded: true,
    userMemberships: { count: 1 },
  }),
  OrganizationSwitcher: () => <button>Switch workspace</button>,
  UserButton: () => <button>User menu</button>,
}));
vi.mock("#/components/authenticated-providers", () => ({
  AuthenticatedProviders: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("#/components/theme-toggle", () => ({
  ThemeToggle: () => <button>Theme</button>,
}));
vi.mock("#/components/notification-bell", () => ({
  NotificationBell: () => null,
}));
vi.mock("#/lib/auth-session", () => ({ requireAuth: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => ReactNode }) => ({
    options,
    useRouteContext: () => ({
      convexQueryClient: { convexClient: {} },
      principalCache: {},
    }),
  }),
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: "/app/settings" } }),
  useNavigate: () => vi.fn(),
  redirect: vi.fn(),
  ClientOnly: ({ children }: { children: ReactNode }) => children,
  Link: ({ to, children, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  Outlet: () => <h1>Settings</h1>,
}));

import { Route } from "./app";

beforeEach(() => {
  state.mobile = false;
  state.ready = true;
  state.error = false;
});
afterEach(cleanup);
function setup() {
  const Page = Route.options.component;
  if (!Page) throw new Error("App route lacks a component");
  return render(<Page />);
}
function expectNavigation(nav: HTMLElement) {
  expect(nav.tagName).toBe("NAV");
  expect(
    within(nav).getByRole("button", { name: "Switch workspace" }),
  ).toBeTruthy();
  for (const name of ["Dashboard", "Projects", "Settings", "Docs"]) {
    expect(within(nav).getByRole("link", { name })).toBeTruthy();
  }
  expect(within(nav).getByRole("button", { name: "User menu" })).toBeTruthy();
}

describe("app shell landmarks", () => {
  it("keeps navigation outside the single main when expanded and collapsed", () => {
    setup();
    expectNavigation(
      screen.getByRole("navigation", { name: "App navigation" }),
    );
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(
      screen
        .getByRole("main")
        .contains(screen.getByRole("navigation", { name: "App navigation" })),
    ).toBe(false);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Toggle Sidebar" })[0],
    );
    expectNavigation(
      screen.getByRole("navigation", { name: "App navigation" }),
    );
  });

  it("keeps navigation inside the mobile sheet portal", async () => {
    state.mobile = true;
    setup();
    expect(
      screen.queryByRole("navigation", { name: "App navigation" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    const dialog = await screen.findByRole("dialog");
    expectNavigation(
      within(dialog).getByRole("navigation", { name: "App navigation" }),
    );
    expect(document.querySelectorAll("main, [role='main']")).toHaveLength(1);
  });

  it.each(["ready", "pending", "error"])(
    "keeps a unique, focusable skip target in the %s state",
    (mode) => {
      state.ready = mode === "ready";
      state.error = mode === "error";
      const { container } = setup();
      const main = screen.getByRole("main");
      const link = screen.getByRole("link", { name: "Skip to main content" });
      const target = container.querySelector(link.getAttribute("href")!);
      expect(container.querySelectorAll("#main-content")).toHaveLength(1);
      expect(main.contains(target)).toBe(true);
      expect(target).toBeInstanceOf(HTMLElement);
      (target as HTMLElement).focus();
      expect(document.activeElement).toBe(target);
    },
  );
});
