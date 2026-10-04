import { useRouterState } from "@tanstack/react-router";
import { ConvexProvider } from "convex/react";
import { lazy, Suspense, type ComponentProps, type ReactNode } from "react";

import { needsAuthenticatedProviders } from "#/lib/provider-scope";
import type { PrincipalCache, RouterContext } from "#/router";

const AuthenticatedPublicProviders = lazy(() =>
  import("./authenticated-providers").then((module) => ({
    default: module.AuthenticatedProviders,
  })),
);

/** Providers follow the rendered matches, not a destination still loading. */
export function RouteProviders({
  client,
  principalCache,
  children,
}: {
  client: ComponentProps<typeof ConvexProvider>["client"];
  principalCache?: PrincipalCache;
  children: ReactNode;
}) {
  const { pathname, signedIn } = useRouterState({
    select: (state) => ({
      pathname: state.matches.at(-1)?.pathname ?? state.location.pathname,
      signedIn: Boolean(
        (state.matches[0]?.context as Partial<RouterContext> | undefined)
          ?.userId,
      ),
    }),
  });

  // App/admin layouts own Convex auth; auth forms only need Clerk.
  if (needsAuthenticatedProviders(pathname)) return children;

  if (
    signedIn &&
    principalCache &&
    /^\/catalogue\/[^/]+\/[^/]+\/?$/.test(pathname)
  ) {
    return (
      <Suspense
        fallback={<div className="min-h-svh bg-background" aria-busy="true" />}
      >
        <AuthenticatedPublicProviders
          client={client}
          principalCache={principalCache}
        >
          {children}
        </AuthenticatedPublicProviders>
      </Suspense>
    );
  }

  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
