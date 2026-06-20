import type { PropsWithChildren } from "react";

import { ClientOnly } from "@tanstack/react-router";

import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";

interface AuthFormClientOnlyProps extends PropsWithChildren {
  fields: Array<AuthFormFieldSkeleton>;
}

interface AuthFormFieldSkeleton {
  hasTopRightAction?: boolean;
  labelWidthClass: string;
}

const renderFieldSkeleton = (field: AuthFormFieldSkeleton, index: number) => {
  return (
    <div className="grid gap-3" key={`${field.labelWidthClass}-${index}`}>
      {field.hasTopRightAction ? (
        <div className="flex items-center gap-2">
          <Skeleton className={cn("h-3.5", field.labelWidthClass)} />
          <Skeleton className="ml-auto h-4 w-32" />
        </div>
      ) : (
        <Skeleton className={cn("h-3.5", field.labelWidthClass)} />
      )}
      <Skeleton className="h-9 w-full" />
      <Skeleton className="ml-auto h-4 w-24" />
    </div>
  );
};

export function AuthFormClientOnly({ children, fields }: AuthFormClientOnlyProps) {
  return (
    <ClientOnly
      fallback={
        <div className="grid gap-6">
          {fields.map(renderFieldSkeleton)}
          <Skeleton className="h-9 w-full" />
        </div>
      }
    >
      {children}
    </ClientOnly>
  );
}
