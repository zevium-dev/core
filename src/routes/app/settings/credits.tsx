import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { z } from "zod";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { useTRPC } from "~/lib/trpc";

const PAGE_SIZE = 20;
const MIN_TOP_UP_USD = 20;
const DEFAULT_TOP_UP_USD = 20;

const amountInputSchema = z.number().int().min(MIN_TOP_UP_USD).max(100_000);

/* eslint-disable perfectionist/sort-objects */
export const Route = createFileRoute("/app/settings/credits")({
  validateSearch: z.object({
    page: z.coerce.number().int().positive().optional(),
  }),
  loader: ({ context }) => {
    void context.queryClient.ensureQueryData(context.trpc.organization.list.queryOptions());
  },
  component: CreditsComponent,
});
/* eslint-enable perfectionist/sort-objects */

function CreditsComponent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const currentPage = search.page ?? 1;
  const [amountUsd, setAmountUsd] = useState<string>(String(DEFAULT_TOP_UP_USD));

  const orgListQuery = useSuspenseQuery(trpc.organization.list.queryOptions());
  const activeOrg = orgListQuery.data[0];
  const orgId = activeOrg?.id ?? "";

  const balanceQuery = useSuspenseQuery(
    trpc.credits.getBalance.queryOptions({ organizationId: orgId }),
  );
  const topUpsQuery = useSuspenseQuery(
    trpc.credits.listTopUps.queryOptions({
      organizationId: orgId,
      page: currentPage,
      pageSize: PAGE_SIZE,
    }),
  );
  const chargesQuery = useSuspenseQuery(
    trpc.credits.listCharges.queryOptions({
      organizationId: orgId,
      page: currentPage,
      pageSize: PAGE_SIZE,
    }),
  );

  const topupMutation = useMutation(
    trpc.credits.createTopUp.mutationOptions({
      onSuccess(data) {
        window.location.assign(data.url);
      },
    }),
  );

  const handleTopUp = () => {
    const parsed = amountInputSchema.safeParse(Number(amountUsd));
    if (!parsed.success || !orgId) return;
    topupMutation.mutate({ amountUsd: parsed.data, organizationId: orgId });
  };

  const handlePageChange = (newPage: number) => {
    void navigate({ replace: true, search: { page: newPage } });
  };

  const currentBalance = useMemo(() => {
    const credits = balanceQuery.data.available;
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(credits);
  }, [balanceQuery.data.available]);

  if (!activeOrg) {
    return (
      <div className="mx-auto w-full max-w-3xl min-w-0 flex-1 space-y-6 p-6">
        <h1 className="text-2xl font-bold text-foreground">Credits</h1>
        <p className="text-sm text-muted-foreground">
          You need an organization before you can buy or use credits. Create one in the dashboard.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl min-w-0 flex-1 space-y-6 p-6">
      <h1 className="text-2xl font-bold text-foreground">Credits</h1>

      <Card className="w-full border-border/50 bg-card/50 backdrop-blur-sm">
        <CardContent className="p-6">
          <div className="text-4xl font-bold text-foreground">{currentBalance} credits</div>
          <div className="mt-2 text-xs text-muted-foreground">
            {balanceQuery.data.consumed} consumed / {balanceQuery.data.creditedUnits} total
          </div>
        </CardContent>
      </Card>

      <Card className="w-full border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg font-semibold">Buy Credits</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Input
              className="w-32"
              inputMode="numeric"
              min={MIN_TOP_UP_USD}
              onChange={(e) => setAmountUsd(e.target.value)}
              placeholder="Amount (USD)"
              type="number"
              value={amountUsd}
            />
            <Button
              className="flex-1"
              disabled={topupMutation.isPending}
              onClick={handleTopUp}
              size="lg"
            >
              {topupMutation.isPending ? "Redirecting..." : "Add Credits"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">Minimum ${MIN_TOP_UP_USD} per top-up.</p>
        </CardContent>
      </Card>

      <Card className="w-full border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg font-semibold">Recent Top-Ups</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {topUpsQuery.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No top-ups yet.</p>
          ) : (
            topUpsQuery.data.items.map((tx) => (
              <div
                className="flex items-center justify-between border-b border-border/20 py-2 last:border-b-0"
                key={tx.id}
              >
                <span className="text-sm text-muted-foreground">
                  {new Date(tx.createdAt).toLocaleString()}
                </span>
                <span className="text-sm font-medium text-primary">
                  +${(tx.amountCents / 100).toFixed(2)}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="w-full border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg font-semibold">Recent Charges</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {chargesQuery.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No charges yet.</p>
          ) : (
            chargesQuery.data.items.map((tx) => (
              <div
                className="flex items-center justify-between border-b border-border/20 py-2 last:border-b-0"
                key={`${tx.requestId ?? "noid"}-${tx.createdAt}`}
              >
                <span className="text-sm text-muted-foreground">
                  {new Date(tx.createdAt).toLocaleString()}
                </span>
                <span className="text-sm font-medium text-destructive">
                  -{tx.costUnits} credits
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
