import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import { ShieldAlert } from "lucide-react";

import { AdminHeader } from "#/components/admin-header";
import { Button } from "#/components/ui/button";
import { Skeleton } from "#/components/ui/skeleton";
import { api } from "#/lib/convex-api";
import { readClientClerkAuth } from "#/lib/clerk-client";
import { requireAuth } from "#/lib/auth-session";
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

  if (adminQuery.data !== true) {
    return <NotAuthorized />;
  }

  return (
    <div className="flex min-h-svh flex-col">
      <AdminHeader />
      <main
        className="flex flex-1 flex-col gap-4 p-4 md:p-6 content-enter"
        style={{ viewTransitionName: "main-content" }}
      >
        <Outlet />
      </main>
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
          <a href="/app">Back to app</a>
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
