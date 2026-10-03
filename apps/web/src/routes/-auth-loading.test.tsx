// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/tanstack-react-start", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  // Clerk's hosted form has not loaded yet.
  SignIn: () => null,
  SignUp: () => null,
  useAuth: () => ({ isLoaded: false }),
}));

vi.mock("convex/react-clerk", () => ({
  ConvexProviderWithClerk: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => ReactNode }) => ({
    options,
    useSearch: () => ({ redirect: "/app" }),
    useRouteContext: () => ({
      convexQueryClient: { convexClient: {} },
      principalCache: {
        keyFor: () => "anonymous:-",
        currentKey: "anonymous:-",
      },
    }),
  }),
}));

import { Route as SignInRoute } from "./sign-in.$";
import { Route as SignUpRoute } from "./sign-up.$";

afterEach(cleanup);

describe("authentication cold loads", () => {
  it.each([
    [SignInRoute, "Loading sign in"],
    [SignUpRoute, "Loading account creation"],
  ])(
    "renders a loading card before Clerk auth is ready (%s)",
    (route, label) => {
      // Real AuthenticatedProviders would block children while isLoaded is false.
      const Page = route.options.component;
      if (!Page) throw new Error("Authentication route lacks a page component");
      render(<Page />);
      expect(screen.getByRole("status", { name: label })).toBeTruthy();
    },
  );
});
