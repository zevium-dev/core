import { ClientOnly, createFileRoute, Outlet } from "@tanstack/react-router";

import { Redirect } from "~/components/redirect";
import { AppSidebar, PageHeader } from "~/components/sidebar";
import { ScreenCenter } from "~/components/ui/screen-center";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { sessionQueryOptions, useUser } from "~/lib/auth";

export const Route = createFileRoute("/app")({
  component: RouteComponent,
  loader: ({ context, params }) => {
    void context.queryClient.ensureQueryData(sessionQueryOptions());
    void context.queryClient.ensureQueryData(context.trpc.organization.list.queryOptions());

    if ("organizationSlug" in params && typeof params.organizationSlug === "string" && params.organizationSlug) {
      void context.queryClient.ensureQueryData(
        context.trpc.project.list.queryOptions({ organizationSlug: params.organizationSlug }),
      );
    }
  },
  pendingComponent: PendingComponent,
});

function PendingComponent() {
  return (
    <SidebarProvider>
      <ClientOnly fallback={<Skeleton className="h-full w-64" />}>
        <AppSidebar />
      </ClientOnly>
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
      <ClientOnly fallback={<Skeleton className="h-full w-64" />}>
        <AppSidebar />
      </ClientOnly>
      <SidebarInset>
        <PageHeader />
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
