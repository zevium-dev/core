import { useOrganization } from "@clerk/tanstack-react-start";
import { convexQuery } from "@convex-dev/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import { FolderPlus, Plus } from "lucide-react";
import { Suspense } from "react";

import { FadeIn } from "#/components/motion/fade-in";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Skeleton } from "#/components/ui/skeleton";
import { api } from "#/lib/convex-api";
import { ensureMirrorOnServer } from "#/lib/ensure-mirror";
import type { RouterContext } from "#/router";

export const Route = createFileRoute("/app/projects/")({
  loader: async ({ context }) => {
    const { queryClient, orgSlug } = context as RouterContext;
    if (!orgSlug) return;

    const queryOpts = convexQuery(api.projects.list, { orgSlug });

    // Client nav: fire-and-forget prefetch; skeletons cover isPending.
    // Mirror is handled by useEnsureMirror in app.tsx — never block client.
    if (typeof window !== "undefined") {
      void queryClient.prefetchQuery(queryOpts);
      return;
    }

    try {
      // Mirror user/org rows before authed list so first SSR doesn't 500
      // on "Organization not found".
      const mirror = await ensureMirrorOnServer();
      if (!mirror.mirrored) return;
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
    <FadeIn className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Publish APIs from OpenAPI specs.
          </p>
        </div>
        {projects.length > 0 ? (
          <Button asChild>
            <Link to="/app/projects/create">
              <Plus data-icon="inline-start" />
              New project
            </Link>
          </Button>
        ) : null}
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
              <Card className="h-full transition-[translate,scale,box-shadow,border-color] duration-[var(--dur-instant)] ease-[var(--ease)] group-hover:-translate-y-0.5 group-hover:shadow-sm group-active:scale-[0.98] motion-reduce:transition-none motion-reduce:group-hover:translate-y-0 motion-reduce:group-active:scale-100">
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
                  {/* VT morph: projects list → project page (project-title/status-{slug}) */}
                  <CardTitle
                    className="min-w-0 text-base [overflow-wrap:anywhere]"
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
                    <CardDescription className="leading-relaxed">
                      {project.description}
                    </CardDescription>
                  ) : null}
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </FadeIn>
  );
}

function EmptyProjects() {
  return (
    <Empty className="min-h-80 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderPlus />
        </EmptyMedia>
        <EmptyTitle>No projects yet</EmptyTitle>
        <EmptyDescription>
          Create a project, paste an OpenAPI spec, set per-call pricing, and
          publish to the catalogue.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild>
          <Link to="/app/projects/create">
            <Plus data-icon="inline-start" />
            New project
          </Link>
        </Button>
      </EmptyContent>
    </Empty>
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
      <Empty className="min-h-80 border">
        <EmptyHeader>
          <EmptyTitle>No active organization</EmptyTitle>
          <EmptyDescription>
            Use the organization switcher in the sidebar to create or select an
            org. Projects are org-scoped.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
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
