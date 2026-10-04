const AUTHENTICATED_PATH = /^\/(?:app|admin|sign-in|sign-up)(?:\/|$)/;

/**
 * App/admin layouts install Clerk + Convex auth; sign-in/up install only Clerk.
 * Public routes use plain Convex, with auth added to signed-in API details for
 * verified reviews. Keep auth code off the anonymous public cold path.
 */
export function needsAuthenticatedProviders(pathname: string): boolean {
  return AUTHENTICATED_PATH.test(pathname);
}
