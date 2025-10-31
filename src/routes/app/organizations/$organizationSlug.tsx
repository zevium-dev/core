import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";

import { PageHeaderContent } from "~/components/sidebar";
import { Typography } from "~/components/ui/typography";
import { useTRPC } from "~/lib/trpc";

export const Route = createFileRoute("/app/organizations/$organizationSlug")({
  component: RouteComponent,
  loader: ({ context, params }) => {
    void context.queryClient.ensureQueryData(context.trpc.organization.get.queryOptions(params));
    // Intentionally removed prefetching of projects list to prevent hydration error with app sidebar
    // The app sidebar fetches the projects list but it's gonna fail when not on $organizationSlug route
    // Prefetching it here causes a mismatch between server and client
    // void context.queryClient.ensureQueryData(context.trpc.project.list.queryOptions(params));
  },
});

function RouteComponent() {
  const { organizationSlug } = Route.useParams();
  const trpc = useTRPC();
  const organizationDetailsQuery = useSuspenseQuery(trpc.organization.get.queryOptions({ organizationSlug }));

  return (
    <>
      <PageHeaderContent>
        <Typography variant="large">{organizationDetailsQuery.data.name}</Typography>
      </PageHeaderContent>
      <Outlet />
    </>
  );
}
