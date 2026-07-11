import { useOrganization } from "@clerk/tanstack-react-start";

/**
 * Active Clerk org slug for Convex org-scoped queries.
 * Null while Clerk loads or when no org is selected.
 */
export function useActiveOrgSlug(): {
  orgSlug: string | null;
  isLoaded: boolean;
} {
  const { organization, isLoaded } = useOrganization();
  const orgSlug =
    organization && typeof organization.slug === "string"
      ? organization.slug
      : null;
  return { orgSlug, isLoaded };
}
