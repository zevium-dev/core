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
  convexQueryClient: ConvexQueryClient;
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

export function getRouter(): AnyRouter {
  // TanStack Start calls getRouter once per SSR request and once in the
  // browser. Keeping both clients here isolates SSR auth and query caches
  // without relying on worker AsyncLocalStorage support.
  const convexQueryClient = new ConvexQueryClient(convexUrl, {
    // consistentQuery pins a timestamp; rows created mid-request (ensureMirror)
    // would be invisible → "Organization not found" InternalServerError.
    // Inconsistent is correct here.
    dangerouslyUseInconsistentQueriesDuringSSR: true,
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        queryKeyHashFn: convexQueryClient.hashFn(),
        queryFn: convexQueryClient.queryFn(),
      },
    },
  });
  convexQueryClient.connect(queryClient);

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
      convexQueryClient,
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
