import { createFileRoute } from "@tanstack/react-router";
import { ExternalLink, FileText, Settings } from "lucide-react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { useTRPC } from "~/lib/trpc";

export const Route = createFileRoute("/app/settings/credits")({
  component: CreditsComponent,
});

// TODO: Replace with API call to fetch real credits data
// Mock data for recent transactions
const recentTransactions = [
  {
    amount: "$10",
    id: 1,
    time: "2 months ago",
  },
  {
    amount: "$3.75",
    id: 2,
    time: "2 months ago",
  },
  {
    amount: "$10",
    id: 3,
    time: "4 months ago",
  },
];

function CreditsComponent() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [_autoTopUpEnabled, _setAutoTopUpEnabled] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [amountUsd, setAmountUsd] = useState<string>("10");

  const balanceQuery = useQuery(trpc.credits.getBalance.queryOptions());
  const transactionsQuery = useQuery(trpc.credits.listTransactions.queryOptions({ page: currentPage, pageSize: 3 }));
  const topupMutation = useMutation(
    trpc.credits.createTopUpCheckout.mutationOptions({
      async onSuccess(data) {
        // Redirect to Polar checkout
        if (data?.url) window.location.assign(data.url);
        await qc.invalidateQueries(trpc.credits.getBalance.queryOptions());
        await qc.invalidateQueries(trpc.credits.listTransactions.queryOptions({ page: 1, pageSize: 3 }));
      },
    }),
  );

  const currentBalance = useMemo(() => {
    const cents = balanceQuery.data?.balanceCents ?? 0;
    return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(cents / 100);
  }, [balanceQuery.data]);

  return (
    <div className="mx-auto w-full max-w-3xl min-w-0 flex-1 space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-bold text-foreground">Credits</h1>
      </div>

      {/* Current Balance */}
      <Card className="w-full border-border/50 bg-card/50 backdrop-blur-sm">
        <CardContent className="p-6">
          <div className="text-4xl font-bold text-foreground">{currentBalance}</div>
        </CardContent>
      </Card>

      {/* Main Actions Grid */}
      <div
        className={`
        grid w-full grid-cols-1 gap-6
        lg:grid-cols-2
      `}
      >
        {/* Buy Credits */}
        <Card className="w-full border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg font-semibold">Buy Credits</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <Input
                className="w-32"
                inputMode="numeric"
                min={1}
                onChange={(e) => setAmountUsd(e.target.value)}
                placeholder="Amount (USD)"
                type="number"
                value={amountUsd}
              />
              <Button
                className="flex-1"
                disabled={topupMutation.isPending}
                onClick={() => {
                  const amount = Math.max(1, Math.floor(Number(amountUsd)));
                  topupMutation.mutate({ amountCents: amount * 100 });
                }}
                size="lg"
              >
                {topupMutation.isPending ? "Redirecting..." : "Add Credits"}
            </Button>
            </div>
            <Button
              className={`
              w-full text-sm text-muted-foreground
              hover:text-foreground
            `}
              variant="ghost"
            >
              View Usage <ExternalLink className="ml-1 h-3 w-3" />
            </Button>
          </CardContent>
        </Card>

        {/* Auto Top-Up */}
        <Card className="w-full border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-semibold">Auto Top-Up</CardTitle>
              <div className="flex items-center gap-2">
                <Settings className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Enable</span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Automatically purchase credits when your balance is below a certain threshold. Your most recent payment
              method will be used.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Transactions */}
      <Card className="w-full border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg font-semibold">Recent Transactions</CardTitle>
            <Button
              className={`
              text-sm text-muted-foreground
              hover:text-foreground
            `}
              variant="ghost"
            >
              Payment History <ExternalLink className="ml-1 h-3 w-3" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {(transactionsQuery.data?.items ?? []).map((tx) => {
              const sign = tx.amountCents >= 0 ? 1 : -1;
              const amountFmt = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(
                Math.abs(tx.amountCents) / 100,
              );
              const dateFmt = new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(tx.createdAt));
              return (
              <div
                className={`
                  flex items-center justify-between border-b border-border/20
                  py-2
                  last:border-b-0
                `}
                  key={tx.id}
              >
                  <span className="text-sm text-muted-foreground">{dateFmt}</span>
                <div className="flex items-center gap-4">
                  <span
                    className={`
                      text-sm font-medium ${sign > 0 ? "text-primary" : "text-destructive"}
                  `}
                  >
                      {sign > 0 ? "+" : "-"}
                      {amountFmt}
                  </span>
                    <button
                      className={`
                      text-xs text-muted-foreground hover:text-foreground hover:underline
                    `}
                      onClick={async () => {
                        const data = await qc.fetchQuery(trpc.credits.getInvoiceUrl.queryOptions({ orderId: tx.id }));
                        if (data?.url) window.open(data.url, "_blank");
                      }}
                      title={String(tx.reference ?? tx.id)}
                    >
                      Get Invoice <FileText className="ml-1 inline h-3 w-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          <div className="mt-6 flex items-center justify-center gap-2">
            <Button
              className="text-muted-foreground"
              disabled={currentPage === 1}
              onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
              size="sm"
              variant="ghost"
            >
              ‹
            </Button>
            <Button className="bg-muted text-foreground" size="sm" variant="ghost">
              {currentPage}
            </Button>
            <Button
              className="text-muted-foreground"
              disabled={!transactionsQuery.data?.hasNext}
              onClick={() => setCurrentPage((prev) => prev + 1)}
              size="sm"
              variant="ghost"
            >
              ›
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
