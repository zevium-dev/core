import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "~/lib/utils/index";

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-base border-2 border-border px-2.5 py-0.5 text-xs font-base w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] overflow-hidden",
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default: "bg-main text-main-foreground",
        neutral: "bg-secondary-background text-foreground",
      },
    },
  },
);

function Badge({
  asChild = false,
  className,
  variant,
  ...props
}: {
  asChild?: boolean;
} & React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants>) {
  const Comp = asChild ? Slot : "span";

  return <Comp className={cn(badgeVariants({ variant }), className)} data-slot="badge" {...props} />;
}

export { Badge, badgeVariants };
