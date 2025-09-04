import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "~/lib/utils";

const badgeStatusVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    defaultVariants: {
      variant: "active",
    },
    variants: {
      variant: {
        active: "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300",
        beta: "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300",
        deprecated: "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300",
      },
    },
  }
);

export interface BadgeStatusProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeStatusVariants> {
  status?: "active" | "beta" | "deprecated";
}

const StatusIndicator = ({ status }: { status: "active" | "beta" | "deprecated" }) => (
  <div className={cn(
    "h-1.5 w-1.5 rounded-full",
    status === "active" && "bg-green-500",
    status === "beta" && "bg-orange-500",
    status === "deprecated" && "bg-red-500"
  )} />
);

function BadgeStatus({ children, className, status, variant, ...props }: BadgeStatusProps) {
  const statusVariant = status ?? variant ?? "active";

  return (
    <div className={cn(badgeStatusVariants({ variant: statusVariant }), className)} {...props}>
      <StatusIndicator status={statusVariant} />
      {children}
    </div>
  );
}

export { BadgeStatus, badgeStatusVariants };
