import { m } from "motion/react";
import type { ReactNode } from "react";

import { useHydratedReducedMotion } from "#/hooks/use-hydrated-reduced-motion";
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
 * Visible-first DIST rise, viewport once, margin -60px.
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
  const reduce = useHydratedReducedMotion();
  const skip = reduce || vtState.active;
  const y = reduce ? 0 : distance;
  const Comp = m[as];

  return (
    <Comp
      className={cn(
        "motion-reduce:!transform-none motion-reduce:!opacity-100",
        className,
      )}
      // Content remains fully visible in SSR, no-JS, hydration, screenshots,
      // and slow clients. Motion is progressive enhancement, never a gate.
      initial={skip ? false : { y }}
      whileInView={{ y: 0 }}
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
