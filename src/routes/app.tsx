import { createFileRoute, Outlet } from "@tanstack/react-router";

import { Redirect } from "~/components/redirect";
import { AppSidebar, PageHeader } from "~/components/sidebar";
import { ScreenCenter } from "~/components/ui/screen-center";
import { SidebarInset, SidebarProvider, useSidebar } from "~/components/ui/sidebar";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { sessionQueryOptions, useSession } from "~/lib/auth";
import { getSidebarDefaultOpen, getSidebarDefaultOpenFromDocument } from "~/lib/sidebar-state";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/app")({
  component: RouteComponent,
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(sessionQueryOptions());
    await context.queryClient.ensureQueryData(context.trpc.organization.list.queryOptions());

    // @ts-expect-error - user is added by auth middleware but not typed in router context
    if (context.user) {
      if ("organizationSlug" in params && typeof params.organizationSlug === "string" && params.organizationSlug) {
        await context.queryClient.ensureQueryData(
          context.trpc.project.list.queryOptions({ organizationSlug: params.organizationSlug }),
        );
      }
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
    <Skeleton
      className={cn(
        "hidden h-full md:block",
        state === "collapsed" ? "w-(--sidebar-width-icon)" : "w-(--sidebar-width)",
      )}
      data-collapsible={state === "collapsed" ? "icon" : ""}
    />
  );
}

function PendingComponent() {
  const match = Route.useMatch();
  const sidebarDefaultOpen = match.loaderData?.sidebarDefaultOpen ?? getSidebarDefaultOpenFromDocument() ?? true;

  return (
    <SidebarProvider defaultOpen={sidebarDefaultOpen}>
      <AppSidebarFallback />
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
      <AppSidebar />
      <SidebarInset>
        <PageHeader />
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
