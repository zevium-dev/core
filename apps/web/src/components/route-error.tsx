import type { ErrorComponentProps } from "@tanstack/react-router";
import { Link, useRouter } from "@tanstack/react-router";
import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";

import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";

const REQUEST_ID = /^[a-zA-Z0-9._:-]{1,128}$/;

export function routeErrorReference(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const direct = (error as Record<string, unknown>).requestId;
  if (typeof direct === "string" && REQUEST_ID.test(direct)) return direct;
  const cause = (error as Record<string, unknown>).cause;
  if (cause !== null && typeof cause === "object") {
    const nested = (cause as Record<string, unknown>).requestId;
    if (typeof nested === "string" && REQUEST_ID.test(nested)) return nested;
  }
  return null;
}

/** Branded, sanitized router-wide fallback. Never renders raw error text. */
export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  const queryErrorResetBoundary = useQueryErrorResetBoundary();
  const reference = routeErrorReference(error);

  useEffect(() => {
    // TanStack Query suspense errors must be reset before Router remounts the
    // route. Router invalidation coordinates loader reload + catch reset.
    queryErrorResetBoundary.reset();
  }, [queryErrorResetBoundary]);

  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-[60dvh] w-full max-w-2xl items-center px-4 py-12"
      data-router-error
    >
      <Card className="w-full">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-md bg-destructive/10 text-destructive">
            <TriangleAlert aria-hidden="true" className="size-5" />
          </div>
          <CardTitle>This view could not be loaded</CardTitle>
          <CardDescription>
            Your account data was not changed. Retry this view, or use one of
            the links below to keep working.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {reference ? (
            <p className="font-mono text-xs text-muted-foreground">
              Request {reference}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => {
                void router.invalidate();
              }}
            >
              Retry view
            </Button>
            <Button asChild variant="outline">
              <Link to="/app">Dashboard</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/catalogue">Browse APIs</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
