import { createFileRoute } from "@tanstack/react-router";

import { Redirect } from "~/components/redirect";

export const Route = createFileRoute("/auth/")({
  component: RouteComponent,
});

function RouteComponent() {
  return <Redirect to="/auth/sign-in" />;
}
