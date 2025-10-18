import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { useTRPC } from "~/lib/trpc";

export const Route = createFileRoute("/app/organizations/$organizationSlug")({
  component: RouteComponent,
  loader: async ({ context, params: { organizationSlug } }) => {
    await context.queryClient.ensureQueryData(context.trpc.organization.get.queryOptions({ organizationSlug }));
  },
});

function RouteComponent() {
  const { organizationSlug } = Route.useParams();
  const trpc = useTRPC();
  const orgDeetsQuery = useSuspenseQuery(trpc.organization.get.queryOptions({ organizationSlug }));
  return <div className="break-all">{JSON.stringify(orgDeetsQuery.data, null, 2)}</div>;
}
