import { createFileRoute, Outlet } from "@tanstack/react-router";

import { Redirect } from "~/components/redirect";
import { AppSidebar, PageHeader } from "~/components/sidebar";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
import { useUser } from "~/lib/auth";

export const Route = createFileRoute("/app")({
  component: RouteComponent,
});

function RouteComponent() {
  const user = useUser();
  if (!user) return <Redirect to="/auth/sign-in" />;

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <PageHeader />
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
