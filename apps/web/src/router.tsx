import { ConvexQueryClient } from "@convex-dev/react-query";
import { QueryClient, type QueryKey } from "@tanstack/react-query";
import {
  createRouter as createTanStackRouter,
  type AnyRouter,
} from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { getGlobalStartContext } from "@tanstack/react-start";
import { LazyMotion, domAnimation } from "motion/react";

import { RouteError } from "#/components/route-error";
import { routeViewTransitionTypes } from "#/lib/view-transition";
import { configureViewTransitions } from "#/lib/vt";
import {
  createPrincipalCache,
  type PrincipalCache,
  type PrincipalSnapshot,
} from "#/lib/principal-cache";
import { routeTree } from "./routeTree.gen";

export type { PrincipalCache } from "#/lib/principal-cache";

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

const convexUrl = import.meta.env.VITE_CONVEX_URL;
if (typeof convexUrl !== "string" || convexUrl.length === 0) {
  throw new Error("missing envar VITE_CONVEX_URL");
}

export function getRouter(): AnyRouter {
  let nonce: string | undefined;
  try {
    nonce = getGlobalStartContext()?.nonce;
  } catch {
    // Clerk redirects also create routers outside Start's request context.
  }
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
  let queryClient: QueryClient;
  const principalCache = createPrincipalCache(() => queryClient);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        queryKeyHashFn: (queryKey: QueryKey) =>
          `${principalCache.currentKey}:${convexHash(queryKey)}`,
        queryFn: convexQueryClient.queryFn(),
      },
    },
  });
  convexQueryClient.connect(queryClient);

  const router = createTanStackRouter({
    routeTree,
    // Streaming captures the nonce before beforeLoad runs.
    ssr: { nonce },
    scrollRestoration: true,
    defaultPreload: "intent",
    // Intent-preloads must survive to the click; 0 discards them.
    defaultPreloadStaleTime: 30_000,
    // Show pending skeletons quickly instead of freezing the old screen.
    defaultPendingMs: 100,
    defaultPendingMinMs: 300,
    defaultErrorComponent: RouteError,
    // Restore the cache namespace before SSR query hydration. Hydration reuses
    // transported beforeLoad context, so it does not rerun its transition.
    dehydrate: () => ({ principal: principalCache.snapshot }),
    hydrate: async ({ principal }: { principal: PrincipalSnapshot }) => {
      await principalCache.transition(principal.userId, principal.orgId);
    },
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
        return types;
      },
    },
    Wrap: ({ children }) => (
      <LazyMotion features={domAnimation} strict>
        {children}
      </LazyMotion>
    ),
  });

  configureViewTransitions(router);
  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: AnyRouter;
  }
}

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: { nonce?: string } };
  }
}
