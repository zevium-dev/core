import { useAuth, useOrganization } from "@clerk/tanstack-react-start";
import { useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useEffect, useRef } from "react";

/**
 * Optimistic refs for convex-lane mutations.
 * When convex/_generated api lacks them, calls fail and we log once.
 */
const ensureUserRef = makeFunctionReference<"mutation">(
  "users:ensureUser",
);
const ensureOrganizationRef = makeFunctionReference<"mutation">(
  "organizations:ensureOrganization",
);

/**
 * On /app mount: call Convex ensureUser + ensureOrganization.
 * Failures are swallowed (convex lane may lag).
 */
export function useEnsureMirror() {
  const convex = useConvex();
  const { isSignedIn, userId } = useAuth();
  const { organization } = useOrganization();
  const ranFor = useRef<string | null>(null);

  useEffect(() => {
    if (!isSignedIn || !userId) return;
    const key = `${userId}:${organization?.id ?? "none"}`;
    if (ranFor.current === key) return;
    ranFor.current = key;

    void (async () => {
      try {
        await convex.mutation(ensureUserRef, {});
      } catch (err) {
        console.warn(
          "[ensureUser] not ready or failed (convex lane may lag):",
          err,
        );
      }
      if (!organization?.id) return;
      try {
        await convex.mutation(ensureOrganizationRef, {
          clerkOrgId: organization.id,
        });
      } catch (err) {
        console.warn(
          "[ensureOrganization] not ready or failed (convex lane may lag):",
          err,
        );
      }
    })();
  }, [convex, isSignedIn, userId, organization?.id]);
}
