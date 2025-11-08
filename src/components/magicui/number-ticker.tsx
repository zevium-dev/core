"use client";

import { useInView, useMotionValue, useSpring } from "motion/react";
import { ComponentPropsWithoutRef, useEffect, useRef } from "react";

import { cn } from "~/lib/utils/index";

interface NumberTickerProps extends ComponentPropsWithoutRef<"span"> {
  decimalPlaces?: number;
  delay?: number;
  direction?: "down" | "up";
  startValue?: number;
  value: number;
}

export function NumberTicker({
  className,
  decimalPlaces = 0,
  delay = 0,
  direction = "up",
  startValue = 0,
  value,
  ...props
}: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const motionValue = useMotionValue(direction === "down" ? value : startValue);
  const springValue = useSpring(motionValue, {
    damping: 60,
    stiffness: 100,
  });
  const isInView = useInView(ref, { margin: "0px", once: true });

  useEffect(() => {
    if (isInView) {
      const timer = setTimeout(() => {
        motionValue.set(direction === "down" ? startValue : value);
      }, delay * 1000);
      return () => clearTimeout(timer);
    }
  }, [motionValue, isInView, delay, value, direction, startValue]);

  useEffect(
    () =>
      springValue.on("change", (latest) => {
        if (ref.current) {
          ref.current.textContent = Intl.NumberFormat("en-US", {
            maximumFractionDigits: decimalPlaces,
            minimumFractionDigits: decimalPlaces,
          }).format(Number(latest.toFixed(decimalPlaces)));
        }
      }),
    [springValue, decimalPlaces],
  );

  return (
    <span
      className={cn(
        `
        inline-block tracking-wider text-black tabular-nums
        dark:text-white
      `,
        className,
      )}
      ref={ref}
      {...props}
    >
      {startValue}
    </span>
  );
}
