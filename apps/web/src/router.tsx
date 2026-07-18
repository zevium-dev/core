import { ConvexQueryClient } from "@convex-dev/react-query";
import { AsyncLocalStorage } from "node:async_hooks";
import { QueryClient } from "@tanstack/react-query";
import {
  createRouter as createTanStackRouter,
  type AnyRouter,
} from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { LazyMotion, domAnimation } from "motion/react";

import { ConvexHttpClient } from "convex/browser";

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
  // consistentQuery pins a timestamp; rows created mid-request (ensureMirror)
  // would be invisible → "Organization not found" InternalServerError.
  // Inconsistent is correct here.
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

/**
 * Per-request SSR ConvexHttpClient scope.
 *
 * `ConvexQueryClient` constructs a single `serverHttpClient` in its
 * constructor and stashes it on the instance. Because `convexQueryClient`
 * itself is module-scoped, that HttpClient is shared across every SSR
 * request handled in the same worker isolate. The root beforeLoad calls
 * `convexQueryClient.serverHttpClient.setAuth(token)` to forward the Clerk
 * JWT into SSR loaders — and mutating the auth of a shared client under
 * concurrent requests races: request B's token can overwrite request A's
 * before A's loaders fire, leaking cross-user identity into Convex.
 *
 * We replace the shared client with a per-request one scoped via
 * `AsyncLocalStorage`. The first access within a request (the beforeLoad
 * `setAuth` call) lazily creates a fresh `ConvexHttpClient` and binds it to
 * the current async context via `enterWith`, which propagates through the
 * awaited beforeLoad → loader chain the router orchestrates. Subsequent
 * accesses in the same request (the loaders' `queryFn`, which reads
 * `this.serverHttpClient`) resolve the bound instance. Concurrent requests
 * resolve isolated instances, so `setAuth` can never cross-contaminate.
 *
 * The `queryClient` stays shared: SSR loaders only cache org- or
 * project-scoped entries (query keys carry `orgSlug`/`projectId`), so it
 * holds no per-user cache entries that could leak identity across requests.
 */
const ssrRequestClient = new AsyncLocalStorage<ConvexHttpClient>();

if (typeof window === "undefined") {
  // Replace the constructor-installed shared HttpClient with a per-request
  // getter. On the client, `serverHttpClient` stays `undefined` (the
  // `ConvexQueryClient` constructor only creates one server-side) and the
  // browser beforeLoad branch returns before touching it, so the override
  // is server-only.
  Object.defineProperty(convexQueryClient, "serverHttpClient", {
    enumerable: true,
    configurable: true,
    get(): ConvexHttpClient | undefined {
      const bound = ssrRequestClient.getStore();
      if (bound) return bound;
      const client = new ConvexHttpClient(convexUrl);
      ssrRequestClient.enterWith(client);
      return client;
    },
  });
}

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
