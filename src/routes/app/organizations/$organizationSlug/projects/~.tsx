import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Building2, Globe, Plus, Shield } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { ScreenCenter } from "~/components/ui/screen-center";
import { Typography } from "~/components/ui/typography";
import { useTRPC } from "~/lib/trpc";
import { formatDate } from "~/lib/utils";

export const Route = createFileRoute("/app/organizations/$organizationSlug/projects/~")({
  component: RouteComponent,
});

function RouteComponent() {
  const { organizationSlug } = Route.useParams();
  const trpc = useTRPC();
  const projectsListQuery = useSuspenseQuery(trpc.project.list.queryOptions({ organizationSlug }));

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case "active":
        return "default";
      case "archived":
        return "outline";
      case "beta":
        return "secondary";
      default:
        return "outline";
    }
  };

  const getVisibilityIcon = (visibility: string) => {
    switch (visibility) {
      case "internal":
        return <Building2 className="size-3" />;
      case "private":
        return <Shield className="size-3" />;
      case "public":
        return <Globe className="size-3" />;
      default:
        return <Building2 className="size-3" />;
    }
  };

  return (
    <ScreenCenter>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Projects</CardTitle>
              <CardDescription>All projects in this organization</CardDescription>
            </div>
            <Button asChild size="sm">
              <Link params={{ organizationSlug }} to="/app/organizations/$organizationSlug/projects/create">
                <Plus className="mr-2 size-4" />
                New Project
              </Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {projectsListQuery.data.length === 0 ? (
            <Typography className="py-8 text-center text-muted-foreground" variant="small">
              No projects yet. Create one to get started.
            </Typography>
          ) : (
            <div className="space-y-4">
              {projectsListQuery.data.map((project) => (
                <Link
                  key={project.id}
                  params={{ organizationSlug, projectSlug: project.slug }}
                  to="/app/organizations/$organizationSlug/projects/$projectSlug"
                >
                  <div
                    className={`
                    flex cursor-pointer items-center justify-between rounded-lg
                    border p-4 transition-colors
                    hover:bg-muted/50
                  `}
                  >
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <h4 className="font-medium">{project.name}</h4>
                        {getVisibilityIcon(project.visibility)}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {project.description || "No description available"}
                      </p>
                      <div
                        className={`
                        flex items-center gap-2 text-xs text-muted-foreground
                      `}
                      >
                        <span>Created {formatDate(project.createdAt, { smart: true })}</span>
                        <span>•</span>
                        <span>Updated {formatDate(project.updatedAt, { smart: true })}</span>
                      </div>
                    </div>
                    <div className="ml-4">
                      <Badge variant={getStatusBadgeVariant(project.status)}>
                        {project.status.charAt(0).toUpperCase() + project.status.slice(1)}
                      </Badge>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </ScreenCenter>
  );
}
