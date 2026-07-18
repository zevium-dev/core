import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/app/org")({
  component: OrgLayout,
});

function OrgLayout() {
  return <Outlet />;
}
