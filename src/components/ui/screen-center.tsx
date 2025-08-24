import * as React from "react";

import { cn } from "~/lib/utils";

import { TextHoverEffect } from "./text-hover-effect";

export const ScreenCenter: React.FC<React.PropsWithChildren<{ className?: string }>> = ({ children, className }) => {
  return (
    <div className={cn("flex flex-1 snap-start flex-col items-center justify-center overflow-clip", className)}>
      {children}
      <div className="mt-8 flex h-32 max-w-xl items-center justify-center">
        <TextHoverEffect text="boi.gg" />
      </div>
    </div>
  );
};
