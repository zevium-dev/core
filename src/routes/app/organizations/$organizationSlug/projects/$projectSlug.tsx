import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Code, FileText, Globe, Lock } from "lucide-react";

import { PageHeaderContent } from "~/components/sidebar";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Typography } from "~/components/ui/typography";
import { useTRPC } from "~/lib/trpc";
import { formatDate } from "~/lib/utils";

export const Route = createFileRoute("/app/organizations/$organizationSlug/projects/$projectSlug")({
  component: RouteComponent,
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(
      context.trpc.organization.get.queryOptions({ organizationSlug: params.organizationSlug }),
    );
    await context.queryClient.ensureQueryData(context.trpc.project.get.queryOptions(params));
  },
});

function RouteComponent() {
  const params = Route.useParams();
  const trpc = useTRPC();

  const projectQuery = useSuspenseQuery(trpc.project.get.queryOptions(params));
  const organizationDetailsQuery = useSuspenseQuery(
    trpc.organization.get.queryOptions({ organizationSlug: params.organizationSlug }),
  );
  const project = projectQuery.data;

  const visibilityIcon = project.visibility === "public" ? <Globe className="h-4 w-4" /> : <Lock className="h-4 w-4" />;

  return (
    <div className="space-y-6 p-6">
      <PageHeaderContent>
        <Typography variant="large">
          {organizationDetailsQuery.data.name} &gt; {projectQuery.data.name}
        </Typography>
      </PageHeaderContent>
      {/* Project Header Card */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <CardTitle className="text-2xl">{project.name}</CardTitle>
              <CardDescription className="mt-2 text-base">
                <span className="bg-muted rounded px-2 py-1 font-mono text-xs">{project.slug}</span>
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Badge className="capitalize">{project.status}</Badge>
              <Badge className="flex items-center gap-1" variant="outline">
                {visibilityIcon}
                {project.visibility}
              </Badge>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-6 border-t pt-4">
            <div className="flex gap-2">
              <Typography className="text-muted-foreground font-medium" variant="small">
                Created:
              </Typography>
              <Typography variant="small">{formatDate(project.createdAt)}</Typography>
            </div>
            <div className="flex gap-2">
              <Typography className="text-muted-foreground font-medium" variant="small">
                Project ID:
              </Typography>
              <Typography className="font-mono text-xs" variant="small">
                {project.id}
              </Typography>
            </div>
            <div className="flex gap-2">
              <Typography className="text-muted-foreground font-medium" variant="small">
                Updated:
              </Typography>
              <Typography variant="small">{formatDate(project.updatedAt)}</Typography>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Description Section */}
      {project.description && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Description</CardTitle>
          </CardHeader>
          <CardContent>
            <Typography variant="small">{project.description}</Typography>
          </CardContent>
        </Card>
      )}

      {/* Documentation Section */}
      {project.documentation && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Documentation
            </CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm dark:prose-invert max-w-none">
            <Typography className="text-sm whitespace-pre-wrap" variant="small">
              {project.documentation}
            </Typography>
          </CardContent>
        </Card>
      )}

      {/* Tags Section */}
      {project.project_tags.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Code className="h-5 w-5" />
              Tags ({project.project_tags.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {project.project_tags.map((tag) => (
                <Badge key={tag.id} variant="secondary">
                  {tag.tagName}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Project Metadata */}
      {project.metadata && Object.keys(project.metadata).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Metadata</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted overflow-x-auto rounded p-4 text-xs">
              {JSON.stringify(project.metadata, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
