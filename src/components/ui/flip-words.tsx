import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useCallback, useEffect, useState } from "react";

import { cn } from "~/lib/utils";

export const FlipWords = ({
  className,
  duration = 3000,
  words,
}: {
  className?: string;
  duration?: number;
  words: Array<string>;
}) => {
  const [currentWord, setCurrentWord] = useState(words[0]);
  const [isAnimating, setIsAnimating] = useState<boolean>(false);

  // thanks for the fix Julian - https://github.com/Julian-AT
  const startAnimation = useCallback(() => {
    const word = words[words.indexOf(currentWord) + 1] || words[0];
    setCurrentWord(word);
    setIsAnimating(true);
  }, [currentWord, words]);

  useEffect(() => {
    if (!isAnimating) {
      const timeoutId = window.setTimeout(() => {
        startAnimation();
      }, duration);
      return () => {
        window.clearTimeout(timeoutId);
      };
    }
  }, [isAnimating, duration, startAnimation]);

  return (
    <AnimatePresence
      onExitComplete={() => {
        setIsAnimating(false);
      }}
    >
      <m.div
        animate={{
          opacity: 1,
          y: 0,
        }}
        className={cn("relative z-10 inline-block px-2 text-left text-neutral-900 dark:text-neutral-100", className)}
        exit={{
          filter: "blur(8px)",
          opacity: 0,
          position: "absolute",
          scale: 2,
          x: 40,
          y: -40,
        }}
        initial={{
          opacity: 0,
          y: 10,
        }}
        key={currentWord}
        transition={{
          damping: 10,
          stiffness: 100,
          type: "spring",
        }}
      >
        {/* edit suggested by Sajal: https://x.com/DewanganSajal */}
        {currentWord.split(" ").map((word, wordIndex) => (
          <m.span
            animate={{ filter: "blur(0px)", opacity: 1, y: 0 }}
            className="inline-block whitespace-nowrap"
            initial={{ filter: "blur(8px)", opacity: 0, y: 10 }}
            key={word + wordIndex.toString()}
            transition={{
              delay: wordIndex * 0.3,
              duration: 0.3,
            }}
          >
            {word.split("").map((letter, letterIndex) => (
              <m.span
                animate={{ filter: "blur(0px)", opacity: 1, y: 0 }}
                className="inline-block"
                initial={{ filter: "blur(8px)", opacity: 0, y: 10 }}
                key={word + letterIndex.toString()}
                transition={{
                  delay: wordIndex * 0.3 + letterIndex * 0.05,
                  duration: 0.2,
                }}
              >
                {letter}
              </m.span>
            ))}
            <span className="inline-block">&nbsp;</span>
          </m.span>
        ))}
      </m.div>
    </AnimatePresence>
  );
};
