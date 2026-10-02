import { useSyncExternalStore } from "react";

import { prefersReducedMotion } from "#/lib/view-transition";

function subscribe(onChange: () => void) {
  const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}

/**
 * Keeps server markup and first client render identical while still honoring
 * the user's media preference immediately after hydration.
 */
export function useHydratedReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
