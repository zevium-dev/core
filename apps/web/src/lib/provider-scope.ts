const AUTHENTICATED_PATH = /^\/(?:app|admin|sign-in|sign-up)(?:\/|$)/;

/**
 * Public routes use plain Convex. Authenticated route layouts install Clerk +
 * Convex auth themselves so their code stays out of the public cold path.
 */
export function needsAuthenticatedProviders(pathname: string): boolean {
  return AUTHENTICATED_PATH.test(pathname);
}
