import { createFileRoute } from "@tanstack/react-router";

import { Redirect } from "~/components/redirect";

export const Route = createFileRoute("/app/organizations/$organizationSlug/projects/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { organizationSlug } = Route.useParams();
  return <Redirect params={{ organizationSlug }} to={`/app/organizations/$organizationSlug/projects/~`} />;
}
