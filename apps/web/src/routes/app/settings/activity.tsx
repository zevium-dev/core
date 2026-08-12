import { useOrganization } from "@clerk/tanstack-react-start";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import { Activity } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Label } from "#/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Skeleton } from "#/components/ui/skeleton";
import {
  ACTIVITY_PAGE_SIZE,
  ACTIVITY_TIME_RANGE_LABELS,
  ACTIVITY_TIME_RANGES,
  activitySinceMs,
  mergeUsagePages,
  type ActivityTimeRange,
} from "#/lib/activity-filters";
import { api } from "#/lib/convex-api";
import type { Id } from "#/lib/convex-data-model";

type ActivitySearch = {
  range?: ActivityTimeRange;
  project?: string;
};

export const Route = createFileRoute("/app/settings/activity")({
  validateSearch: (search: Record<string, unknown>): ActivitySearch => {
    const range = ACTIVITY_TIME_RANGES.includes(
      search.range as ActivityTimeRange,
    )
      ? (search.range as ActivityTimeRange)
      : undefined;
    const project =
      typeof search.project === "string" && search.project.length > 0
        ? search.project
        : undefined;
    return {
      ...(range && range !== "7d" ? { range } : {}),
      ...(project ? { project } : {}),
    };
  },
  component: ActivityPage,
  head: () => ({
    meta: [{ title: "Activity · Zevium" }],
  }),
});

type UsageListItem = {
  _id: string;
  projectId: string;
  projectName: string | null;
  projectSlug: string | null;
  endpoint: string;
  method: string;
  credits: number;
  status: number;
  latencyMs: number;
  keyId: string;
  at: number;
};

function ActivityPage() {
  const { organization, isLoaded } = useOrganization();
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
  const orgSlug =
    organization && typeof organization.slug === "string"
      ? organization.slug
      : null;

  if (!isLoaded || convexAuthLoading) {
    return <ActivitySkeleton />;
  }

  if (!orgSlug) {
    return (
      <div className="flex flex-col gap-6">
        <ActivityHeader />
        <p className="text-sm text-muted-foreground">
          Select an organization to view the call log.
        </p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <ActivitySkeleton />;
  }

  return <ActivityContent orgSlug={orgSlug} />;
}

function ActivityHeader() {
  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">Activity</h2>
      <p className="text-sm text-muted-foreground">
        Organization activity and metered call log.
      </p>
    </div>
  );
}

function ActivityContent({ orgSlug }: { orgSlug: string }) {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const timeRange = search.range ?? "7d";
  const projectId = search.project ?? "all";
  const [cursor, setCursor] = useState<string | null>(null);
  const [rows, setRows] = useState<UsageListItem[]>([]);
  const [isDone, setIsDone] = useState(false);
  const [continueCursor, setContinueCursor] = useState<string | null>(null);

  // Freeze "now" per filter change so page fetches share the same window.
  const [windowNow, setWindowNow] = useState(() => Date.now());

  const projectsQuery = useQuery(convexQuery(api.projects.list, { orgSlug }));

  const since = useMemo(
    () => activitySinceMs(timeRange, windowNow),
    [timeRange, windowNow],
  );

  const listArgs = useMemo(() => {
    const args: {
      orgSlug: string;
      paginationOpts: { numItems: number; cursor: string | null };
      projectId?: Id<"projects">;
      since?: number;
    } = {
      orgSlug,
      paginationOpts: {
        numItems: ACTIVITY_PAGE_SIZE,
        cursor,
      },
    };
    if (projectId !== "all") {
      args.projectId = projectId as Id<"projects">;
    }
    if (since !== undefined) {
      args.since = since;
    }
    return args;
  }, [orgSlug, cursor, projectId, since]);

  const usageQuery = useQuery({
    ...convexQuery(api.usage.listForOrg, listArgs),
  });

  // Reset accumulated pages when filters change.
  useEffect(() => {
    setCursor(null);
    setRows([]);
    setIsDone(false);
    setContinueCursor(null);
    setWindowNow(Date.now());
  }, [timeRange, projectId, orgSlug]);

  // Merge each successful page into the running list.
  useEffect(() => {
    if (!usageQuery.data || usageQuery.isPending) {
      return;
    }
    const page = usageQuery.data.page as UsageListItem[];
    const replace = cursor === null;
    setRows((prev) => mergeUsagePages(prev, page, replace));
    setIsDone(usageQuery.data.isDone);
    setContinueCursor(usageQuery.data.continueCursor);
  }, [usageQuery.data, usageQuery.isPending, cursor]);

  const projects = projectsQuery.data ?? [];
  const firstPagePending = usageQuery.isPending && cursor === null;
  const loadMorePending = usageQuery.isPending && cursor !== null;
  const canLoadMore =
    !isDone && continueCursor !== null && !usageQuery.isPending;

  return (
    <div className="flex flex-col gap-6">
      <ActivityHeader />

      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle>Recent calls</CardTitle>
            <CardDescription>
              Timestamp, project, endpoint, status, credits, latency.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="activity-project" className="text-xs">
                Project
              </Label>
              <Select
                value={projectId}
                onValueChange={(value) =>
                  void navigate({
                    to: "/app/settings/activity",
                    search: {
                      ...(timeRange === "7d" ? {} : { range: timeRange }),
                      ...(value === "all" ? {} : { project: value }),
                    },
                  })
                }
                disabled={projectsQuery.isPending}
              >
                <SelectTrigger id="activity-project" className="min-w-[10rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All projects</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project._id} value={project._id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="activity-range" className="text-xs">
                Time range
              </Label>
              <Select
                value={timeRange}
                onValueChange={(value) =>
                  void navigate({
                    to: "/app/settings/activity",
                    search: {
                      ...(value === "7d"
                        ? {}
                        : { range: value as ActivityTimeRange }),
                      ...(projectId === "all" ? {} : { project: projectId }),
                    },
                  })
                }
              >
                <SelectTrigger id="activity-range" className="min-w-[8rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACTIVITY_TIME_RANGES.map((range) => (
                    <SelectItem key={range} value={range}>
                      {ACTIVITY_TIME_RANGE_LABELS[range]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {firstPagePending ? (
            <ActivityTableSkeleton />
          ) : rows.length === 0 ? (
            <EmptyActivity />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th scope="col" className="px-2 py-2 font-medium">
                        Time
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        Project
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        Endpoint
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        Credits
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        Status
                      </th>
                      <th
                        scope="col"
                        className="px-2 py-2 font-medium text-right"
                      >
                        Latency
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((event) => (
                      <tr key={event._id} className="border-b last:border-0">
                        <td className="whitespace-nowrap px-2 py-2.5 text-muted-foreground">
                          {new Date(event.at).toLocaleString()}
                        </td>
                        <td className="px-2 py-2.5">
                          {event.projectName ?? event.projectSlug ?? "—"}
                        </td>
                        <td className="px-2 py-2.5 font-mono text-xs">
                          <span className="text-muted-foreground">
                            {event.method.toUpperCase()}
                          </span>{" "}
                          {event.endpoint}
                        </td>
                        <td className="px-2 py-2.5 tabular-nums">
                          {event.credits.toLocaleString()}
                        </td>
                        <td className="px-2 py-2.5">
                          <StatusBadge status={event.status} />
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                          {event.latencyMs}ms
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {canLoadMore || loadMorePending ? (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadMorePending || !canLoadMore}
                    onClick={() => {
                      if (continueCursor !== null) {
                        setCursor(continueCursor);
                      }
                    }}
                  >
                    {loadMorePending ? "Loading…" : "Load more"}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EmptyActivity() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Activity />
        </EmptyMedia>
        <EmptyTitle>No activity yet</EmptyTitle>
        <EmptyDescription>
          Usage events land after gateway calls. Browse the catalogue, create a
          key, and make a call.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link to="/catalogue">Browse catalogue</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function StatusBadge({ status }: { status: number }) {
  if (status >= 200 && status < 400) {
    return <Badge variant="secondary">{status}</Badge>;
  }
  if (status >= 400 && status < 500) {
    return <Badge variant="outline">{status}</Badge>;
  }
  return <Badge variant="destructive">{status}</Badge>;
}

function ActivityTableSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-5 w-12 rounded-full" />
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
    </div>
  );
}

function ActivitySkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-4 w-64" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-56" />
        </CardHeader>
        <CardContent>
          <ActivityTableSkeleton />
        </CardContent>
      </Card>
    </div>
  );
}
