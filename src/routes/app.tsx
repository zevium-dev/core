import { createFileRoute, Outlet } from "@tanstack/react-router";

import { Redirect } from "~/components/redirect";
import { AppSidebar, PageHeader } from "~/components/sidebar";
import { ScreenCenter } from "~/components/ui/screen-center";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
import { Spinner } from "~/components/ui/spinner";
import { sessionQueryOptions, useUser } from "~/lib/auth";

export const Route = createFileRoute("/app")({
  component: RouteComponent,
  loader: ({ context }) => {
    void context.queryClient.ensureQueryData(sessionQueryOptions());
    void context.queryClient.ensureQueryData(context.trpc.organization.list.queryOptions());
  },
  pendingComponent: PendingComponent,
});

function PendingComponent() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <PageHeader />
        <ScreenCenter>
          <Spinner />
        </ScreenCenter>
      </SidebarInset>
    </SidebarProvider>
  );
}

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
