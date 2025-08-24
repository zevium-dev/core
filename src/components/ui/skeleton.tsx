import { cn } from "~/lib/utils/index";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-base bg-secondary-background border-border animate-pulse border-2", className)}
      data-slot="skeleton"
      {...props}
    />
  );
}

export { Skeleton };
