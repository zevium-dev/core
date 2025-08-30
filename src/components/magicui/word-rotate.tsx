"use client";

import { AnimatePresence, m, MotionProps } from "motion/react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils/index";

interface WordRotateProps {
  className?: string;
  duration?: number;
  motionProps?: MotionProps;
  words: Array<string>;
}

const defaultMotionProps: MotionProps = {
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 50 },
  initial: { opacity: 0, y: -50 },
  transition: { duration: 0.25, ease: "easeOut" },
};

export function WordRotate({ className, duration = 2500, motionProps = defaultMotionProps, words }: WordRotateProps) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setIndex((prevIndex) => (prevIndex + 1) % words.length);
    }, duration);

    // Clean up interval on unmount
    return () => clearInterval(interval);
  }, [words, duration]);

  return (
    <div className="overflow-hidden py-2">
      <AnimatePresence mode="wait">
        <m.h1 className={cn(className)} key={words[index]} {...motionProps}>
          {words[index]}
        </m.h1>
      </AnimatePresence>
    </div>
  );
}
