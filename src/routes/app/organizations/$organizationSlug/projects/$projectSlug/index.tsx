import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Code, FileText, Globe, Lock, Settings } from "lucide-react";

import { PageHeaderContent } from "~/components/sidebar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Typography } from "~/components/ui/typography";
import { useTRPC } from "~/lib/trpc";
import { formatDate } from "~/lib/utils";

const useProjectVisibilityMutation = (organizationSlug: string, projectSlug: string) => {
  const trpc = useTRPC();
  const qc = useQueryClient();

  return useMutation(
    trpc.project.update.mutationOptions({
      onMutate(variables) {
        qc.setQueryData(trpc.project.get.queryKey({ organizationSlug, projectSlug }), (old) =>
          old ? { ...old, ...variables } : old,
        );
      },
      async onSettled() {
        await qc.invalidateQueries(trpc.project.get.queryOptions({ organizationSlug, projectSlug }));
      },
    }),
  );
};

export const Route = createFileRoute("/app/organizations/$organizationSlug/projects/$projectSlug/")({
  component: RouteComponent,
  loader: ({ context, params }) => {
    void context.queryClient.ensureQueryData(
      context.trpc.organization.get.queryOptions({ organizationSlug: params.organizationSlug }),
    );
    void context.queryClient.ensureQueryData(
      context.trpc.project.get.queryOptions({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      }),
    );
  },
});

function RouteComponent() {
  const { organizationSlug, projectSlug } = Route.useParams();
  const trpc = useTRPC();

  const projectQuery = useSuspenseQuery(trpc.project.get.queryOptions({ organizationSlug, projectSlug }));
  const organizationDetailsQuery = useSuspenseQuery(trpc.organization.get.queryOptions({ organizationSlug }));
  const project = projectQuery.data;

  const visibilityMutation = useProjectVisibilityMutation(organizationSlug, projectSlug);

  const visibilityIcon =
    project.visibility === "public" ? (
      <Globe
        className={`
    h-4 w-4
  `}
      />
    ) : (
      <Lock className={`h-4 w-4`} />
    );

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
                <span className="rounded bg-muted px-2 py-1 font-mono text-xs">{project.slug}</span>
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Badge className="capitalize">{project.status}</Badge>
              <Badge className="flex items-center gap-1" variant="outline">
                {visibilityIcon}
                {project.visibility}
              </Badge>
              <Button
                disabled={visibilityMutation.isPending}
                onClick={() => {
                  visibilityMutation.mutate({
                    description: project.description,
                    documentation: project.documentation,
                    id: project.id,
                    name: project.name,
                    organizationSlug,
                    status: project.status,
                    tagNames: project.project_tags.map((tag) => tag.tagName),
                    variables: project.variables ?? undefined,
                    visibility: project.visibility === "public" ? "private" : "public",
                  });
                }}
                size="sm"
                variant="outline"
              >
                {visibilityMutation.isPending ? (
                  "Updating..."
                ) : (
                  <>
                    {project.visibility === "public" ? (
                      <>
                        <Lock className="mr-2 h-4 w-4" />
                        Make Private
                      </>
                    ) : (
                      <>
                        <Globe className="mr-2 h-4 w-4" />
                        Make Public
                      </>
                    )}
                  </>
                )}
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link
                  params={{
                    organizationSlug,
                    projectSlug,
                  }}
                  to="/app/organizations/$organizationSlug/projects/$projectSlug/spec"
                >
                  <Settings className="mr-2 h-4 w-4" />
                  Manage Spec
                </Link>
              </Button>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-6 border-t pt-4">
            <div className="flex gap-2">
              <Typography className="font-medium text-muted-foreground" variant="small">
                Created:
              </Typography>
              <Typography variant="small">{formatDate(project.createdAt)}</Typography>
            </div>
            <div className="flex gap-2">
              <Typography className="font-medium text-muted-foreground" variant="small">
                Project ID:
              </Typography>
              <Typography className="font-mono text-xs" variant="small">
                {project.id}
              </Typography>
            </div>
            <div className="flex gap-2">
              <Typography className="font-medium text-muted-foreground" variant="small">
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
          <CardContent
            className={`
            prose prose-sm max-w-none
            dark:prose-invert
          `}
          >
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
            <pre className="overflow-x-auto rounded bg-muted p-4 text-xs">
              {JSON.stringify(project.metadata, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
