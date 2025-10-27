import { createFileRoute } from "@tanstack/react-router";

import { Redirect } from "~/components/redirect";

export const Route = createFileRoute("/app/organizations/$organizationSlug/projects/")({
  component: RouteComponent,
});

function RouteComponent() {
  return <Redirect to="/app/organizations/$organizationSlug/projects/~" />;
}
