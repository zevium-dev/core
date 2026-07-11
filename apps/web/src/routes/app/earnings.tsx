import { useOrganization } from "@clerk/tanstack-react-start";
import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import { Banknote, HandCoins } from "lucide-react";
import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { NumberTicker } from "#/components/motion/number-ticker";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Skeleton } from "#/components/ui/skeleton";
import { Textarea } from "#/components/ui/textarea";
import { mergeUsagePages } from "#/lib/activity-filters";
import { api } from "#/lib/convex-api";
import { humanError } from "#/lib/human-error";
import {
  MIN_PAYOUT_CREDITS,
  payoutStatusLabel,
  payoutStatusVariant,
  validatePayoutAmount,
} from "#/lib/payout-helpers";
import { formatCreditsAsUsd } from "#/lib/project-helpers";
import type { MyPayoutRequest } from "../../../../../convex/payouts";

const REQUESTS_PAGE_SIZE = 25;

export const Route = createFileRoute("/app/earnings")({
  component: EarningsPage,
  head: () => ({
    meta: [{ title: "Earnings · Zevium" }],
  }),
  pendingComponent: EarningsPageSkeleton,
});

function EarningsPage() {
  const { organization, isLoaded } = useOrganization();
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
  const orgSlug =
    organization && typeof organization.slug === "string"
      ? organization.slug
      : null;

  if (!isLoaded || convexAuthLoading) {
    return <EarningsPageSkeleton />;
  }

  if (!orgSlug) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Earnings</h1>
        <p className="text-sm text-muted-foreground">
          Select an organization to view earnings and request payouts.
        </p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <EarningsPageSkeleton />;
  }

  return (
    <Suspense fallback={<EarningsPageSkeleton />}>
      <EarningsContent orgSlug={orgSlug} />
    </Suspense>
  );
}

function EarningsContent({ orgSlug }: { orgSlug: string }) {
  const { data: earnings } = useSuspenseQuery(
    convexQuery(api.earnings.forOrg, { orgSlug }),
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Earnings</h1>
        <p className="text-sm text-muted-foreground">
          Publisher revenue across every project in this organization. You keep
          95% of gross credits charged to consumers.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          This UTC month
        </h2>
        <EarningsStatGrid
          calls={earnings.month.calls}
          grossCredits={earnings.month.grossCredits}
          netCredits={earnings.month.netCredits}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">All time</h2>
        <EarningsStatGrid
          calls={earnings.allTime.calls}
          grossCredits={earnings.allTime.grossCredits}
          netCredits={earnings.allTime.netCredits}
        />
      </section>

      <ByProjectTable rows={earnings.byProject} />

      <PayoutSection orgSlug={orgSlug} />
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

function ByProjectTable({
  rows,
}: {
  rows: {
    projectId: string;
    name: string;
    slug: string;
    calls: number;
    grossCredits: number;
    netCredits: number;
  }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>By project</CardTitle>
        <CardDescription>All-time earnings per project.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No metered calls yet. Publish a project and go public to start
            earning.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-2 py-2 font-medium">Project</th>
                  <th className="px-2 py-2 font-medium text-right">Calls</th>
                  <th className="px-2 py-2 font-medium text-right">
                    Gross credits
                  </th>
                  <th className="px-2 py-2 font-medium text-right">
                    Net credits
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.projectId} className="border-b last:border-0">
                    <td className="px-2 py-2.5 font-medium">{row.name}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {row.calls.toLocaleString()}
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {row.grossCredits.toLocaleString()}
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {row.netCredits.toLocaleString()} ·{" "}
                      <span className="text-muted-foreground">
                        {formatCreditsAsUsd(row.netCredits)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PayoutSection({ orgSlug }: { orgSlug: string }) {
  const { data: redeemable } = useSuspenseQuery(
    convexQuery(api.payouts.redeemableCredits, { orgSlug }),
  );

  const [creditsInput, setCreditsInput] = useState("");
  const [destination, setDestination] = useState("");

  const requestPayoutMutation = useConvexMutation(api.payouts.requestPayout);
  const { mutate: submitPayout, isPending: submitPending } = useMutation({
    mutationFn: (vars: { credits: number; destination: string }) =>
      requestPayoutMutation({
        orgSlug,
        credits: vars.credits,
        destination: vars.destination,
      }),
    onSuccess: () => {
      toast.success("Payout requested. We'll fulfil it manually.");
      setCreditsInput("");
      setDestination("");
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not request payout."));
    },
  });

  const parsedCredits = Number.parseInt(creditsInput, 10);
  const clientError =
    creditsInput.trim().length === 0
      ? null
      : validatePayoutAmount(parsedCredits, redeemable.redeemable);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitPending) return;
    const error = validatePayoutAmount(parsedCredits, redeemable.redeemable);
    if (error) {
      toast.error(error);
      return;
    }
    const trimmedDestination = destination.trim();
    if (trimmedDestination.length === 0) {
      toast.error("Payout destination is required.");
      return;
    }
    submitPayout({ credits: parsedCredits, destination: trimmedDestination });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardDescription className="flex items-center gap-2">
            <Banknote className="size-3.5" />
            Redeemable
          </CardDescription>
          <CardTitle className="text-3xl tabular-nums">
            <NumberTicker value={redeemable.redeemable} />
            <span className="ml-2 text-base font-normal text-muted-foreground">
              credits
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {formatCreditsAsUsd(redeemable.redeemable)} available · minimum
            payout is {MIN_PAYOUT_CREDITS.toLocaleString()} credits ($10).
          </p>
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="payout-credits">Credits</Label>
              <div className="flex gap-2">
                <Input
                  id="payout-credits"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  placeholder="100000"
                  value={creditsInput}
                  onChange={(e) => setCreditsInput(e.target.value)}
                  aria-invalid={clientError !== null}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={redeemable.redeemable <= 0}
                  onClick={() => setCreditsInput(String(redeemable.redeemable))}
                >
                  Max
                </Button>
              </div>
              {clientError ? (
                <p className="text-xs text-destructive">{clientError}</p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payout-destination">Payout destination</Label>
              <Textarea
                id="payout-destination"
                placeholder="Bank / PayPal / UPI details"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                rows={3}
              />
            </div>
            <Button
              type="submit"
              disabled={
                submitPending ||
                creditsInput.trim().length === 0 ||
                clientError !== null ||
                destination.trim().length === 0
              }
            >
              {submitPending ? "Requesting…" : "Request payout"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <PayoutHistoryCard orgSlug={orgSlug} />
    </div>
  );
}

function PayoutHistoryCard({ orgSlug }: { orgSlug: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [rows, setRows] = useState<MyPayoutRequest[]>([]);
  const [isDone, setIsDone] = useState(false);
  const [continueCursor, setContinueCursor] = useState<string | null>(null);

  const args = useMemo(
    () => ({
      orgSlug,
      paginationOpts: { numItems: REQUESTS_PAGE_SIZE, cursor },
    }),
    [orgSlug, cursor],
  );
  const requestsQuery = useQuery(convexQuery(api.payouts.listMyRequests, args));

  useEffect(() => {
    if (!requestsQuery.data || requestsQuery.isPending) return;
    setRows((prev) =>
      mergeUsagePages(prev, requestsQuery.data!.page, cursor === null),
    );
    setIsDone(requestsQuery.data.isDone);
    setContinueCursor(requestsQuery.data.continueCursor);
  }, [requestsQuery.data, requestsQuery.isPending, cursor]);

  // Reset accumulated pages when the org changes.
  useEffect(() => {
    setCursor(null);
    setRows([]);
    setIsDone(false);
    setContinueCursor(null);
  }, [orgSlug]);

  const firstPagePending = requestsQuery.isPending && cursor === null;
  const loadMorePending = requestsQuery.isPending && cursor !== null;
  const canLoadMore =
    !isDone && continueCursor !== null && !requestsQuery.isPending;

  return (
    <Card>
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          <HandCoins className="size-3.5" />
          Requests
        </CardDescription>
        <CardTitle className="text-base">Payout history</CardTitle>
      </CardHeader>
      <CardContent>
        {firstPagePending ? (
          <PayoutHistorySkeleton />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No payout requests yet.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-2 py-2 font-medium">Status</th>
                    <th className="px-2 py-2 font-medium text-right">
                      Credits
                    </th>
                    <th className="px-2 py-2 font-medium text-right">USD</th>
                    <th className="px-2 py-2 font-medium">Requested</th>
                    <th className="px-2 py-2 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row._id} className="border-b last:border-0">
                      <td className="px-2 py-2.5">
                        <Badge variant={payoutStatusVariant(row.status)}>
                          {payoutStatusLabel(row.status)}
                        </Badge>
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums">
                        {row.credits.toLocaleString()}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                        {formatCreditsAsUsd(row.credits)}
                      </td>
                      <td className="px-2 py-2.5 text-muted-foreground">
                        {new Date(row.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-2 py-2.5 text-muted-foreground">
                        {row.note ?? "—"}
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
                    if (continueCursor !== null) setCursor(continueCursor);
                  }}
                >
                  {loadMorePending ? "Loading…" : "Load more"}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        Payouts are fulfilled manually by platform staff.
      </CardFooter>
    </Card>
  );
}

function PayoutHistorySkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="ml-auto h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

function EarningsPageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
      <Skeleton className="h-48 rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    </div>
  );
}
