import { useOrganization } from "@clerk/tanstack-react-start";
import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
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
import { Activity } from "lucide-react";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { NumberTicker } from "#/components/motion/number-ticker";
import {
  EarningsSkeleton,
  ProjectEarningsPanel,
} from "#/components/project-earnings-panel";
import { ProjectSettingsPanel } from "#/components/project-settings-panel";
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Skeleton } from "#/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { api } from "#/lib/convex-api";
import type { Doc } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";
import type { RouterContext } from "#/router";

type ProjectPanel = "overview" | "analytics" | "earnings" | "settings";
type ProjectSearch = { tab?: Exclude<ProjectPanel, "overview"> };

export const Route = createFileRoute("/app/projects/$projectSlug")({
  validateSearch: (search: Record<string, unknown>): ProjectSearch =>
    search.tab === "analytics" ||
    search.tab === "earnings" ||
    search.tab === "settings"
      ? { tab: search.tab }
      : {},
  loader: async ({ context, params }) => {
    const { queryClient, orgSlug } = context as RouterContext;
    if (!orgSlug) return;

    const queryOpts = convexQuery(api.projects.get, {
      orgSlug,
      projectSlug: params.projectSlug,
    });

    // Client nav: fire-and-forget; component skeletons cover pending.
    if (typeof window !== "undefined") {
      void queryClient.prefetchQuery(queryOpts);
      return;
    }

    try {
      await queryClient.ensureQueryData(queryOpts);
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
  const { tab: searchTab } = Route.useSearch();
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
      <Empty className="min-h-80 flex-none border">
        <EmptyHeader>
          <EmptyTitle>Project not found</EmptyTitle>
          <EmptyDescription>
            No project with slug{" "}
            <span className="font-mono">{projectSlug}</span> in this org.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline">
            <Link to="/app/projects">Back to projects</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  const isSpecRoute = pathname.endsWith("/spec");
  const panel: ProjectPanel = searchTab ?? "overview";
  const tab = isSpecRoute ? "spec" : panel;

  const nextVisibility = project.visibility === "public" ? "private" : "public";
  const requiresRetirement =
    project.status === "published" && project.visibility === "public";

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

        {requiresRetirement ? (
          <Button asChild variant="outline">
            <Link
              to="/app/projects/$projectSlug"
              params={{ projectSlug }}
              search={{ tab: "settings" }}
            >
              Manage retirement
            </Link>
          </Button>
        ) : (
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
        )}
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (value === "spec") {
            void navigate({
              to: "/app/projects/$projectSlug/spec",
              params: { projectSlug: project.slug },
              search: {},
            });
            return;
          }

          if (
            value === "overview" ||
            value === "analytics" ||
            value === "earnings" ||
            value === "settings"
          ) {
            void navigate({
              to: "/app/projects/$projectSlug",
              params: { projectSlug: project.slug },
              search: value === "overview" ? {} : { tab: value },
            });
          }
        }}
      >
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="spec">Spec</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
          <TabsTrigger value="earnings">Earnings</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
      </Tabs>

      {isSpecRoute ? (
        <Outlet />
      ) : panel === "analytics" ? (
        <Suspense fallback={<AnalyticsSkeleton />}>
          <ProjectAnalyticsPanel orgSlug={orgSlug} projectSlug={project.slug} />
        </Suspense>
      ) : panel === "earnings" ? (
        <Suspense fallback={<EarningsSkeleton />}>
          <ProjectEarningsPanel orgSlug={orgSlug} projectSlug={project.slug} />
        </Suspense>
      ) : panel === "settings" ? (
        <ProjectSettingsPanel project={project} orgSlug={orgSlug} />
      ) : (
        <ProjectOverview
          project={project}
          onEdit={() =>
            void navigate({
              to: "/app/projects/$projectSlug",
              params: { projectSlug: project.slug },
              search: { tab: "settings" },
            })
          }
        />
      )}
    </div>
  );
}

function ProjectOverview({
  project,
  onEdit,
}: {
  project: Doc<"projects">;
  onEdit: () => void;
}) {
  const isLive =
    project.status === "published" && project.visibility === "public";

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Overview</CardTitle>
            <CardDescription>
              Project status and catalogue readiness.
            </CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            Edit
          </Button>
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
          {project.description ? (
            <div className="space-y-1 border-t pt-3">
              <span className="text-muted-foreground">Description</span>
              <p className="text-sm">{project.description}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{isLive ? "Live in catalogue" : "Next steps"}</CardTitle>
          <CardDescription>
            {isLive
              ? "Consumers can discover and call this published version."
              : "Get this API live in the catalogue."}
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
            {isLive ? (
              "Edit your draft when you are ready to publish a new immutable version."
            ) : (
              <>
                Add <code className="font-mono text-xs">x-zevium-cost</code> per
                operation, save draft, publish a version, then make project
                public.
              </>
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(rate === 0 || rate === 1 ? 0 : 1)}%`;
}

function ProjectAnalyticsPanel({
  orgSlug,
  projectSlug,
}: {
  orgSlug: string;
  projectSlug: string;
}) {
  const { data: analytics } = useSuspenseQuery(
    convexQuery(api.analytics.projectAnalytics, {
      orgSlug,
      projectSlug,
      rangeDays: 7,
    }),
  );

  if (analytics === null) {
    return (
      <Card>
        <CardContent>
          <Empty className="py-8">
            <EmptyHeader>
              <EmptyTitle>Project not found</EmptyTitle>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  const maxDay = Math.max(1, ...analytics.callsByDay);
  const hasTraffic = analytics.calls > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>
              Calls · last {analytics.rangeDays} days
            </CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              <NumberTicker value={analytics.calls} />
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Net credits earned</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              <NumberTicker value={analytics.netCredits} />
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Success rate</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {hasTraffic ? formatPct(analytics.successRate) : "—"}
            </CardTitle>
          </CardHeader>
          {hasTraffic ? (
            <CardContent className="text-xs text-muted-foreground">
              {analytics.errors4xx} 4xx · {analytics.errors5xx} 5xx
            </CardContent>
          ) : null}
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Latency p95</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {formatMs(analytics.p95)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            p50 {formatMs(analytics.p50)} · p99 {formatMs(analytics.p99)}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Calls over time</CardTitle>
          <CardDescription>
            Daily metered calls over last {analytics.rangeDays} UTC days
          </CardDescription>
        </CardHeader>
        <CardContent>
          {analytics.calls === 0 ? (
            <Empty className="border py-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Activity />
                </EmptyMedia>
                <EmptyTitle>No traffic yet</EmptyTitle>
                <EmptyDescription>
                  Calls appear here as soon as consumers use this API.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex h-24 items-end gap-1">
              {analytics.callsByDay.map((count, i) => {
                const heightPct = Math.max(4, (count / maxDay) * 100);
                return (
                  <div
                    key={i}
                    className="flex flex-1 flex-col items-center gap-1"
                    title={`${count} calls`}
                  >
                    <div
                      className="w-full rounded-sm bg-primary/80 transition-[height] duration-[var(--dur-fast)] ease-[var(--ease)]"
                      style={{ height: `${heightPct}%` }}
                    />
                  </div>
                );
              })}
            </div>
          )}
          {analytics.truncated ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Scan capped at {analytics.scanCap.toLocaleString()} events — stats
              may undercount.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {analytics.endpoints.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Per-endpoint</CardTitle>
            <CardDescription>
              Method, path, volume, errors, and tail latency
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="px-2 py-2 font-medium">
                      Method
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      Path
                    </th>
                    <th
                      scope="col"
                      className="px-2 py-2 font-medium text-right"
                    >
                      Calls
                    </th>
                    <th
                      scope="col"
                      className="px-2 py-2 font-medium text-right"
                    >
                      Credits
                    </th>
                    <th
                      scope="col"
                      className="px-2 py-2 font-medium text-right"
                    >
                      4xx
                    </th>
                    <th
                      scope="col"
                      className="px-2 py-2 font-medium text-right"
                    >
                      5xx
                    </th>
                    <th
                      scope="col"
                      className="px-2 py-2 font-medium text-right"
                    >
                      p95
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.endpoints.map((row) => (
                    <tr
                      key={`${row.method} ${row.endpoint}`}
                      className="border-b last:border-0"
                    >
                      <td className="px-2 py-2.5">
                        <Badge variant="outline" className="font-mono">
                          {row.method}
                        </Badge>
                      </td>
                      <td className="px-2 py-2.5 font-mono text-xs">
                        {row.endpoint}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums">
                        {row.calls.toLocaleString()}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums">
                        {row.credits.toLocaleString()}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                        {row.errors4xx}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                        {row.errors5xx}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums">
                        {formatMs(row.p95)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-56 rounded-xl" />
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
