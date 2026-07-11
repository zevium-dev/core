import { ConvexQueryClient } from "@convex-dev/react-query";
import { QueryClient } from "@tanstack/react-query";
import {
  createRouter as createTanStackRouter,
  type AnyRouter,
} from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { LazyMotion, domAnimation } from "motion/react";

import { markViewTransitionActive } from "#/lib/vt";
import { routeTree } from "./routeTree.gen";

export interface RouterContext {
  queryClient: QueryClient;
  /** Clerk user id from root beforeLoad; null when signed out. */
  userId: string | null;
  /** Clerk JWT for Convex template; used to auth SSR HTTP client. */
  token: string | null;
  /** Active Clerk org slug; null when none selected. */
  orgSlug: string | null;
  /** Active Clerk org id; null when none selected. */
  orgId: string | null;
}

const convexUrl = import.meta.env.VITE_CONVEX_URL;
if (typeof convexUrl !== "string" || convexUrl.length === 0) {
  throw new Error("missing envar VITE_CONVEX_URL");
}

/** Shared Convex + React Query clients; wired once, consumed by root providers + getRouter. */
export const convexQueryClient = new ConvexQueryClient(convexUrl, {
  // Module-scoped HttpClient is long-lived across SSR requests. consistentQuery
  // pins a timestamp; rows created mid-request (ensureMirror) would be invisible
  // → "Organization not found" InternalServerError. Inconsistent is correct here.
  dangerouslyUseInconsistentQueriesDuringSSR: true,
});
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryKeyHashFn: convexQueryClient.hashFn(),
      queryFn: convexQueryClient.queryFn(),
    },
  },
});
convexQueryClient.connect(queryClient);

export function getRouter(): AnyRouter {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    // Intent-preloads must survive to the click; 0 discards them.
    defaultPreloadStaleTime: 30_000,
    // Show pending skeletons quickly instead of freezing the old screen.
    defaultPendingMs: 100,
    defaultPendingMinMs: 300,
    context: {
      queryClient,
      userId: null,
      token: null,
      orgSlug: null,
      orgId: null,
    } satisfies RouterContext,
    defaultViewTransition: {
      types: ({ fromLocation, toLocation }) => {
        markViewTransitionActive();
        const from = fromLocation?.state.__TSR_index ?? 0;
        const to = toLocation.state.__TSR_index ?? 0;
        const direction = to >= from ? "navigate-forward" : "navigate-back";
        // DESIGN.md morphs are for list→detail. Sidebar-level hops get a
        // fast swap (styles.css scopes duration via nav-swap type).
        const isDetail = (path: string | undefined): boolean =>
          path !== undefined &&
          (/^\/app\/projects\/[^/]+/.test(path) ||
            /^\/catalogue\/[^/]+\/[^/]+/.test(path));
        if (
          !isDetail(fromLocation?.pathname) &&
          !isDetail(toLocation.pathname)
        ) {
          return [direction, "nav-swap"];
        }
        return [direction];
      },
    },
    Wrap: ({ children }) => (
      <LazyMotion features={domAnimation} strict>
        {children}
      </LazyMotion>
    ),
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: AnyRouter;
  }
}
