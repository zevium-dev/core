import { createFileRoute } from "@tanstack/react-router";

import { Redirect } from "~/components/redirect";

export const Route = createFileRoute("/app/")({
  component: RouteComponent,
});

function RouteComponent() {
  return <Redirect to="/app/dashboard" />;
}
