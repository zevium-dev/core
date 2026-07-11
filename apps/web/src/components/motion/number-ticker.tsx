import { useEffect, useRef, useState } from "react";

import { DUR } from "#/lib/motion";
import { cn } from "#/lib/utils";

export type NumberTickerProps = {
  value: number;
  className?: string;
  /** Fraction digits for display (default 0). */
  decimals?: number;
  format?: (n: number) => string;
};

function defaultFormat(n: number, decimals: number): string {
  return n.toLocaleString(undefined, {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
}: NumberTickerProps) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (prefersReducedMotion()) {
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
      fromRef.current = to;
    };
  }, [value]);

  const text =
    format !== undefined
      ? format(display)
      : defaultFormat(
          decimals === 0 ? Math.round(display) : display,
          decimals,
        );

  return (
    <span
      className={cn("tabular-nums", className)}
      style={{ viewTransitionName: "credit-balance" }}
    >
      {text}
    </span>
  );
}
