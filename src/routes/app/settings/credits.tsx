import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ExternalLink, FileText, Settings } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { useTRPC } from "~/lib/trpc";

const PAGE_SIZE = 3;

const amountInputSchema = z.number().int().positive().max(100_000);

export const Route = createFileRoute("/app/settings/credits")({
  validateSearch: z.object({
    page: z.number().int().positive().optional(),
  }),
  loader: ({ context }) => {
    void context.queryClient.ensureQueryData(context.trpc.credits.getBalance.queryOptions());
    void context.queryClient.ensureQueryData(
      context.trpc.credits.listTransactions.queryOptions({ page: 1, pageSize: PAGE_SIZE }),
    );
  },
  component: CreditsComponent,
});

interface TransactionRowProps {
  onGetInvoice: (orderId: string) => void;
  transaction: {
    amountCents: number;
    createdAt: Date | string;
    id: string;
    reference?: null | string;
  };
}

function CreditsComponent() {
  const trpc = useTRPC();
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const [_autoTopUpEnabled, _setAutoTopUpEnabled] = useState(false);
  const currentPage = search.page ?? 1;
  const [amountUsd, setAmountUsd] = useState<string>("10");
  const [selectedOrderId, setSelectedOrderId] = useState<null | string>(null);

  const balanceQuery = useSuspenseQuery(trpc.credits.getBalance.queryOptions());
  const transactionsQuery = useSuspenseQuery(
    trpc.credits.listTransactions.queryOptions({ page: currentPage, pageSize: PAGE_SIZE }),
  );

  // Query for invoice URL - enabled only when an order is selected
  const invoiceQuery = useQuery({
    ...trpc.credits.getInvoiceUrl.queryOptions({ orderId: selectedOrderId ?? "" }),
    enabled: Boolean(selectedOrderId),
  });

  const topupMutation = useMutation(
    trpc.credits.createTopUpCheckout.mutationOptions({
      onSuccess(data) {
        if (data?.url) {
          window.location.assign(data.url);
        }
      },
    }),
  );

  const currentBalance = useMemo(() => {
    const cents = balanceQuery.data.balanceCents;
    return new Intl.NumberFormat(undefined, { currency: "USD", style: "currency" }).format(cents / 100);
  }, [balanceQuery.data.balanceCents]);

  const handleTopUp = () => {
    const parsed = amountInputSchema.safeParse(Number(amountUsd));
    if (!parsed.success) {
      // Invalid input - could show error toast here
      return;
    }
    topupMutation.mutate({ amountCents: parsed.data * 100 });
  };

  const handleGetInvoice = (orderId: string) => {
    setSelectedOrderId(orderId);
  };

  // Open invoice when query completes
  useEffect(() => {
    if (invoiceQuery.data?.url && selectedOrderId) {
      window.open(invoiceQuery.data.url, "_blank");
      setSelectedOrderId(() => null);
    }
  }, [invoiceQuery.data, selectedOrderId]);

  const handlePageChange = (newPage: number) => {
    void navigate({
      replace: true,
      search: { page: newPage },
    });
  };

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
              <Button className="flex-1" disabled={topupMutation.isPending} onClick={handleTopUp} size="lg">
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
            {transactionsQuery.data.items.map((tx) => (
              <TransactionRow key={tx.id} onGetInvoice={handleGetInvoice} transaction={tx} />
            ))}
          </div>

          {/* Pagination */}
          <div className="mt-6 flex items-center justify-center gap-2">
            <Button
              className="text-muted-foreground"
              disabled={currentPage === 1}
              onClick={() => handlePageChange(Math.max(currentPage - 1, 1))}
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
              disabled={!transactionsQuery.data.hasNext}
              onClick={() => handlePageChange(currentPage + 1)}
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

function TransactionRow({ onGetInvoice, transaction }: TransactionRowProps) {
  const sign = transaction.amountCents >= 0 ? 1 : -1;
  const amountFmt = new Intl.NumberFormat(undefined, { currency: "USD", style: "currency" }).format(
    Math.abs(transaction.amountCents) / 100,
  );
  const createdAtDate =
    typeof transaction.createdAt === "string" ? new Date(transaction.createdAt) : transaction.createdAt;
  const dateFmt = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(createdAtDate);

  return (
    <div
      className={`
        flex items-center justify-between border-b border-border/20
        py-2
        last:border-b-0
      `}
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
          onClick={() => onGetInvoice(transaction.id)}
          title={transaction.reference ?? transaction.id}
          type="button"
        >
          Get Invoice <FileText className="ml-1 inline h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
