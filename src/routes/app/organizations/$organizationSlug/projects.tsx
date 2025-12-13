import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";

import { PageHeaderContent } from "~/components/sidebar";
import { Typography } from "~/components/ui/typography";
import { useTRPC } from "~/lib/trpc";

export const Route = createFileRoute("/app/organizations/$organizationSlug/projects")({
  component: RouteComponent,
  loader: ({ context, params }) => {
    void context.queryClient.ensureQueryData(
      context.trpc.organization.get.queryOptions({ organizationSlug: params.organizationSlug }),
    );
  },
});

function RouteComponent() {
  const { organizationSlug } = Route.useParams();
  const trpc = useTRPC();
  const organizationDetailsQuery = useSuspenseQuery(trpc.organization.get.queryOptions({ organizationSlug }));
  return (
    <>
      <PageHeaderContent>
        <Typography variant="large">{organizationDetailsQuery.data.name} &gt; Projects</Typography>
      </PageHeaderContent>
      <Outlet />
    </>
  );
}
