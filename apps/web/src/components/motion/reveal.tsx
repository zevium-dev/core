import { m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

import { DIST, DUR, EASE } from "#/lib/motion";
import { vtState } from "#/lib/vt";
import { cn } from "#/lib/utils";

type RevealProps = {
  children: ReactNode;
  className?: string;
  /** Landing uses DUR.slow; in-app can pass DUR.base. */
  duration?: number;
  /** Stagger delay for list children: i * STAGGER. */
  delay?: number;
  /** Rise distance; 0 when reduced-motion. */
  distance?: number;
  as?: "div" | "section" | "header" | "footer" | "li";
};

/**
 * Scroll-entrance wrapper (DESIGN.md `<Reveal>`).
 * Fade + DIST rise, viewport once, margin -60px.
 * Final state when reduced-motion or active view transition.
 */
export function Reveal({
  children,
  className,
  duration = DUR.slow,
  delay = 0,
  distance = DIST,
  as = "div",
}: RevealProps) {
  const reduce = useReducedMotion();
  const skip = Boolean(reduce) || vtState.active;
  const y = reduce ? 0 : distance;
  const Comp = m[as];

  return (
    <Comp
      className={cn(className)}
      initial={skip ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{
        duration: reduce ? 0 : duration,
        ease: EASE,
        delay: reduce ? 0 : delay,
      }}
    >
      {children}
    </Comp>
  );
}
