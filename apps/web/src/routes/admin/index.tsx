import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Building2, FileStack, PhoneCall } from "lucide-react";

import { NumberTicker } from "#/components/motion/number-ticker";
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
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Skeleton } from "#/components/ui/skeleton";
import { api } from "#/lib/convex-api";
import { humanError } from "#/lib/human-error";
import type {
  PlatformStats,
  AdminUsageView,
} from "../../../../../convex/admin";

const ADMIN_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

export const Route = createFileRoute("/admin/")({
  component: AdminOverviewPage,
  head: () => ({
    meta: [{ title: "Admin Overview · Zevium" }],
  }),
  pendingComponent: OverviewSkeleton,
});

function AdminOverviewPage() {
  const statsQuery = useQuery(convexQuery(api.admin.platformStats, {}));
  const usageQuery = useQuery(convexQuery(api.admin.recentUsage, {}));

  if (statsQuery.isPending || usageQuery.isPending) {
    return <OverviewSkeleton />;
  }

  // Queries are admin-gated by the layout; a stale-session error surfaces as
  // a human-readable message rather than raw internals.
  if (statsQuery.data === undefined || usageQuery.data === undefined) {
    const error = statsQuery.error ?? usageQuery.error;
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground">
          {humanError(
            error,
            "Could not load platform data. You may need to sign in again.",
          )}
        </p>
        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={() => {
            void Promise.all([statsQuery.refetch(), usageQuery.refetch()]);
          }}
        >
          Retry
        </Button>
      </div>
    );
  }

  return <OverviewContent stats={statsQuery.data} usage={usageQuery.data} />;
}

function OverviewContent({
  stats,
  usage,
}: {
  stats: PlatformStats;
  usage: AdminUsageView[];
}) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Platform-wide counts and recent metered activity.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              <Building2 className="size-3.5" />
              Organizations
            </CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              <NumberTicker value={stats.orgs} />
            </CardTitle>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              <FileStack className="size-3.5" />
              Projects
            </CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              <NumberTicker value={stats.projectsTotal} />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex gap-1.5 text-xs text-muted-foreground">
            <Badge variant="secondary">
              {stats.projects.published} published
            </Badge>
            <Badge variant="outline">{stats.projects.draft} draft</Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              <PhoneCall className="size-3.5" />
              Calls this month
            </CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              <NumberTicker value={stats.usageThisMonth} />
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {stats.usageCapped
              ? `Capped at ${stats.usageCap.toLocaleString("en-US")} (scan limit)`
              : "Indexed by event time"}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              <PhoneCall className="size-3.5" />
              Recent credits
            </CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              <NumberTicker value={sumCredits(usage)} />
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Summed across the {usage.length} most recent events
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent usage</CardTitle>
          <CardDescription>
            Newest {usage.length} metered gateway events platform-wide.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {usage.length === 0 ? (
            <Empty className="py-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PhoneCall />
                </EmptyMedia>
                <EmptyTitle>No usage events yet</EmptyTitle>
                <EmptyDescription>
                  Metered gateway activity will appear here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="px-2 py-2 font-medium">
                      When
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      Project
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      Endpoint
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      Status
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
                      Latency
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {usage.map((event) => (
                    <tr key={event._id} className="border-b last:border-0">
                      <td className="whitespace-nowrap px-2 py-2.5 text-muted-foreground">
                        {ADMIN_DATE_FORMATTER.format(event.at)}
                      </td>
                      <td className="px-2 py-2.5 font-mono text-xs text-muted-foreground">
                        {event.projectId}
                      </td>
                      <td className="px-2 py-2.5 font-mono text-xs">
                        <span className="text-muted-foreground">
                          {event.method}
                        </span>{" "}
                        {event.endpoint}
                      </td>
                      <td className="px-2 py-2.5">
                        <StatusBadge status={event.status} />
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums">
                        {event.credits.toLocaleString("en-US")}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                        {event.latencyMs}ms
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Sum credits across a usage page (pure, inline-able but reused by the card). */
function sumCredits(events: readonly AdminUsageView[]): number {
  let total = 0;
  for (const e of events) {
    total += e.credits;
  }
  return total;
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

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-16" />
            </CardHeader>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-56" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-5 w-10 rounded-full" />
              <Skeleton className="h-4 w-12" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
