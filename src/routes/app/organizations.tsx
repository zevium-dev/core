import { createFileRoute, Outlet } from "@tanstack/react-router";

import { PageHeaderContent } from "~/components/sidebar";
import { Typography } from "~/components/ui/typography";

export const Route = createFileRoute("/app/organizations")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <>
      <PageHeaderContent>
        <Typography variant="large">Organizations</Typography>
      </PageHeaderContent>
      <Outlet />
    </>
  );
}
