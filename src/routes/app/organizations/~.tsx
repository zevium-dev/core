import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { PageHeaderContent } from "~/components/sidebar";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { ScreenCenter } from "~/components/ui/screen-center";
import { Typography } from "~/components/ui/typography";
import { useTRPC } from "~/lib/trpc";

export const Route = createFileRoute("/app/organizations/~")({
  component: RouteComponent,
});

function RouteComponent() {
  const trpc = useTRPC();
  const orgListQuery = useSuspenseQuery(trpc.organization.list.queryOptions());

  return (
    <ScreenCenter>
      <PageHeaderContent>
        <Typography variant="large">Organizations</Typography>
      </PageHeaderContent>

      <div className="flex flex-col gap-2">
        {orgListQuery.data.map((org) => {
          return (
            <Button asChild key={org.id}>
              <Link params={{ organizationSlug: org.slug }} to="/app/organizations/$organizationSlug">
                <Avatar>
                  <AvatarImage src={org.logo ?? undefined} />
                  <AvatarFallback>{org.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                {org.name}
              </Link>
            </Button>
          );
        })}

        <Button asChild className="w-full" variant="outline">
          <Link to="/app/organizations/create">+ Create</Link>
        </Button>
      </div>
    </ScreenCenter>
  );
}
