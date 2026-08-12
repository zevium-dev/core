import { useAuth, useOrganization } from "@clerk/tanstack-react-start";
import { useConvex, useConvexAuth } from "convex/react";
import { useEffect, useRef } from "react";

import { api } from "#/lib/convex-api";

/**
 * On /app mount: call Convex ensureUser + ensureOrganization once per
 * user/org pair after Convex JWT is ready. Failures logged; never block shell.
 */
export function useEnsureMirror() {
  const convex = useConvex();
  const { isSignedIn, userId } = useAuth();
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
  const { organization } = useOrganization();
  const ranFor = useRef<string | null>(null);

  useEffect(() => {
    if (!isSignedIn || !userId) return;
    if (convexAuthLoading || !isAuthenticated) return;

    const key = `${userId}:${organization?.id ?? "none"}`;
    if (ranFor.current === key) return;
    ranFor.current = key;

    void (async () => {
      try {
        await convex.mutation(api.users.ensureUser, {});
      } catch {
        console.warn("[ensureUser] failed");
        // Allow retry on next effect if mutation failed before mirror.
        ranFor.current = null;
        return;
      }
      if (!organization?.id) return;
      const slug = organization.slug;
      if (!slug) {
        console.warn("[ensureOrganization] active org missing slug");
        return;
      }
      try {
        await convex.mutation(api.organizations.ensureOrganization, {
          clerkOrgId: organization.id,
        });
      } catch {
        console.warn("[ensureOrganization] failed");
        ranFor.current = null;
      }
    })();
  }, [
    convex,
    isSignedIn,
    userId,
    organization,
    convexAuthLoading,
    isAuthenticated,
  ]);
}
