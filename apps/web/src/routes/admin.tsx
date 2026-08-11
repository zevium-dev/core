import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
} from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import { ShieldAlert } from "lucide-react";

import { AdminHeader } from "#/components/admin-header";
import { Button } from "#/components/ui/button";
import { Skeleton } from "#/components/ui/skeleton";
import { api } from "#/lib/convex-api";
import { readClientClerkAuth } from "#/lib/clerk-client";
import { requireAuth } from "#/lib/auth-session";
import { humanError } from "#/lib/human-error";
import type { RouterContext } from "#/router";

export const Route = createFileRoute("/admin")({
  beforeLoad: async ({ context }) => {
    // Client: gate from live Clerk / cached context — no server fn.
    if (typeof window !== "undefined") {
      const { userId } = readClientClerkAuth({
        userId: (context as RouterContext).userId,
      });
      if (!userId) {
        throw redirect({ to: "/sign-in/$" });
      }
      return;
    }

    // SSR: full server auth check.
    try {
      await requireAuth();
    } catch (err) {
      if (err && typeof err === "object" && "to" in err) {
        throw err;
      }
      throw redirect({ to: "/sign-in/$" });
    }
  },
  component: AdminLayout,
});

function AdminLayout() {
  // Convex auth must be loaded before the safe isAdminQuery result is real.
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
  const adminQuery = useQuery(convexQuery(api.admin.isAdminQuery, {}));

  if (convexAuthLoading || !isAuthenticated || adminQuery.isPending) {
    return <AdminShellSkeleton />;
  }

  if (adminQuery.isError) {
    return (
      <AdminGateError
        message={humanError(
          adminQuery.error,
          "Could not verify platform admin access.",
        )}
        onRetry={() => void adminQuery.refetch()}
      />
    );
  }

  if (adminQuery.data !== true) {
    return <NotAuthorized />;
  }

  return (
    <div className="flex min-h-svh flex-col">
      <a
        href="#main-content"
        className="fixed top-3 left-3 z-50 -translate-y-24 rounded-md bg-background px-3 py-2 text-sm font-medium shadow-md outline-none transition-transform duration-[var(--dur-instant)] ease-[var(--ease)] focus-visible:translate-y-0 focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none"
      >
        Skip to content
      </a>
      <AdminHeader />
      <main
        id="main-content"
        tabIndex={-1}
        className="flex flex-1 flex-col gap-4 p-4 focus-visible:outline-none md:p-6 content-enter"
        style={{ viewTransitionName: "main-content" }}
      >
        <Outlet />
      </main>
    </div>
  );
}

function AdminGateError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-muted">
          <ShieldAlert className="size-5 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Access check unavailable
          </h1>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" onClick={onRetry}>
            Retry
          </Button>
          <Button asChild variant="outline">
            <Link to="/app">Back to app</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

function NotAuthorized() {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-muted">
          <ShieldAlert className="size-5 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Not authorized
          </h1>
          <p className="text-sm text-muted-foreground">
            Platform admin access is required to view this page.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/app">Back to app</Link>
        </Button>
      </div>
    </div>
  );
}

function AdminShellSkeleton() {
  return (
    <div className="flex min-h-svh flex-col">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-20" />
      </div>
      <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
    </div>
  );
}
