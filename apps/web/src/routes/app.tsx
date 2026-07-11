import {
  Outlet,
  createFileRoute,
  redirect,
} from "@tanstack/react-router";

import { AppHeader } from "#/components/app-header";
import { AppSidebar } from "#/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "#/components/ui/sidebar";
import { useEnsureMirror } from "#/hooks/use-ensure-mirror";
import { requireAuth } from "#/lib/auth-session";

export const Route = createFileRoute("/app")({
  beforeLoad: async () => {
    try {
      await requireAuth();
    } catch (err) {
      // requireAuth throws redirect; rethrow known redirects, else force sign-in
      if (
        err &&
        typeof err === "object" &&
        "to" in err
      ) {
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
