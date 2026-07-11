import {
  m,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from "motion/react";
import {
  useCallback,
  useRef,
  type PointerEvent,
  type ReactNode,
} from "react";

import { SPRING } from "#/lib/motion";
import { cn } from "#/lib/utils";

type MagneticProps = {
  children: ReactNode;
  className?: string;
  /** Pull strength 0–1; DESIGN.md caps ≤0.3. */
  strength?: number;
};

/**
 * Landing-only magnetic cursor-pull (DESIGN.md delight budget).
 * Off for reduced-motion + coarse pointers (touch).
 */
export function Magnetic({
  children,
  className,
  strength = 0.3,
}: MagneticProps) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const x = useSpring(rawX, SPRING.cursor);
  const y = useSpring(rawY, SPRING.cursor);

  const reset = useCallback(() => {
    rawX.set(0);
    rawY.set(0);
  }, [rawX, rawY]);

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (reduce) return;
      // Touch / pen: skip magnetic (coarse pointer)
      if (event.pointerType !== "mouse") return;
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      rawX.set((event.clientX - cx) * strength);
      rawY.set((event.clientY - cy) * strength);
    },
    [rawX, rawY, reduce, strength],
  );

  if (reduce) {
    return <div className={cn("inline-flex", className)}>{children}</div>;
  }

  return (
    <m.div
      ref={ref}
      className={cn("inline-flex will-change-transform", className)}
      style={{ x, y }}
      onPointerMove={onPointerMove}
      onPointerLeave={reset}
      onPointerCancel={reset}
    >
      {children}
    </m.div>
  );
}
