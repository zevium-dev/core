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
}

const convexUrl = import.meta.env.VITE_CONVEX_URL;
if (typeof convexUrl !== "string" || convexUrl.length === 0) {
  throw new Error("missing envar VITE_CONVEX_URL");
}

/** Shared Convex + React Query clients; wired once, consumed by root providers + getRouter. */
export const convexQueryClient = new ConvexQueryClient(convexUrl);
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
    defaultPreloadStaleTime: 0,
    context: {
      queryClient,
    } satisfies RouterContext,
    defaultViewTransition: {
      types: ({ fromLocation, toLocation }) => {
        markViewTransitionActive();
        const from = fromLocation?.state.__TSR_index ?? 0;
        const to = toLocation.state.__TSR_index ?? 0;
        return to >= from ? ["navigate-forward"] : ["navigate-back"];
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
