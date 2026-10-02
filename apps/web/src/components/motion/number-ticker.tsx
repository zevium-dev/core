import { useEffect, useRef, useState } from "react";

import { DUR } from "#/lib/motion";
import { useHydratedReducedMotion } from "#/hooks/use-hydrated-reduced-motion";
import { vtState } from "#/lib/vt";
import { cn } from "#/lib/utils";

export type NumberTickerProps = {
  value: number;
  className?: string;
  /** Fraction digits for display (default 0). */
  decimals?: number;
  format?: (n: number) => string;
  /**
   * Optional view-transition-name (e.g. "credit-balance").
   * Only set on the single shared element that morphs — never on every ticker.
   */
  viewTransitionName?: string;
};

function defaultFormat(n: number, decimals: number): string {
  return n.toLocaleString("en-US", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
}

/**
 * Count-up for credits balance / stats.
 * Cubic ease-out ≤1s; reduced-motion renders final value immediately.
 */
export function NumberTicker({
  value,
  className,
  decimals = 0,
  format,
  viewTransitionName,
}: NumberTickerProps) {
  const reduce = useHydratedReducedMotion();
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduce || vtState.active) {
      setDisplay(value);
      fromRef.current = value;
      return;
    }

    const from = fromRef.current;
    const to = value;
    if (from === to) {
      setDisplay(to);
      return;
    }

    const durationMs = Math.min(1000, DUR.slow * 1000);
    const start = performance.now();

    const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / durationMs);
      const next = from + (to - from) * easeOutCubic(t);
      fromRef.current = next;
      setDisplay(next);
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        setDisplay(to);
        fromRef.current = to;
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [reduce, value]);

  const visibleValue = reduce ? value : display;
  const text =
    format !== undefined
      ? format(visibleValue)
      : defaultFormat(
          decimals === 0 ? Math.round(visibleValue) : visibleValue,
          decimals,
        );

  return (
    <span
      className={cn("tabular-nums", className)}
      style={viewTransitionName ? { viewTransitionName } : undefined}
    >
      {text}
    </span>
  );
}
