import { useOrganization } from "@clerk/tanstack-react-start";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import { Activity, Search } from "lucide-react";
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
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Skeleton } from "#/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
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
import { humanError } from "#/lib/human-error";

type ActivitySearch = {
  range?: ActivityTimeRange;
  project?: string;
  key?: string;
  member?: string;
  endpoint?: string;
  method?: string;
  event?: string;
};

export const Route = createFileRoute("/app/settings/activity")({
  validateSearch: (search: Record<string, unknown>): ActivitySearch => {
    const range = ACTIVITY_TIME_RANGES.find(
      (candidate) => candidate === search.range,
    );
    const project =
      typeof search.project === "string" &&
      search.project.length > 0 &&
      search.project.length <= 128
        ? search.project
        : undefined;
    const event =
      typeof search.event === "string" &&
      search.event.length > 0 &&
      search.event.length <= 128
        ? search.event
        : undefined;
    const bounded = (value: unknown, max: number) =>
      typeof value === "string" && value.length > 0 && value.length <= max
        ? value
        : undefined;
    const key = bounded(search.key, 128);
    const member = bounded(search.member, 128);
    const endpoint = bounded(search.endpoint, 512);
    const method = bounded(search.method, 16)?.toUpperCase();
    return {
      ...(range && range !== "7d" ? { range } : {}),
      ...(project ? { project } : {}),
      ...(key ? { key } : {}),
      ...(member ? { member } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(method ? { method } : {}),
      ...(event ? { event } : {}),
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

const ACTIVITY_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

function formatActivityDate(timestamp: number): string {
  return ACTIVITY_DATE_FORMATTER.format(timestamp);
}

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
  const navigate = useNavigate({ from: Route.fullPath });
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
      keyId?: string;
      memberId?: string;
      endpoint?: string;
      method?: string;
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
    if (search.key) args.keyId = search.key;
    if (search.member) args.memberId = search.member;
    if (search.endpoint) args.endpoint = search.endpoint;
    if (search.method) args.method = search.method;
    if (since !== undefined) {
      args.since = since;
    }
    return args;
  }, [orgSlug, cursor, projectId, search, since]);

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
  }, [
    timeRange,
    projectId,
    orgSlug,
    search.key,
    search.member,
    search.endpoint,
    search.method,
  ]);

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
    !isDone &&
    continueCursor !== null &&
    !usageQuery.isPending &&
    !usageQuery.isError;
  const selectedFromRows = search.event
    ? (rows.find((event) => event._id === search.event) ?? null)
    : null;
  const eventQuery = useQuery({
    ...convexQuery(api.usage.getForOrgById, {
      orgSlug,
      eventId: search.event ?? "invalid",
    }),
    enabled: search.event !== undefined && selectedFromRows === null,
  });
  const selectedEvent = selectedFromRows ?? eventQuery.data ?? null;
  const hasAttributionFilter = Boolean(
    search.key || search.member || search.endpoint || search.method,
  );
  const attributionSearch = {
    ...(search.key ? { key: search.key } : {}),
    ...(search.member ? { member: search.member } : {}),
    ...(search.endpoint ? { endpoint: search.endpoint } : {}),
    ...(search.method ? { method: search.method } : {}),
  };

  const inspectEvent = (eventId: string) => {
    void navigate({ search: { ...search, event: eventId } });
  };

  const closeInspector = () => {
    void navigate({
      search: {
        ...(search.range ? { range: search.range } : {}),
        ...(search.project ? { project: search.project } : {}),
        ...(search.key ? { key: search.key } : {}),
        ...(search.member ? { member: search.member } : {}),
        ...(search.endpoint ? { endpoint: search.endpoint } : {}),
        ...(search.method ? { method: search.method } : {}),
      },
      replace: true,
    });
  };

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
                      ...attributionSearch,
                    },
                  })
                }
                disabled={projectsQuery.isPending}
              >
                <SelectTrigger id="activity-project" className="min-w-[10rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All projects</SelectItem>
                    {projects.map((project) => (
                      <SelectItem key={project._id} value={project._id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="activity-range" className="text-xs">
                Time range
              </Label>
              <Select
                value={timeRange}
                onValueChange={(value) => {
                  const range = ACTIVITY_TIME_RANGES.find(
                    (candidate) => candidate === value,
                  );
                  if (!range) return;
                  void navigate({
                    search: {
                      ...(range === "7d" ? {} : { range }),
                      ...(projectId === "all" ? {} : { project: projectId }),
                      ...attributionSearch,
                    },
                  });
                }}
              >
                <SelectTrigger id="activity-range" className="min-w-[8rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {ACTIVITY_TIME_RANGES.map((range) => (
                      <SelectItem key={range} value={range}>
                        {ACTIVITY_TIME_RANGE_LABELS[range]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {hasAttributionFilter ? (
            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3">
              <span className="text-xs font-medium text-muted-foreground">
                Billing drill-down
              </span>
              {search.member ? (
                <Badge variant="secondary" className="max-w-full break-all">
                  Member · {search.member}
                </Badge>
              ) : null}
              {search.key ? (
                <Badge variant="secondary" className="max-w-full break-all">
                  Key · {search.key}
                </Badge>
              ) : null}
              {search.endpoint ? (
                <Badge variant="secondary" className="max-w-full break-all">
                  Endpoint · {search.method ? `${search.method} ` : ""}
                  {search.endpoint}
                </Badge>
              ) : search.method ? (
                <Badge variant="secondary">Method · {search.method}</Badge>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="ml-auto"
                onClick={() =>
                  void navigate({
                    search: {
                      ...(timeRange === "7d" ? {} : { range: timeRange }),
                      ...(projectId === "all" ? {} : { project: projectId }),
                    },
                  })
                }
              >
                Clear drill-down
              </Button>
            </div>
          ) : null}
          {firstPagePending ? (
            <ActivityTableSkeleton />
          ) : usageQuery.isError && rows.length === 0 ? (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyTitle>Could not load activity</EmptyTitle>
                <EmptyDescription>
                  {humanError(
                    usageQuery.error,
                    "Activity is temporarily unavailable.",
                  )}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void usageQuery.refetch()}
                >
                  Retry
                </Button>
              </EmptyContent>
            </Empty>
          ) : rows.length === 0 ? (
            <div className="space-y-4">
              <EmptyActivity
                filtered={hasAttributionFilter || projectId !== "all"}
              />
              {canLoadMore ? (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (continueCursor !== null) setCursor(continueCursor);
                    }}
                  >
                    Search next page
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="divide-y md:hidden">
                {rows.map((event) => (
                  <div key={event._id} className="space-y-3 py-4 first:pt-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">
                          {event.projectName ??
                            event.projectSlug ??
                            "Unknown API"}
                        </p>
                        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                          {event.method.toUpperCase()} {event.endpoint}
                        </p>
                      </div>
                      <StatusBadge status={event.status} />
                    </div>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                      <div>
                        <dt className="text-muted-foreground">Time</dt>
                        <dd>{formatActivityDate(event.at)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Cost</dt>
                        <dd className="tabular-nums">
                          {event.credits.toLocaleString("en-US")} credits
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Latency</dt>
                        <dd className="tabular-nums">{event.latencyMs} ms</dd>
                      </div>
                    </dl>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => inspectEvent(event._id)}
                    >
                      <Search />
                      Inspect call
                    </Button>
                  </div>
                ))}
              </div>
              <div className="hidden overflow-x-auto md:block">
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
                      <th
                        scope="col"
                        className="px-2 py-2 text-right font-medium"
                      >
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((event) => (
                      <tr key={event._id} className="border-b last:border-0">
                        <td className="whitespace-nowrap px-2 py-2.5 text-muted-foreground">
                          {formatActivityDate(event.at)}
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
                          {event.credits.toLocaleString("en-US")}
                        </td>
                        <td className="px-2 py-2.5">
                          <StatusBadge status={event.status} />
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                          {event.latencyMs}ms
                        </td>
                        <td className="px-2 py-2.5 text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => inspectEvent(event._id)}
                            aria-label={`Inspect ${event.method.toUpperCase()} ${event.endpoint}`}
                          >
                            Inspect
                          </Button>
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
              {usageQuery.isError && rows.length > 0 ? (
                <div
                  className="flex flex-wrap items-center justify-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3"
                  role="alert"
                >
                  <p className="text-sm text-destructive">
                    More activity could not be loaded. Existing rows are still
                    available.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void usageQuery.refetch()}
                  >
                    Retry page
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <ActivityInspector
        open={search.event !== undefined}
        event={selectedEvent}
        requestedId={search.event}
        pending={eventQuery.isPending && selectedFromRows === null}
        failed={eventQuery.isError}
        onRetry={() => void eventQuery.refetch()}
        onOpenChange={(open) => {
          if (!open) closeInspector();
        }}
      />
    </div>
  );
}

function ActivityInspector({
  open,
  event,
  requestedId,
  pending,
  failed,
  onRetry,
  onOpenChange,
}: {
  open: boolean;
  event: UsageListItem | null;
  requestedId?: string;
  pending: boolean;
  failed: boolean;
  onRetry: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Call inspector</SheetTitle>
          <SheetDescription>
            Exact usage metadata retained for this metered gateway call.
          </SheetDescription>
        </SheetHeader>
        {pending ? (
          <div className="space-y-3 px-4 pb-6" aria-label="Loading call">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : failed ? (
          <div className="space-y-3 px-4 pb-6" role="alert">
            <p className="text-sm font-medium">Call details did not load</p>
            <p className="text-sm text-muted-foreground">
              Check your connection and organization access, then retry.
            </p>
            <Button type="button" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : event ? (
          <div className="space-y-5 px-4 pb-6">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={event.status} />
              <Badge variant="outline" className="font-mono uppercase">
                {event.method}
              </Badge>
              <Badge variant="secondary" className="tabular-nums">
                {event.credits.toLocaleString("en-US")} credits
              </Badge>
            </div>
            <dl className="divide-y rounded-lg border text-sm">
              <InspectorRow label="Time" value={formatActivityDate(event.at)} />
              <InspectorRow
                label="API"
                value={event.projectName ?? event.projectSlug ?? "Unavailable"}
              />
              <InspectorRow label="Endpoint" value={event.endpoint} mono />
              <InspectorRow
                label="Latency"
                value={`${event.latencyMs.toLocaleString("en-US")} ms`}
              />
              <InspectorRow label="Key" value={event.keyId} mono />
              <InspectorRow label="Usage event" value={event._id} mono />
            </dl>
            <div className="rounded-lg border bg-muted/30 p-4">
              <p className="text-sm font-medium">Payload retention</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Request headers, bodies, response bodies, and gateway request ID
                are not stored in usage events. This inspector cannot
                reconstruct them.
              </p>
            </div>
          </div>
        ) : (
          <div className="px-4 pb-6">
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyTitle>Call not found</EmptyTitle>
                <EmptyDescription>
                  Event {requestedId ?? "requested"} does not exist or is not
                  authorized for this organization.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function InspectorRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid gap-1 px-3 py-3 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs" : "break-words"}>
        {value}
      </dd>
    </div>
  );
}

function EmptyActivity({ filtered }: { filtered: boolean }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Activity />
        </EmptyMedia>
        <EmptyTitle>
          {filtered ? "No matching activity" : "No activity yet"}
        </EmptyTitle>
        <EmptyDescription>
          {filtered
            ? "No calls match this drill-down and time range. Clear the filter or widen the range."
            : "Usage events land after gateway calls. Browse the catalogue, create a key, and make a call."}
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
