import { m } from "motion/react";
import { useSyncExternalStore, type ReactNode } from "react";

import { useHydratedReducedMotion } from "#/hooks/use-hydrated-reduced-motion";
import { DUR, EASE } from "#/lib/motion";
import { vtState } from "#/lib/vt";
import { cn } from "#/lib/utils";

type FadeInProps = {
  children: ReactNode;
  className?: string;
  /** Override duration; default DUR.fast (skeleton→content). */
  duration?: number;
};

const subscribe = () => () => undefined;

/**
 * Skeleton→content crossfade (.agents/notes/design/design-system.md).
 * Opacity only when reduced-motion; skips enter during active view transitions.
 */
export function FadeIn({
  children,
  className,
  duration = DUR.fast,
}: FadeInProps) {
  const reduce = useHydratedReducedMotion();
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const skip = !hydrated || reduce || vtState.active;

  return (
    <m.div
      className={cn("motion-entrance motion-reduce:!opacity-100", className)}
      initial={skip ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: skip ? 0 : duration, ease: EASE }}
    >
      {children}
    </m.div>
  );
}
