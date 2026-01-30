import { ClientOnly, createFileRoute, Outlet } from "@tanstack/react-router";

import { Redirect } from "~/components/redirect";
import { AppSidebar, PageHeader } from "~/components/sidebar";
import { ScreenCenter } from "~/components/ui/screen-center";
import { SidebarInset, SidebarProvider, useSidebar } from "~/components/ui/sidebar";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { sessionQueryOptions, useSession } from "~/lib/auth";
import { getSidebarDefaultOpen, getSidebarDefaultOpenFromDocument } from "~/lib/sidebar-state";

export const Route = createFileRoute("/app")({
  component: RouteComponent,
  loader: async ({ context, params }) => {
    void context.queryClient.ensureQueryData(sessionQueryOptions());
    void context.queryClient.ensureQueryData(context.trpc.organization.list.queryOptions());

    if ("organizationSlug" in params && typeof params.organizationSlug === "string" && params.organizationSlug) {
      void context.queryClient.ensureQueryData(
        context.trpc.project.list.queryOptions({ organizationSlug: params.organizationSlug }),
      );
    }

    return {
      sidebarDefaultOpen: await getSidebarDefaultOpen(),
    };
  },
  pendingComponent: PendingComponent,
});

function AppSidebarFallback() {
  const { state } = useSidebar();
  return (
    <Skeleton className={state === "collapsed" ? "h-full w-(--sidebar-width-icon)" : "h-full w-(--sidebar-width)"} />
  );
}

function PendingComponent() {
  const sidebarDefaultOpen = getSidebarDefaultOpenFromDocument() ?? true;

  return (
    <SidebarProvider defaultOpen={sidebarDefaultOpen}>
      <ClientOnly fallback={<AppSidebarFallback />}>
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
  const user = useSession().user;
  const { sidebarDefaultOpen } = Route.useLoaderData();
  if (!user) return <Redirect to="/auth/sign-in" />;

  return (
    <SidebarProvider defaultOpen={sidebarDefaultOpen}>
      <ClientOnly fallback={<AppSidebarFallback />}>
        <AppSidebar />
      </ClientOnly>
      <SidebarInset>
        <PageHeader />
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
