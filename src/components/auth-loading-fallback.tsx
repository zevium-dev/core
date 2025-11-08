import { Skeleton } from "~/components/ui/skeleton";

export function AuthLoadingFallback() {
  return (
    <div className="container mx-auto space-y-8 p-6">
      {/* Header skeleton */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-10 w-32" />
      </div>

      {/* Search skeleton */}
      <div className="relative">
        <Skeleton className="h-10 w-full max-w-md" />
      </div>

      {/* Grid skeleton */}
      <div
        className={`
        grid gap-6
        md:grid-cols-2
        lg:grid-cols-3
      `}
      >
        {[1, 2, 3, 4, 5, 6].map((id) => (
          <div className="space-y-4" key={id}>
            <Skeleton className="h-48 w-full rounded-lg" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
