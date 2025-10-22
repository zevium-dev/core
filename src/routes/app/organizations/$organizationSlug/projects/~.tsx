import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/app/organizations/$organizationSlug/projects/~")({
  component: RouteComponent,
});

function RouteComponent() {
  return <div>Hello "/app/organizations/projects/~"!</div>;
}
