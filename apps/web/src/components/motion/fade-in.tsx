import { m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

import { DUR, EASE } from "#/lib/motion";
import { vtState } from "#/lib/vt";
import { cn } from "#/lib/utils";

type FadeInProps = {
  children: ReactNode;
  className?: string;
  /** Override duration; default DUR.fast (skeleton→content). */
  duration?: number;
};

/**
 * Skeleton→content crossfade (DESIGN.md).
 * Opacity only when reduced-motion; skips enter during active view transitions.
 */
export function FadeIn({
  children,
  className,
  duration = DUR.fast,
}: FadeInProps) {
  const reduce = useReducedMotion();
  const skip = reduce || vtState.active;

  return (
    <m.div
      className={cn(className)}
      initial={skip ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduce ? 0 : duration, ease: EASE }}
    >
      {children}
    </m.div>
  );
}
