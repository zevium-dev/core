import type { Easing } from "motion/react";

import { LoaderIcon, type LucideProps } from "lucide-react";
import * as m from "motion/react-m";

import { cn } from "~/lib/utils";

export const LoaderZero = (props: LucideProps) => {
  return <LoaderIcon {...props} className={cn("h-4 w-4 animate-spin", props.className)} />;
};

export const LoaderOne = () => {
  const transition = (x: number) => {
    return {
      delay: x * 0.2,
      duration: 1,
      ease: "easeInOut" as Easing,
      repeat: Infinity,
      repeatType: "loop" as const,
    };
  };
  return (
    <div className="flex items-center gap-2">
      <m.div
        animate={{
          y: [0, 10, 0],
        }}
        className="h-4 w-4 rounded-full border border-neutral-300 bg-gradient-to-b from-neutral-400 to-neutral-300"
        initial={{
          y: 0,
        }}
        transition={transition(0)}
      />
      <m.div
        animate={{
          y: [0, 10, 0],
        }}
        className="h-4 w-4 rounded-full border border-neutral-300 bg-gradient-to-b from-neutral-400 to-neutral-300"
        initial={{
          y: 0,
        }}
        transition={transition(1)}
      />
      <m.div
        animate={{
          y: [0, 10, 0],
        }}
        className="h-4 w-4 rounded-full border border-neutral-300 bg-gradient-to-b from-neutral-400 to-neutral-300"
        initial={{
          y: 0,
        }}
        transition={transition(2)}
      />
    </div>
  );
};

export const LoaderTwo = () => {
  const transition = (x: number) => {
    return {
      delay: x * 0.2,
      duration: 2,
      ease: "easeInOut" as Easing,
      repeat: Infinity,
      repeatType: "loop" as const,
    };
  };
  return (
    <div className="flex items-center">
      <m.div
        animate={{
          x: [0, 20, 0],
        }}
        className="h-4 w-4 rounded-full bg-neutral-200 shadow-md dark:bg-neutral-500"
        initial={{
          x: 0,
        }}
        transition={transition(0)}
      />
      <m.div
        animate={{
          x: [0, 20, 0],
        }}
        className="h-4 w-4 -translate-x-2 rounded-full bg-neutral-200 shadow-md dark:bg-neutral-500"
        initial={{
          x: 0,
        }}
        transition={transition(0.4)}
      />
      <m.div
        animate={{
          x: [0, 20, 0],
        }}
        className="h-4 w-4 -translate-x-4 rounded-full bg-neutral-200 shadow-md dark:bg-neutral-500"
        initial={{
          x: 0,
        }}
        transition={transition(0.8)}
      />
    </div>
  );
};

export const LoaderThree = () => {
  return (
    <m.svg
      className="h-20 w-20 stroke-neutral-500 [--fill-final:var(--color-yellow-300)] [--fill-initial:var(--color-neutral-50)] dark:stroke-neutral-100 dark:[--fill-final:var(--color-yellow-500)] dark:[--fill-initial:var(--color-neutral-800)]"
      fill="none"
      height="24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1"
      viewBox="0 0 24 24"
      width="24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <m.path d="M0 0h24v24H0z" fill="none" stroke="none" />
      <m.path
        animate={{ fill: "var(--fill-final)", pathLength: 1 }}
        d="M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11"
        initial={{ fill: "var(--fill-initial)", pathLength: 0 }}
        transition={{
          duration: 2,
          ease: "easeInOut",
          repeat: Infinity,
          repeatType: "reverse",
        }}
      />
    </m.svg>
  );
};

export const LoaderFour = ({ text = "Loading..." }: { text?: string }) => {
  return (
    <div className="relative font-bold text-black [perspective:1000px] dark:text-white">
      <m.span
        animate={{
          scaleX: [1, 2, 1],
          // skew: [0, -40, 0],
        }}
        className="relative z-20 inline-block"
        transition={{
          duration: 0.05,
          ease: "linear",
          repeat: Infinity,
          repeatDelay: 2,
          repeatType: "reverse",
          times: [0, 0.2, 0.5, 0.8, 1],
        }}
      >
        {text}
      </m.span>
      <m.span
        animate={{
          opacity: [0.3, 0.9, 0.4, 0.8, 0.3],
          x: [-2, 4, -3, 1.5, -2],
          y: [-2, 4, -3, 1.5, -2],
        }}
        className="absolute inset-0 text-[#00e571]/50 blur-[0.5px] dark:text-[#00e571]"
        transition={{
          duration: 0.5,
          ease: "linear",
          repeat: Infinity,
          repeatType: "reverse",
          times: [0, 0.2, 0.5, 0.8, 1],
        }}
      >
        {text}
      </m.span>
      <m.span
        animate={{
          opacity: [0.4, 0.8, 0.3, 0.9, 0.4],
          x: [0, 1, -1.5, 1.5, -1, 0],
          y: [0, -1, 1.5, -0.5, 0],
        }}
        className="absolute inset-0 text-[#8b00ff]/50 dark:text-[#8b00ff]"
        transition={{
          duration: 0.8,
          ease: "linear",
          repeat: Infinity,
          repeatType: "reverse",
          times: [0, 0.3, 0.6, 0.8, 1],
        }}
      >
        {text}
      </m.span>
    </div>
  );
};

export const LoaderFive = ({ text }: { text: string }) => {
  return (
    <div className="font-sans font-bold [--shadow-color:var(--color-neutral-500)] dark:[--shadow-color:var(--color-neutral-100)]">
      {text.split("").map((char, i) => (
        <m.span
          animate={{
            opacity: [0.5, 1, 0.5],
            scale: [1, 1.1, 1],
            textShadow: ["0 0 0 var(--shadow-color)", "0 0 1px var(--shadow-color)", "0 0 0 var(--shadow-color)"],
          }}
          className="inline-block"
          initial={{ opacity: 0.5, scale: 1 }}
          // eslint-disable-next-line @eslint-react/no-array-index-key
          key={i}
          transition={{
            delay: i * 0.05,
            duration: 0.5,
            ease: "easeInOut",
            repeat: Infinity,
            repeatDelay: 2,
            repeatType: "loop",
          }}
        >
          {char === " " ? "\u00A0" : char}
        </m.span>
      ))}
    </div>
  );
};
