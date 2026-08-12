import { ClerkProvider, useAuth } from "@clerk/tanstack-react-start";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { Fragment, useLayoutEffect, useReducer, type ReactNode } from "react";

import type { PrincipalCache } from "#/router";

type AuthenticatedProvidersProps = {
  client: Parameters<typeof ConvexProviderWithClerk>[0]["client"];
  children: ReactNode;
  principalCache: PrincipalCache;
};

/** Keep Clerk and its hosted UI off anonymous public routes' cold path. */
export function AuthenticatedProviders({
  client,
  children,
  principalCache,
}: AuthenticatedProvidersProps) {
  return (
    <ClerkProvider>
      <ConvexProviderWithClerk client={client} useAuth={useAuth}>
        <PrincipalBoundary principalCache={principalCache}>
          {children}
        </PrincipalBoundary>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}

function PrincipalBoundary({
  children,
  principalCache,
}: {
  children: ReactNode;
  principalCache: PrincipalCache;
}) {
  const { isLoaded, userId, orgId } = useAuth();
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  const expectedKey = principalCache.keyFor(userId ?? null, orgId ?? null);
  const ready = isLoaded && principalCache.currentKey === expectedKey;

  useLayoutEffect(() => {
    if (!isLoaded || ready) return;
    let active = true;
    void principalCache.transition(userId ?? null, orgId ?? null).then(() => {
      if (active) rerender();
    });
    return () => {
      active = false;
    };
  }, [isLoaded, orgId, principalCache, ready, userId]);

  if (!ready) {
    return <div className="min-h-svh bg-background" aria-busy="true" />;
  }
  return <Fragment key={expectedKey}>{children}</Fragment>;
}
