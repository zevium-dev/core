"use client";

import * as LabelPrimitive from "@radix-ui/react-label";
import * as React from "react";

import { cn } from "~/lib/utils/index";

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn(
        "font-heading text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className,
      )}
      data-slot="label"
      {...props}
    />
  );
}

export { Label };
