import { useEffect, useState } from "react";

import { Button } from "#/components/ui/button";
import { Skeleton } from "#/components/ui/skeleton";

type AuthCardSkeletonProps = {
  label: string;
};

/**
 * Clerk loads its UI bundle after hydration. Keep that network wait visible and
 * layout-stable instead of flashing an empty page.
 */
export function AuthCardSkeleton({ label }: AuthCardSkeletonProps) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 8_000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      role="status"
      aria-label={label}
      className="w-full max-w-sm rounded-xl border bg-card p-8 shadow-sm"
    >
      <div
        aria-hidden={slow ? undefined : "true"}
        className="flex flex-col gap-6"
      >
        <div className="flex flex-col items-center gap-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-56 max-w-full" />
        </div>
        <Skeleton className="h-10 w-full" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-px flex-1" />
          <Skeleton className="h-3 w-5" />
          <Skeleton className="h-px flex-1" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-10 w-full" />
        </div>
        <Skeleton className="h-10 w-full" />
        {slow ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">
                Authentication is taking longer than expected.
              </p>
              <p className="text-xs text-muted-foreground">
                Check your connection, then retry.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => window.location.reload()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <Skeleton className="mx-auto h-4 w-48 max-w-full" />
        )}
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}
