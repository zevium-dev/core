import type { Query } from "@tanstack/react-query";

/**
 * SSR → browser cache handoff. Errored server prefetches stay on the server:
 * a hydrated error is final for `useSuspenseQuery`, while the browser's
 * Convex subscription would have recovered (e.g. "Organization not found"
 * before the first-visit mirror lands). Dropping it lets the client fetch live.
 */
export function shouldDehydrateQuery(query: Query): boolean {
  return query.state.status !== "error";
}
