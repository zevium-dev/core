import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { useTRPC } from "~/lib/trpc";

export const Route = createFileRoute("/app/organizations/$organizationSlug")({
  component: RouteComponent,
});

function RouteComponent() {
  const { organizationSlug } = Route.useParams();
  const trpc = useTRPC();
  const orgDeetsQuery = useSuspenseQuery(trpc.organization.get.queryOptions({ organizationSlug }));
  return <div>{JSON.stringify(orgDeetsQuery.data, null, 2)}</div>;
}
