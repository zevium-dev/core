import { useCallback, useRef } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useDebounceHandler<T extends (...args: Array<any>) => any>(handler: T, delayMs = 3000) {
  const timeoutRef = useRef<null | number>(null);

  const debouncedHandler = useCallback(
    (...args: Parameters<T>) => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = window.setTimeout(() => {
        handler(...args);
      }, delayMs);
    },
    [handler, delayMs],
  );

  return debouncedHandler;
}
