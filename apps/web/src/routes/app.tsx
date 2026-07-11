import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { AppHeader } from "#/components/app-header";
import { AppSidebar } from "#/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "#/components/ui/sidebar";
import { useEnsureMirror } from "#/hooks/use-ensure-mirror";
import { readClientClerkAuth } from "#/lib/clerk-client";
import { requireAuth } from "#/lib/auth-session";
import type { RouterContext } from "#/router";

export const Route = createFileRoute("/app")({
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
      // requireAuth throws redirect; rethrow known redirects, else force sign-in
      if (err && typeof err === "object" && "to" in err) {
        throw err;
      }
      throw redirect({ to: "/sign-in/$" });
    }
  },
  component: AppLayout,
});

function AppLayout() {
  useEnsureMirror();

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <AppHeader />
        <main
          className="flex flex-1 flex-col gap-4 p-4 md:p-6 content-enter"
          style={{ viewTransitionName: "main-content" }}
        >
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
