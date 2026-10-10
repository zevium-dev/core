import { ListBoundary } from "#/components/list-boundary";
import { StatusBadge } from "#/components/status-badge";
import { formatNumber, formatTimestamp } from "#/lib/format";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "#/components/ui/table";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useOrganization } from "@clerk/tanstack-react-start";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useConvexAuth, usePaginatedQuery } from "convex/react";
import { Activity } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { OrgCapabilityNotice } from "#/components/org-capability-notice";
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
  authorizedAttributionSearch,
  type ActivityTimeRange,
} from "#/lib/activity-filters";
import { truncateKeyId } from "#/lib/billing-cycle";
import { humanError } from "#/lib/human-error";
import { api } from "#/lib/convex-api";
import {
  capabilityProjectionsMatch,
  hasServerCapability,
  parseOrgCapabilityProjection,
} from "#/lib/org-capabilities";

type ActivitySearch = {
  range?: ActivityTimeRange;
  project?: string;
  key?: string;
  member?: string;
  endpoint?: string;
  method?: string;
  event?: string;
};

export function validateActivitySearch(
  search: Record<string, unknown>,
): ActivitySearch {
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
}

export const Route = createFileRoute("/app/settings/activity")({
  validateSearch: validateActivitySearch,
  component: ActivityPage,
  head: () => ({
    meta: [{ title: "Activity · Zevium" }],
  }),
});

type UsageListItem = FunctionReturnType<
  typeof api.usage.listForOrg
>["page"][number];

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

  return (
    <ListBoundary label="activity" resetKey={orgSlug}>
      <ActivityContent key={orgSlug} orgSlug={orgSlug} />
    </ListBoundary>
  );
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
  const projectRef = search.project ?? "all";
  const inspectorTriggerRef = useRef<HTMLElement | null>(null);

  // Freeze "now" per filter change so page fetches share the same window.
  const windowKey = JSON.stringify([
    orgSlug,
    timeRange,
    projectRef,
    search.key,
    search.member,
    search.endpoint,
    search.method,
  ]);
  const [window, setWindow] = useState(() => ({
    key: windowKey,
    now: Date.now(),
  }));
  // Adjust during render: never issue a new-filter query with an old time window.
  let windowNow = window.now;
  if (window.key !== windowKey) {
    windowNow = Date.now();
    setWindow({ key: windowKey, now: windowNow });
  }

  const accessQuery = useQuery(
    convexQuery(api.organizations.activeCapabilities, {}),
  );
  const capabilities = useMemo(
    () => parseOrgCapabilityProjection(accessQuery.data),
    [accessQuery.data],
  );
  const canViewOrgUsage = hasServerCapability(capabilities, "viewOrgUsage");
  const attributionSearch = useMemo(
    () => authorizedAttributionSearch(search, canViewOrgUsage),
    [canViewOrgUsage, search],
  );
  const cycleQuery = useQuery({
    ...convexQuery(api.billing.cycleBreakdown, { orgSlug }),
    enabled: capabilities !== null,
  });

  const since = useMemo(
    () => activitySinceMs(timeRange, windowNow),
    [timeRange, windowNow],
  );

  const listArgs = useMemo(() => {
    const args: Omit<
      FunctionArgs<typeof api.usage.listForOrg>,
      "paginationOpts"
    > = { orgSlug };
    if (projectRef !== "all") {
      args.projectRef = projectRef;
    }
    if (attributionSearch.key) args.keyId = attributionSearch.key;
    if (attributionSearch.member) args.memberId = attributionSearch.member;
    if (attributionSearch.endpoint) args.endpoint = attributionSearch.endpoint;
    if (attributionSearch.method) args.method = attributionSearch.method;
    if (since !== undefined) {
      args.since = since;
    }
    return args;
  }, [orgSlug, projectRef, attributionSearch, since]);

  const {
    results: rows,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.usage.listForOrg,
    capabilities === null
      ? "skip"
      : { ...listArgs, expectedRole: capabilities.role },
    { initialNumItems: ACTIVITY_PAGE_SIZE },
  );
  const cycle = cycleQuery.data;
  const cycleProjectionMatches = capabilityProjectionsMatch(
    capabilities,
    parseOrgCapabilityProjection(cycle?.access),
  );

  // Strip hostile admin-only attribution from member URLs after projection loads.
  useEffect(() => {
    if (capabilities === null || canViewOrgUsage || !search.member) return;
    void navigate({
      search: {
        ...(search.range ? { range: search.range } : {}),
        ...(search.project ? { project: search.project } : {}),
        ...(attributionSearch.key ? { key: attributionSearch.key } : {}),
        ...(attributionSearch.endpoint
          ? { endpoint: attributionSearch.endpoint }
          : {}),
        ...(attributionSearch.method
          ? { method: attributionSearch.method }
          : {}),
        ...(search.event ? { event: search.event } : {}),
      },
      replace: true,
    });
  }, [
    attributionSearch.endpoint,
    attributionSearch.key,
    attributionSearch.method,
    canViewOrgUsage,
    capabilities,
    navigate,
    search.event,
    search.member,
    search.project,
    search.range,
  ]);

  const projects = cycleProjectionMatches
    ? (cycle?.byProject ?? []).filter(
        (project): project is typeof project & { projectRef: string } =>
          project.projectRef !== null,
      )
    : [];
  const firstPagePending =
    accessQuery.isPending ||
    (capabilities !== null &&
      (cycleQuery.isPending || status === "LoadingFirstPage"));
  const loadMorePending = status === "LoadingMore";
  const canLoadMore = status === "CanLoadMore";
  const selectedFromRows = search.event
    ? (rows.find((event) => event.eventId === search.event) ?? null)
    : null;
  const eventQuery = useQuery({
    ...convexQuery(api.usage.getForOrgById, {
      orgSlug,
      eventId: search.event ?? "invalid",
    }),
    enabled:
      capabilities !== null &&
      search.event !== undefined &&
      selectedFromRows === null,
  });
  const queriedEvent = eventQuery.data ?? null;
  const selectedEvent = selectedFromRows ?? queriedEvent;
  const serverProjectionRejected =
    (!accessQuery.isPending && !accessQuery.isError && capabilities === null) ||
    (cycleQuery.data !== undefined &&
      (cycle === null || !cycleProjectionMatches)) ||
    (capabilities !== null &&
      !cycleQuery.isPending &&
      !cycleQuery.isError &&
      cycleQuery.data === undefined);
  const activityFailed =
    accessQuery.isError || cycleQuery.isError || serverProjectionRejected;
  const hasAttributionFilter = Boolean(
    attributionSearch.key ||
    attributionSearch.member ||
    attributionSearch.endpoint ||
    attributionSearch.method,
  );

  const inspectEvent = (eventId: string, trigger: HTMLElement) => {
    inspectorTriggerRef.current = trigger;
    void navigate({ search: { ...search, event: eventId } });
  };

  const closeInspector = () => {
    void navigate({
      search: {
        ...(search.range ? { range: search.range } : {}),
        ...(search.project ? { project: search.project } : {}),
        ...(attributionSearch.key ? { key: attributionSearch.key } : {}),
        ...(attributionSearch.member
          ? { member: attributionSearch.member }
          : {}),
        ...(search.endpoint ? { endpoint: search.endpoint } : {}),
        ...(search.method ? { method: search.method } : {}),
      },
      replace: true,
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <ActivityHeader />
      {capabilities !== null && !canViewOrgUsage ? (
        <OrgCapabilityNotice reason={capabilities.reasons.viewOrgUsage} />
      ) : null}

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
                value={projectRef}
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
                disabled={cycleQuery.isPending || !cycleProjectionMatches}
              >
                <SelectTrigger id="activity-project" className="min-w-[10rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All projects</SelectItem>
                    {projects.map((project) => (
                      <SelectItem
                        key={project.projectRef}
                        value={project.projectRef}
                      >
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
                      ...(projectRef === "all" ? {} : { project: projectRef }),
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
              {attributionSearch.member ? (
                <Badge variant="secondary" className="max-w-full break-all">
                  Member · {attributionSearch.member}
                </Badge>
              ) : null}
              {attributionSearch.key ? (
                <Badge variant="secondary" className="max-w-full break-all">
                  Key · {truncateKeyId(attributionSearch.key)}
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
                      ...(projectRef === "all" ? {} : { project: projectRef }),
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
          ) : activityFailed && rows.length === 0 ? (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyTitle>Could not load activity</EmptyTitle>
                <EmptyDescription>
                  {serverProjectionRejected
                    ? "We couldn’t confirm your organization access. Refresh and retry."
                    : humanError(
                        accessQuery.error ?? cycleQuery.error,
                        "Activity is temporarily unavailable.",
                      )}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void accessQuery.refetch();
                    void cycleQuery.refetch();
                  }}
                >
                  Retry
                </Button>
              </EmptyContent>
            </Empty>
          ) : rows.length === 0 ? (
            <div className="space-y-4">
              <EmptyActivity
                filtered={hasAttributionFilter || projectRef !== "all"}
              />
              {canLoadMore ? (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => loadMore(ACTIVITY_PAGE_SIZE)}
                  >
                    Search next page
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="overflow-x-auto">
                <Table className="w-full text-sm">
                  <TableHeader>
                    <TableRow className="border-b text-left text-muted-foreground">
                      <TableHead scope="col" className="px-2 py-2 font-medium">
                        Time
                      </TableHead>
                      <TableHead scope="col" className="px-2 py-2 font-medium">
                        Project
                      </TableHead>
                      {canViewOrgUsage ? (
                        <TableHead
                          scope="col"
                          className="px-2 py-2 font-medium"
                        >
                          Member
                        </TableHead>
                      ) : null}
                      <TableHead scope="col" className="px-2 py-2 font-medium">
                        Endpoint
                      </TableHead>
                      <TableHead scope="col" className="px-2 py-2 font-medium">
                        Credits
                      </TableHead>
                      <TableHead scope="col" className="px-2 py-2 font-medium">
                        Status
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="px-2 py-2 font-medium text-right"
                      >
                        Latency
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="px-2 py-2 text-right font-medium"
                      >
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((event, index) => (
                      <TableRow
                        key={event.eventId ?? `${event.at}:${index}`}
                        className="border-b last:border-0"
                      >
                        <TableCell className="whitespace-nowrap px-2 py-2.5 text-muted-foreground">
                          {formatTimestamp(event.at)}
                        </TableCell>
                        <TableCell className="px-2 py-2.5">
                          {event.projectName ?? event.projectSlug ?? "—"}
                        </TableCell>
                        {canViewOrgUsage ? (
                          <TableCell className="px-2 py-2.5">
                            {event.memberName ?? "Unattributed member"}
                          </TableCell>
                        ) : null}
                        <TableCell className="px-2 py-2.5 font-mono text-xs">
                          <span className="text-muted-foreground">
                            {event.method.toUpperCase()}
                          </span>{" "}
                          {event.endpoint}
                        </TableCell>
                        <TableCell className="px-2 py-2.5 tabular-nums">
                          {formatNumber(event.credits)}
                        </TableCell>
                        <TableCell className="px-2 py-2.5">
                          <StatusBadge status={event.status} />
                        </TableCell>
                        <TableCell className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                          {event.latencyMs}ms
                        </TableCell>
                        <TableCell className="px-2 py-2.5 text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={event.eventId === null}
                            title={
                              event.eventId === null
                                ? "Details are unavailable for this older call."
                                : undefined
                            }
                            onClick={(clickEvent) => {
                              if (event.eventId !== null) {
                                inspectEvent(
                                  event.eventId,
                                  clickEvent.currentTarget,
                                );
                              }
                            }}
                            aria-label={`Inspect ${event.method.toUpperCase()} ${event.endpoint}`}
                          >
                            Inspect
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {canLoadMore || loadMorePending ? (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadMorePending || !canLoadMore}
                    onClick={() => loadMore(ACTIVITY_PAGE_SIZE)}
                  >
                    {loadMorePending ? "Loading…" : "Load more"}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <ActivityInspector
        open={search.event !== undefined}
        event={serverProjectionRejected ? null : selectedEvent}
        showMember={canViewOrgUsage}
        pending={
          capabilities !== null &&
          eventQuery.isPending &&
          selectedFromRows === null
        }
        failed={
          eventQuery.isError ||
          serverProjectionRejected ||
          (!accessQuery.isPending && capabilities === null)
        }
        onRetry={() => {
          void accessQuery.refetch();
          void eventQuery.refetch();
        }}
        onOpenChange={(open) => {
          if (!open) closeInspector();
        }}
        restoreFocusRef={inspectorTriggerRef}
      />
    </div>
  );
}

function ActivityInspector({
  open,
  event,
  showMember,
  pending,
  failed,
  onRetry,
  onOpenChange,
  restoreFocusRef,
}: {
  open: boolean;
  event: UsageListItem | null;
  showMember: boolean;
  pending: boolean;
  failed: boolean;
  onRetry: () => void;
  onOpenChange: (open: boolean) => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = restoreFocusRef.current;
          if (target?.isConnected) target.focus();
          else document.getElementById("main-content")?.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle>Call inspector</SheetTitle>
          <SheetDescription>
            Status, cost, and timing recorded for this gateway call.
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
                {formatNumber(event.credits)} credits
              </Badge>
            </div>
            <dl className="divide-y rounded-lg border text-sm">
              <InspectorRow label="Time" value={formatTimestamp(event.at)} />
              <InspectorRow
                label="API"
                value={event.projectName ?? event.projectSlug ?? "Unavailable"}
              />
              <InspectorRow label="Endpoint" value={event.endpoint} mono />
              <InspectorRow
                label="Latency"
                value={`${formatNumber(event.latencyMs)} ms`}
              />
              <InspectorRow
                label="Key"
                value={truncateKeyId(event.keyId)}
                mono
              />
              {showMember && event.memberName !== undefined ? (
                <InspectorRow
                  label="Member"
                  value={event.memberName ?? "Unattributed member"}
                />
              ) : null}
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
                  Requested call does not exist or is not authorized for this
                  organization.
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
            : "Live calls will appear here. Choose an API from the catalogue, create a key, and add credits to make your first call."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link to="/app/catalogue">Browse catalogue</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
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
