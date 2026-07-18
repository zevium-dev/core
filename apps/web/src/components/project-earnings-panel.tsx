import { convexQuery } from "@convex-dev/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";

import { NumberTicker } from "#/components/motion/number-ticker";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Skeleton } from "#/components/ui/skeleton";
import { api } from "#/lib/convex-api";
import { CREDITS_PER_DOLLAR, formatCreditsAsUsd } from "#/lib/project-helpers";

export function ProjectEarningsPanel({
  orgSlug,
  projectSlug,
}: {
  orgSlug: string;
  projectSlug: string;
}) {
  const { data } = useSuspenseQuery(
    convexQuery(api.earnings.forOrg, { orgSlug }),
  );

  const projectRow = data.byProject.find((row) => row.slug === projectSlug);
  const project = projectRow ?? {
    calls: 0,
    grossCredits: 0,
    netCredits: 0,
  };

  // Month totals from forOrg are org-wide. Project-scoped month is not in the
  // API yet — surface project all-time as the source of truth and org month
  // as context so publishers still see the 95% cut language.
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Earnings</CardTitle>
          <CardDescription>
            You keep 95% of gross credits charged to consumers. Platform takes
            5%. Conversion: {CREDITS_PER_DOLLAR.toLocaleString()} credits = $1.
          </CardDescription>
        </CardHeader>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          This project · all time
        </h2>
        <EarningsStatGrid
          calls={project.calls}
          grossCredits={project.grossCredits}
          netCredits={project.netCredits}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          Organization · this UTC month
        </h2>
        <EarningsStatGrid
          calls={data.month.calls}
          grossCredits={data.month.grossCredits}
          netCredits={data.month.netCredits}
        />
        <p className="text-xs text-muted-foreground">
          Month figures are org-wide (all projects). Project-level month lands
          when the control plane exposes it.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          Organization · all time
        </h2>
        <EarningsStatGrid
          calls={data.allTime.calls}
          grossCredits={data.allTime.grossCredits}
          netCredits={data.allTime.netCredits}
        />
      </section>

      {project.calls === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No metered calls on this project yet. Publish, go public, and
            earnings land here at 95% of consumer spend.
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function EarningsStatGrid({
  calls,
  grossCredits,
  netCredits,
}: {
  calls: number;
  grossCredits: number;
  netCredits: number;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Calls</CardDescription>
          <CardTitle className="text-2xl tabular-nums">
            <NumberTicker value={calls} />
          </CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Gross credits</CardDescription>
          <CardTitle className="text-2xl tabular-nums">
            <NumberTicker value={grossCredits} />
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          {formatCreditsAsUsd(grossCredits)} consumer spend
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Net credits (you keep 95%)</CardDescription>
          <CardTitle className="text-2xl tabular-nums">
            <NumberTicker value={netCredits} />
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          {formatCreditsAsUsd(netCredits)} publisher share
        </CardContent>
      </Card>
    </div>
  );
}

export function EarningsSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-24 rounded-xl" />
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
    </div>
  );
}
