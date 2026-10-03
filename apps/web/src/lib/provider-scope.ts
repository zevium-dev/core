const AUTHENTICATED_PATH = /^\/(?:app|admin|sign-in|sign-up)(?:\/|$)/;

/**
 * Public routes use plain Convex. App/admin layouts install Clerk + Convex auth;
 * sign-in/up install only Clerk. Keep auth code off the public cold path.
 */
export function needsAuthenticatedProviders(pathname: string): boolean {
  return AUTHENTICATED_PATH.test(pathname);
}
