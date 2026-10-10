import type { QualitySnapshotContract } from "@zevium/shared";

import { Badge } from "#/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";

function latency(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value)} ms p50`
    : "latency unavailable";
}

export function QualityBadges({
  quality,
  compact = false,
}: {
  quality: QualitySnapshotContract | null;
  compact?: boolean;
}) {
  const badges =
    quality === null
      ? [
          "API quality: insufficient data (0/20)",
          "Reachability: insufficient data (0/3)",
        ]
      : [
          quality.insufficientApiData ||
          typeof quality.apiSuccessRatePercent !== "number" ||
          !Number.isFinite(quality.apiSuccessRatePercent)
            ? `API quality: insufficient data (${quality.apiSampleSize}/${quality.apiMinimumSampleSize})`
            : `API success ${quality.apiSuccessRatePercent?.toFixed(1)}% · ${latency(quality.apiLatencyP50Ms)}`,
          quality.insufficientReachabilityData ||
          typeof quality.reachabilityPercent !== "number" ||
          !Number.isFinite(quality.reachabilityPercent)
            ? `Reachability: insufficient data (${quality.reachabilitySampleSize}/${quality.reachabilityMinimumSampleSize})`
            : `Reachability ${quality.reachabilityPercent?.toFixed(1)}% · ${latency(quality.reachabilityLatencyP50Ms)}`,
        ];

  const content = (
    <div className="flex flex-wrap gap-2" aria-label="API quality evidence">
      {badges.map((label) => (
        <Badge key={label} variant="outline" className="whitespace-normal">
          {label}
        </Badge>
      ))}
      {quality !== null ? (
        <Badge variant="secondary">
          Data {quality.freshness.status}
          <span className="sr-only">
            {`, measured ${new Date(quality.freshness.measuredAt).toISOString()}`}
          </span>
        </Badge>
      ) : null}
    </div>
  );

  if (compact)
    return (
      <div className="flex flex-col gap-2">
        {content}
        <p className="text-xs text-muted-foreground">
          Reachability checks the health endpoint, not paid operations.
        </p>
      </div>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Quality evidence</CardTitle>
        <CardDescription>
          API success and latency are measured from gateway calls. Reachability
          measures the publisher’s declared health endpoint, which can pass even
          when other operations fail.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {content}
        <p className="text-xs text-muted-foreground">
          Metrics appear once the minimum sample count is reached. Each
          published version starts with fresh samples.
        </p>
      </CardContent>
    </Card>
  );
}
