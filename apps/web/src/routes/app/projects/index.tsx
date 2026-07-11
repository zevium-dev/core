import { useOrganization } from "@clerk/tanstack-react-start";
import { convexQuery } from "@convex-dev/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import { FolderPlus, Plus } from "lucide-react";
import { Suspense } from "react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Skeleton } from "#/components/ui/skeleton";
import { getAuthOrg } from "#/lib/auth-session";
import { api } from "#/lib/convex-api";
import { ensureMirrorOnServer } from "#/lib/ensure-mirror";
import type { RouterContext } from "#/router";

export const Route = createFileRoute("/app/projects/")({
  loader: async ({ context }) => {
    const { queryClient } = context as RouterContext;
    try {
      // Mirror user/org rows before authed list so first SSR doesn't 500
      // on "Organization not found".
      const mirror = await ensureMirrorOnServer();
      const session = await getAuthOrg();
      if (!session.orgSlug || !mirror.mirrored) return;
      const queryOpts = convexQuery(api.projects.list, {
        orgSlug: session.orgSlug,
      });
      try {
        await queryClient.ensureQueryData(queryOpts);
      } catch {
        // Drop failed cache entry so dehydrate doesn't ship InternalServerError
        // and client can retry once mirror/auth settles.
        queryClient.removeQueries({ queryKey: queryOpts.queryKey });
      }
    } catch {
      // Auth redirect or missing org — component handles empty/loading UI.
    }
  },
  component: ProjectsIndexPage,
  head: () => ({
    meta: [{ title: "Projects · Zevium" }],
  }),
  pendingComponent: ProjectsListSkeleton,
});

function ProjectsIndexPage() {
  const { organization, isLoaded } = useOrganization();
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
  const orgSlug =
    organization && typeof organization.slug === "string"
      ? organization.slug
      : null;

  if (!isLoaded || convexAuthLoading) {
    return <ProjectsListSkeleton />;
  }

  if (!orgSlug) {
    return <NoOrgState />;
  }

  // Wait for Convex JWT before authed query — unauthenticated ensureQueryData
  // / WebSocket race throws "Not authenticated" → InternalServerError UI.
  if (!isAuthenticated) {
    return <ProjectsListSkeleton />;
  }

  return (
    <Suspense fallback={<ProjectsListSkeleton />}>
      <ProjectsList orgSlug={orgSlug} />
    </Suspense>
  );
}

function ProjectsList({ orgSlug }: { orgSlug: string }) {
  const { data: projects } = useSuspenseQuery(
    convexQuery(api.projects.list, { orgSlug }),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Publish APIs from OpenAPI specs.
          </p>
        </div>
        <Button asChild>
          <Link to="/app/projects/create">
            <Plus className="size-4" />
            New project
          </Link>
        </Button>
      </div>

      {projects.length === 0 ? (
        <EmptyProjects />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Link
              key={project._id}
              to="/app/projects/$projectSlug"
              params={{ projectSlug: project.slug }}
              className="group block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Card className="h-full transition-[transform,box-shadow,border-color] duration-[var(--dur-instant)] ease-[var(--ease)] group-hover:-translate-y-0.5 group-hover:shadow-sm group-active:scale-[0.98]">
                <CardHeader>
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        project.status === "published" ? "default" : "secondary"
                      }
                      style={{
                        viewTransitionName: `project-status-${project.slug}`,
                      }}
                    >
                      {project.status}
                    </Badge>
                    <Badge variant="outline">{project.visibility}</Badge>
                  </div>
                  <CardTitle
                    className="text-base"
                    style={{
                      viewTransitionName: `project-title-${project.slug}`,
                    }}
                  >
                    {project.name}
                  </CardTitle>
                  <CardDescription className="font-mono text-xs">
                    {project.slug}
                  </CardDescription>
                  {project.description ? (
                    <CardDescription className="line-clamp-2">
                      {project.description}
                    </CardDescription>
                  ) : null}
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyProjects() {
  return (
    <Card className="border-dashed">
      <CardHeader className="items-center py-12 text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
          <FolderPlus className="size-6 text-muted-foreground" />
        </div>
        <CardTitle>No projects yet</CardTitle>
        <CardDescription className="max-w-sm">
          Create a project, paste an OpenAPI spec, set per-call pricing, and
          publish to the catalogue.
        </CardDescription>
        <div className="pt-4">
          <Button asChild>
            <Link to="/app/projects/create">
              <Plus className="size-4" />
              New project
            </Link>
          </Button>
        </div>
      </CardHeader>
    </Card>
  );
}

function NoOrgState() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="text-sm text-muted-foreground">
          Select an organization to manage projects.
        </p>
      </div>
      <Card className="border-dashed">
        <CardHeader className="items-center py-12 text-center">
          <CardTitle>No active organization</CardTitle>
          <CardDescription className="max-w-sm">
            Use the organization switcher in the sidebar to create or select an
            org. Projects are org-scoped.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

function ProjectsListSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <div className="mb-2 flex gap-2">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-5 w-14 rounded-full" />
              </div>
              <Skeleton className="mb-2 h-5 w-1/2" />
              <Skeleton className="h-4 w-1/3" />
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}
