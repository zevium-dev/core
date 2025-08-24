import React from "react";

import { cn } from "~/lib/utils";

import { Button, type ButtonProps } from "./button";
import { LoaderZero } from "./loader";

export const SubmitButton: React.FC<{ loading?: boolean } & ButtonProps> = ({ children, loading, ...props }) => {
  return (
    <Button
      type="submit"
      {...props}
      className={cn("relative", props.className)}
      onClick={(e) => {
        if (loading) {
          e.preventDefault();
        }
      }}
    >
      {loading && (
        <span className="pointer-events-none absolute top-0 left-0 flex h-full w-full items-center justify-center">
          <LoaderZero />
        </span>
      )}
      <span className={cn({ invisible: loading })}>{children}</span>
    </Button>
  );
};
