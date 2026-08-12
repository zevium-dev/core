import { useReducedMotion } from "motion/react";
import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

/**
 * Keeps server markup and first client render identical while still honoring
 * the user's media preference immediately after hydration.
 */
export function useHydratedReducedMotion(): boolean {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const reduced = useReducedMotion();
  return hydrated && Boolean(reduced);
}
