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
        archived: "border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300",
        beta: "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300",
        deprecated: "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300",
        inactive: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300",
      },
    },
  },
);

export interface BadgeStatusProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeStatusVariants> {
  status?: "active" | "archived" | "beta" | "deprecated" | "inactive";
}

const StatusIndicator = ({ status }: { status: "active" | "archived" | "beta" | "deprecated" | "inactive" }) => (
  <div className={cn(
    "h-1.5 w-1.5 rounded-full",
    status === "active" && "bg-green-500",
    status === "archived" && "bg-gray-500",
    status === "beta" && "bg-orange-500",
    status === "deprecated" && "bg-red-500",
    status === "inactive" && "bg-slate-500"
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
