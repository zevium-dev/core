import { useRouterState } from "@tanstack/react-router";
import { ConvexProvider } from "convex/react";
import type { ComponentProps, ReactNode } from "react";

import { needsAuthenticatedProviders } from "#/lib/provider-scope";

/** Providers follow the rendered matches, not a destination still loading. */
export function RouteProviders({
  client,
  children,
}: {
  client: ComponentProps<typeof ConvexProvider>["client"];
  children: ReactNode;
}) {
  const pathname = useRouterState({
    select: (state) =>
      state.matches.at(-1)?.pathname ?? state.location.pathname,
  });

  // App/admin layouts own Convex auth; auth forms only need Clerk.
  if (needsAuthenticatedProviders(pathname)) return children;

  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
