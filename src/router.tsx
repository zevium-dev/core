import "~/lib/polyfill";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";

import { getQueryClient } from "~/lib/query-client";

import { DefaultCatchBoundary } from "./components/default-catch-boundary";
import { NotFound } from "./components/not-found";
import { getTrpcClient } from "./lib/trpc/trpc";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const { queryClient, trpc } = getTrpcOptionsProxy();

  const router = createTanStackRouter({
    context: { queryClient, trpc },
    defaultErrorComponent: DefaultCatchBoundary,
    defaultNotFoundComponent: () => <NotFound />,
    defaultPreload: "intent",
    routeTree,
    scrollRestoration: (opts) => {
      return !opts.location.pathname.endsWith("/explorer");
    },
  });

  setupRouterSsrQueryIntegration({ queryClient, router });

  return router;
}

function getTrpcOptionsProxy() {
  const queryClient = getQueryClient();
  const trpcClient = getTrpcClient();

  const trpc = createTRPCOptionsProxy({ client: trpcClient, queryClient });
  return { queryClient, trpc, trpcClient };
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
