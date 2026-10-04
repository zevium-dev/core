import { useAuth, useOrganization } from "@clerk/tanstack-react-start";
import { useMutation } from "@tanstack/react-query";
import { useConvex, useConvexAuth } from "convex/react";
import { useEffect } from "react";

import { api } from "#/lib/convex-api";

/** Finish the current principal's mirrors before mounting tenant queries. */
export function useEnsureMirror() {
  const convex = useConvex();
  const { isSignedIn, userId } = useAuth();
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
  const { organization, isLoaded: organizationLoaded } = useOrganization();
  const principal = `${userId ?? "none"}:${organization?.id ?? "none"}`;
  const enabled = Boolean(
    isSignedIn &&
    userId &&
    organizationLoaded &&
    !convexAuthLoading &&
    isAuthenticated,
  );
  const { mutate, isPending, isError, isSuccess, data, variables } =
    useMutation({
      mutationFn: async (input: {
        principal: string;
        orgId: string | null;
      }) => {
        await convex.mutation(api.users.ensureUser, {});
        if (input.orgId) {
          await convex.mutation(api.organizations.ensureOrganization, {
            clerkOrgId: input.orgId,
          });
        }
        return input.principal;
      },
    });
  useEffect(() => {
    if (!enabled || variables?.principal === principal) return;
    mutate({ principal, orgId: organization?.id ?? null });
  }, [enabled, mutate, organization?.id, principal, variables?.principal]);
  return {
    isReady: enabled && isSuccess && data === principal,
    isError: isError && variables?.principal === principal,
    isPending,
    retry: () => mutate({ principal, orgId: organization?.id ?? null }),
  };
}
