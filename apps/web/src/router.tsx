import { ConvexQueryClient } from "@convex-dev/react-query";
import { QueryClient, type QueryKey } from "@tanstack/react-query";
import {
  createRouter as createTanStackRouter,
  type AnyRouter,
} from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { LazyMotion, domAnimation } from "motion/react";

import { RouteError } from "#/components/route-error";
import { routeViewTransitionTypes } from "#/lib/view-transition";
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
  principalCache: PrincipalCache;
}

export interface PrincipalCache {
  readonly currentKey: string;
  keyFor(userId: string | null, orgId: string | null): string;
  transition(userId: string | null, orgId: string | null): Promise<void>;
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
  const convexHash = convexQueryClient.hashFn();
  let currentPrincipalKey = "anonymous:-";
  let queryClient: QueryClient;
  const principalCache: PrincipalCache = {
    get currentKey() {
      return currentPrincipalKey;
    },
    keyFor(userId, orgId) {
      return `${userId ?? "anonymous"}:${orgId ?? "-"}`;
    },
    async transition(userId, orgId) {
      const next = this.keyFor(userId, orgId);
      if (next === currentPrincipalKey) return;
      await queryClient.cancelQueries();
      queryClient.removeQueries();
      queryClient.getMutationCache().clear();
      currentPrincipalKey = next;
    },
  };
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        queryKeyHashFn: (queryKey: QueryKey) =>
          `${currentPrincipalKey}:${convexHash(queryKey)}`,
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
    defaultErrorComponent: RouteError,
    context: {
      convexQueryClient,
      queryClient,
      userId: null,
      token: null,
      orgSlug: null,
      orgId: null,
      principalCache,
    } satisfies RouterContext,
    defaultViewTransition: {
      types: ({ fromLocation, toLocation }) => {
        const from = fromLocation?.state.__TSR_index ?? 0;
        const to = toLocation.state.__TSR_index ?? 0;
        const types = routeViewTransitionTypes({
          fromIndex: from,
          toIndex: to,
          fromPath: fromLocation?.pathname,
          toPath: toLocation.pathname,
        });
        if (types !== false) markViewTransitionActive();
        return types;
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
