import { useQuery } from "@tanstack/react-query";
import { type } from "arktype";
import { atom, useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import { Skeleton } from "~/components/ui/skeleton";

const capWidgetAtom = atom<{ reset?: () => void; token?: string }>({});

export const useCapState = () => useAtomValue(capWidgetAtom);

const EventArk = type({ detail: type({ token: "string" }) });

/** 5 min in ms */
const RESET_TIMEOUT = 1000 * 60 * 5;

export const CapWidget = () => {
  const capRef = useRef<{ reset?: () => void } & HTMLElement>(null);
  const resetTimerRef = useRef<null | ReturnType<typeof setTimeout>>(null);
  const [, setCapState] = useAtom(capWidgetAtom);

  useEffect(() => {
    setCapState((p) => ({ ...p, reset: () => capRef.current?.reset?.() }));
  }, [setCapState]);

  const clearResetTimer = () => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      clearResetTimer();
    };
  }, []);

  const onSolve = useCallback(
    (e: Event) => {
      const t = EventArk.assert(e).detail.token;
      setCapState((p) => ({ ...p, token: t }));

      clearResetTimer();
      resetTimerRef.current = setTimeout(() => {
        capRef.current?.reset?.();
      }, RESET_TIMEOUT);
    },
    [setCapState],
  );

  const { isPending } = useQuery({
    queryFn: async () => {
      // @ts-expect-error - Cap widget does not have types
      await import("@cap.js/widget");
      return true;
    },
    queryKey: ["cap-lib"],
    staleTime: Infinity,
  });

  if (isPending) return <Skeleton className="h-[30px] w-[160px] rounded-full" />;

  // @ts-expect-error - JSX element type 'cap-widget' is not a constructor function for JSX elements.
  return <cap-widget data-cap-api-endpoint="/api/cap/" id="cap" onsolve={onSolve} ref={capRef} />;
};
