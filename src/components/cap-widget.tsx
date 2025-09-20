import { useQuery } from "@tanstack/react-query";
import { type } from "arktype";
import { atom, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import { Skeleton } from "~/components/ui/skeleton";

const capWidgetAtom = atom<{ reset?: () => void; token?: string }>({});

const EventArk = type({ detail: type({ token: "string" }) });

/** 5 min in ms */
const RESET_TIMEOUT = 1000 * 60 * 5;

export interface CapWidgetElement extends HTMLElement {
  reset: () => void;
}

export interface CapWidgetProps {
  onSolve?: (token: string) => void;
  ref?: React.RefObject<CapWidgetElement | null>;
}

export const CapWidget: React.FC<CapWidgetProps> = ({ onSolve, ref }) => {
  const capRef = useRef<{ reset?: () => void } & HTMLElement>(null);
  const resetTimerRef = useRef<null | ReturnType<typeof setTimeout>>(null);
  const setCapState = useSetAtom(capWidgetAtom);

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

  const handleSolve = useCallback(
    (e: Event) => {
      const t = EventArk.assert(e).detail.token;
      onSolve?.(t);
      setCapState((p) => ({ ...p, token: t }));

      clearResetTimer();
      resetTimerRef.current = setTimeout(() => {
        capRef.current?.reset?.();
      }, RESET_TIMEOUT);
    },
    [setCapState, onSolve],
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

  if (isPending) return <Skeleton className="h-[30px] w-[200px] rounded-full" />;

  return (
    // @ts-expect-error - JSX element type 'cap-widget' is not a constructor function for JSX elements.
    <cap-widget
      data-cap-api-endpoint="/api/cap/"
      onsolve={handleSolve}
      ref={(e: CapWidgetElement) => {
        capRef.current = e;
        if (ref) ref.current = e;
      }}
    />
  );
};
