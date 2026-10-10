import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import type { QualityProbeOutcome } from "@zevium/shared";

import { QualityBadges } from "#/components/quality-badges";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
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
  EmptyTitle,
} from "#/components/ui/empty";
import { Skeleton } from "#/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { api } from "#/lib/convex-api";
import type { Id } from "#/lib/convex-data-model";
import { formatTimestamp } from "#/lib/format";

const outcomeLabels: Record<QualityProbeOutcome, string> = {
  healthy: "Healthy",
  http_error: "HTTP error",
  timeout: "Timed out",
  dns_error: "DNS error",
  tls_error: "TLS error",
  network_error: "Network error",
  blocked_target: "Blocked target",
};

export function ProjectQualityPanel({
  projectId,
}: {
  projectId: Id<"projects">;
}) {
  const { data, isPending, isError, refetch } = useQuery(
    convexQuery(api.quality.getPublisherQuality, { projectId }),
  );
  if (isError)
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load quality evidence</AlertTitle>
        <AlertDescription>
          <p>Check your connection and active organization, then retry.</p>
          <Button variant="outline" onClick={() => void refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  if (isPending) return <QualitySkeleton />;

  const suspended = data.status === "suspended" || data.status === "recovering";
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Listing quality</CardTitle>
          <CardDescription>
            {data.version
              ? `Current published version: ${data.version}.`
              : "Publish a version to start collecting quality evidence."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Badge variant={suspended ? "destructive" : "secondary"}>
              {suspended
                ? data.status === "recovering"
                  ? "Recovering"
                  : "Suspended"
                : data.version
                  ? "No quality suspension"
                  : "Not published"}
            </Badge>
            {data.suspendedAt !== null ? (
              <span className="text-sm text-muted-foreground">
                Since {formatTimestamp(data.suspendedAt)}
              </span>
            ) : null}
          </div>
          {suspended ? (
            <Alert>
              <AlertTitle>Restore your listing</AlertTitle>
              <AlertDescription>
                <p>
                  {data.suspensionReason ??
                    "The declared health endpoint has repeatedly failed its checks."}
                </p>
                <p>
                  Catalogue visibility and gateway access remain suspended
                  during recovery.
                </p>
                <ol className="list-decimal pl-5">
                  <li>
                    Restore the published spec’s declared health endpoint. It
                    must be reachable over public HTTPS without credentials and
                    return HTTP 2xx or 3xx.
                  </li>
                  <li>
                    Use the probe history below to check HTTP errors, timeouts,
                    DNS or TLS failures. If the health endpoint declaration
                    changed, save, test and publish a new spec version in the
                    Spec tab.
                  </li>
                  <li>
                    Scheduled probes run about every{" "}
                    {data.probeIntervalMs / 60_000} minutes. After{" "}
                    {data.recoveryRequired} consecutive healthy checks, gateway
                    access and the listing’s intended visibility are restored
                    automatically. A failed check resets progress.
                  </li>
                </ol>
                <p>
                  Recovery progress: {data.recoveryPasses}/
                  {data.recoveryRequired} consecutive healthy checks.
                </p>
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
      <QualityBadges quality={data.quality} />
      <Card>
        <CardHeader>
          <CardTitle>Probe history</CardTitle>
          <CardDescription>
            Up to {data.historyLimit} most recent checks for the current
            published version. These check the declared health endpoint, not
            paid operations.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.probes.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No probes yet</EmptyTitle>
                <EmptyDescription>
                  {data.version
                    ? "Scheduled health checks will appear here when collected."
                    : "Publish a version with a declared health endpoint to start scheduled checks."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableCaption>
                Health endpoint responses do not prove paid API calls succeed.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Checked at (UTC)</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>HTTP status</TableHead>
                  <TableHead>Probe latency</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.probes.map((probe) => (
                  <TableRow key={probe.id}>
                    <TableCell>
                      <time dateTime={new Date(probe.checkedAt).toISOString()}>
                        {formatTimestamp(probe.checkedAt)}
                      </time>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {outcomeLabels[probe.outcome]}
                      </Badge>
                    </TableCell>
                    <TableCell>{probe.statusCode ?? "No response"}</TableCell>
                    <TableCell>
                      {probe.latencyMs === null
                        ? "Unavailable"
                        : `${Math.round(probe.latencyMs)} ms`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function QualitySkeleton() {
  return (
    <div
      className="flex flex-col gap-4"
      aria-label="Loading quality evidence"
      aria-busy="true"
    >
      {["status", "evidence", "history"].map((section) => (
        <Card key={section}>
          <CardHeader>
            <Skeleton className="h-6 w-36" />
            <Skeleton className="h-4 w-3/4" />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-2/3" />
            {section === "history" ? (
              <Skeleton className="h-32 w-full" />
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
