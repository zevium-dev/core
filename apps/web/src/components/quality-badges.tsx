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
  return value === null ? "unavailable" : `${Math.round(value)} ms p50`;
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
          quality.insufficientApiData
            ? `API quality: insufficient data (${quality.apiSampleSize}/${quality.apiMinimumSampleSize})`
            : `API success ${quality.apiSuccessRatePercent?.toFixed(1)}% · ${latency(quality.apiLatencyP50Ms)}`,
          quality.insufficientReachabilityData
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

  if (compact) return content;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Quality evidence</CardTitle>
        <CardDescription>
          API success and latency use privacy-minimized real gateway calls.
          Reachability checks only publisher-declared safe health endpoint; it
          never claims other API operations succeed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {content}
        <p className="text-xs text-muted-foreground">
          Metrics stay hidden until minimum sample counts are met and reset for
          every published version.
        </p>
      </CardContent>
    </Card>
  );
}
