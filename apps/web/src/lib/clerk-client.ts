/**
 * Typed, sync read of window.Clerk for client-side route beforeLoad/loaders.
 * Avoids HTTP round-trips to server fns on every client navigation.
 */

export interface ClientClerkUser {
  id: string;
}

export interface ClientClerkOrganization {
  id: string;
  slug: string | null;
}

/** Minimal Clerk browser surface — only fields we touch. */
export interface ClientClerk {
  user: ClientClerkUser | null | undefined;
  organization: ClientClerkOrganization | null | undefined;
  session: unknown;
}

declare global {
  interface Window {
    Clerk?: ClientClerk;
  }
}

export interface ClientClerkAuth {
  userId: string | null;
  orgId: string | null;
  orgSlug: string | null;
}

export interface ClientClerkAuthFallback {
  userId?: string | null;
  orgId?: string | null;
  orgSlug?: string | null;
}

/**
 * Sync client auth snapshot. Prefers live window.Clerk; falls back to
 * router context when Clerk has not hydrated yet (rare mid-nav race).
 */
export function readClientClerkAuth(
  fallback: ClientClerkAuthFallback = {},
): ClientClerkAuth {
  const clerk = typeof window !== "undefined" ? window.Clerk : undefined;

  const userId =
    clerk?.user === undefined
      ? (fallback.userId ?? null)
      : typeof clerk.user?.id === "string"
        ? clerk.user.id
        : null;

  const orgId =
    clerk?.organization === undefined
      ? (fallback.orgId ?? null)
      : typeof clerk.organization?.id === "string"
        ? clerk.organization.id
        : null;

  const liveSlug = clerk?.organization?.slug;
  const orgSlug =
    clerk?.organization === undefined
      ? typeof fallback.orgSlug === "string" && fallback.orgSlug.length > 0
        ? fallback.orgSlug
        : null
      : typeof liveSlug === "string" && liveSlug.length > 0
        ? liveSlug
        : null;

  return { userId, orgId, orgSlug };
}
