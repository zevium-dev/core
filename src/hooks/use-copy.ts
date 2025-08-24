import React from "react";

export const useCopy = ({ doneTimeout = 3000 } = {}) => {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  const copyToClipboard = React.useCallback(
    (text: string) => {
      if (typeof navigator === "undefined") return;

      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);

        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }

        timeoutRef.current = setTimeout(() => {
          setCopied(false);
          timeoutRef.current = null;
        }, doneTimeout);
      });
    },
    [doneTimeout],
  );

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  if (typeof window === "undefined") {
    return [false, () => void 0] as const;
  }

  return [copied, copyToClipboard] as const;
};
