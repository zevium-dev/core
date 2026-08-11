import { ClerkProvider, useAuth } from "@clerk/tanstack-react-start";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import type { ReactNode } from "react";

type AuthenticatedProvidersProps = {
  client: Parameters<typeof ConvexProviderWithClerk>[0]["client"];
  children: ReactNode;
};

/** Keep Clerk and its hosted UI off anonymous public routes' cold path. */
export function AuthenticatedProviders({
  client,
  children,
}: AuthenticatedProvidersProps) {
  return (
    <ClerkProvider>
      <ConvexProviderWithClerk client={client} useAuth={useAuth}>
        {children}
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
