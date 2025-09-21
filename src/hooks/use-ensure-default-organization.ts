import { useEffect, useState } from "react";

import { auth } from "~/lib/auth";
import { useTRPCClient } from "~/lib/trpc";

/**
 * Component that automatically ensures a user has a default organization.
 * Include this component in your app after authentication is set up.
 */
export function AutoCreateDefaultOrganization() {
  useEnsureDefaultOrganization();
  return null; // This component doesn't render anything
}

/**
 * Hook to ensure a user has a default organization created automatically.
 * This should be called once when the user logs in for the first time.
 */
export function useEnsureDefaultOrganization() {
  const [isChecking, setIsChecking] = useState(false);
  const [hasChecked, setHasChecked] = useState(false);
  const [organizationCreated, setOrganizationCreated] = useState(false);

  const { data: session } = auth.useSession();
  const trpcClient = useTRPCClient();

  useEffect(() => {
    async function checkAndCreateOrganization() {
      // Only run if user is logged in and we haven't checked yet
      if (!session?.user || hasChecked || isChecking) {
        return;
      }

      setIsChecking(true);

      try {
        const result = await trpcClient.organization.ensureDefaultOrganization.mutate();

        if (result.created) {
          setOrganizationCreated(true);
          console.log("Default organization created for user:", session.user.email);
        }

        setHasChecked(true);
      } catch (error) {
        console.error("Failed to ensure default organization:", error);
        setHasChecked(true); // Mark as checked to avoid infinite retries
      } finally {
        setIsChecking(false);
      }
    }

    void checkAndCreateOrganization();
  }, [session?.user, hasChecked, isChecking, trpcClient]);

  return {
    hasChecked,
    isChecking,
    organizationCreated,
  };
}
