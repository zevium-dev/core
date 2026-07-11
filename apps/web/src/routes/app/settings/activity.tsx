import { useOrganization } from "@clerk/tanstack-react-start";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
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
import { Label } from "#/components/ui/label";
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

export const Route = createFileRoute("/app/settings/activity")({
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
      <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
      <p className="text-sm text-muted-foreground">
        Account activity and metered call log.
      </p>
    </div>
  );
}

function ActivityContent({ orgSlug }: { orgSlug: string }) {
  const [timeRange, setTimeRange] = useState<ActivityTimeRange>("7d");
  const [projectId, setProjectId] = useState<string>("all");
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
              <select
                id="activity-project"
                className="flex h-9 min-w-[10rem] rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] duration-[var(--dur-instant)] ease-[var(--ease)] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                disabled={projectsQuery.isPending}
              >
                <option value="all">All projects</option>
                {projects.map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="activity-range" className="text-xs">
                Time range
              </Label>
              <select
                id="activity-range"
                className="flex h-9 min-w-[8rem] rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] duration-[var(--dur-instant)] ease-[var(--ease)] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                value={timeRange}
                onChange={(e) =>
                  setTimeRange(e.target.value as ActivityTimeRange)
                }
              >
                {ACTIVITY_TIME_RANGES.map((range) => (
                  <option key={range} value={range}>
                    {ACTIVITY_TIME_RANGE_LABELS[range]}
                  </option>
                ))}
              </select>
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
                      <th className="px-2 py-2 font-medium">Time</th>
                      <th className="px-2 py-2 font-medium">Project</th>
                      <th className="px-2 py-2 font-medium">Endpoint</th>
                      <th className="px-2 py-2 font-medium">Credits</th>
                      <th className="px-2 py-2 font-medium">Status</th>
                      <th className="px-2 py-2 font-medium text-right">
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
                            {event.method}
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
    <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed px-6 py-12 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Activity className="size-5 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">No activity yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Usage events land after gateway calls. Browse the catalogue, create a
          key, and make a call.
        </p>
      </div>
      <Link
        to="/catalogue"
        className="text-sm font-medium text-primary link-draw"
      >
        Browse catalogue
      </Link>
    </div>
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
