import { useOrganization } from "@clerk/tanstack-react-start";
import {
  convexQuery,
  useConvexMutation,
} from "@convex-dev/react-query";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  Link,
  Outlet,
  createFileRoute,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#/components/ui/dialog";
import { Skeleton } from "#/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { getAuthOrg } from "#/lib/auth-session";
import { api } from "#/lib/convex-api";
import type { Doc } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";
import type { RouterContext } from "#/router";

export const Route = createFileRoute("/app/projects/$projectSlug")({
  loader: async ({ context, params }) => {
    const { queryClient } = context as RouterContext;
    try {
      const session = await getAuthOrg();
      if (session.orgSlug) {
        await queryClient.ensureQueryData(
          convexQuery(api.projects.get, {
            orgSlug: session.orgSlug,
            projectSlug: params.projectSlug,
          }),
        );
      }
    } catch {
      // component handles missing org / not found
    }
  },
  component: ProjectLayoutPage,
  head: ({ params }) => ({
    meta: [{ title: `${params.projectSlug} · Projects · Zevium` }],
  }),
  pendingComponent: ProjectPageSkeleton,
});

function ProjectLayoutPage() {
  const { projectSlug } = Route.useParams();
  const { organization, isLoaded } = useOrganization();
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
  const orgSlug =
    organization && typeof organization.slug === "string"
      ? organization.slug
      : null;

  if (!isLoaded || convexAuthLoading) {
    return <ProjectPageSkeleton />;
  }

  if (!orgSlug) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Select an organization to view this project.
        </p>
        <Button asChild variant="outline">
          <Link to="/app/projects">Back to projects</Link>
        </Button>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <ProjectPageSkeleton />;
  }

  return (
    <Suspense fallback={<ProjectPageSkeleton />}>
      <ProjectShell orgSlug={orgSlug} projectSlug={projectSlug} />
    </Suspense>
  );
}

function ProjectShell({
  orgSlug,
  projectSlug,
}: {
  orgSlug: string;
  projectSlug: string;
}) {
  const { data: project } = useSuspenseQuery(
    convexQuery(api.projects.get, { orgSlug, projectSlug }),
  );
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const updateProject = useConvexMutation(api.projects.update);
  const [visibilityOpen, setVisibilityOpen] = useState(false);

  const { mutate: setVisibility, isPending: visibilityPending } = useMutation({
    mutationFn: (visibility: "public" | "private") => {
      if (!project) throw new Error("Project not found");
      return updateProject({
        projectId: project._id,
        patch: { visibility },
      });
    },
    onSuccess: async (updated) => {
      toast.success(
        updated.visibility === "public"
          ? "Project is now public"
          : "Project is now private",
      );
      setVisibilityOpen(false);
      await queryClient.invalidateQueries({
        queryKey: convexQuery(api.projects.get, { orgSlug, projectSlug })
          .queryKey,
      });
      await queryClient.invalidateQueries({
        queryKey: convexQuery(api.projects.list, { orgSlug }).queryKey,
      });
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not update visibility"));
    },
  });

  if (project === null) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          Project not found
        </h1>
        <p className="text-sm text-muted-foreground">
          No project with slug{" "}
          <span className="font-mono">{projectSlug}</span> in this org.
        </p>
        <Button asChild variant="outline">
          <Link to="/app/projects">Back to projects</Link>
        </Button>
      </div>
    );
  }

  const isSpecRoute = pathname.endsWith("/spec");
  const tab = isSpecRoute ? "spec" : "overview";

  const nextVisibility =
    project.visibility === "public" ? "private" : "public";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={project.status === "published" ? "default" : "secondary"}
              style={{
                viewTransitionName: `project-status-${project.slug}`,
              }}
            >
              {project.status}
            </Badge>
            <Badge variant="outline">{project.visibility}</Badge>
          </div>
          <h1
            className="text-2xl font-semibold tracking-tight"
            style={{
              viewTransitionName: `project-title-${project.slug}`,
            }}
          >
            {project.name}
          </h1>
          <p className="font-mono text-sm text-muted-foreground">
            {project.slug}
          </p>
          {project.description ? (
            <p className="max-w-2xl text-sm text-muted-foreground">
              {project.description}
            </p>
          ) : null}
        </div>

        <Dialog open={visibilityOpen} onOpenChange={setVisibilityOpen}>
          <DialogTrigger asChild>
            <Button variant="outline">
              Make {nextVisibility === "public" ? "Public" : "Private"}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Make project {nextVisibility}?</DialogTitle>
              <DialogDescription>
                {nextVisibility === "public"
                  ? "Public projects appear in the catalogue when published. Only published specs are listed."
                  : "Private projects stay hidden from the public catalogue."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => setVisibilityOpen(false)}
                disabled={visibilityPending}
              >
                Cancel
              </Button>
              <Button
                onClick={() => setVisibility(nextVisibility)}
                disabled={visibilityPending}
              >
                {visibilityPending ? "Updating…" : `Make ${nextVisibility}`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (value === "overview") {
            void navigate({
              to: "/app/projects/$projectSlug",
              params: { projectSlug: project.slug },
            });
          } else if (value === "spec") {
            void navigate({
              to: "/app/projects/$projectSlug/spec",
              params: { projectSlug: project.slug },
            });
          } else if (value === "settings") {
            toast.message("Settings coming soon");
          }
        }}
      >
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="spec">Spec</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
      </Tabs>

      {isSpecRoute ? <Outlet /> : <ProjectOverview project={project} />}
    </div>
  );
}

function ProjectOverview({ project }: { project: Doc<"projects"> }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Overview</CardTitle>
          <CardDescription>
            Project status and catalogue readiness.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Status</span>
            <span className="font-medium capitalize">{project.status}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Visibility</span>
            <span className="font-medium capitalize">{project.visibility}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Tags</span>
            <span className="text-right">
              {project.tags.length === 0 ? "None" : project.tags.join(", ")}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Next steps</CardTitle>
          <CardDescription>
            Get this API live on the marketplace.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button asChild className="w-full sm:w-auto">
            <Link
              to="/app/projects/$projectSlug/spec"
              params={{ projectSlug: project.slug }}
            >
              Edit OpenAPI spec
            </Link>
          </Button>
          <p className="text-sm text-muted-foreground">
            Add <code className="font-mono text-xs">x-zevium-cost</code> per
            operation, save draft, publish a semver, then make the project
            public.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function ProjectPageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-3">
        <div className="flex gap-2">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-9 w-64" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-40" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-4 w-48" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-9 w-40" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
