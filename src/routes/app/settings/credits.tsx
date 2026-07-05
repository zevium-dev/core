import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { auth } from "~/lib/auth";
import { POLAR_TOPUP_PRODUCTS } from "~/env/client";
import { useTRPC } from "~/lib/trpc";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30_000;

/* eslint-disable perfectionist/sort-objects */
export const Route = createFileRoute("/app/settings/credits")({
  validateSearch: z.object({
    checkout_id: z.string().optional(),
    page: z.coerce.number().int().positive().optional(),
  }),
  component: CreditsComponent,
});
/* eslint-enable perfectionist/sort-objects */

function CreditsComponent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const currentPage = search.page ?? 1;

  // Polling state for post-checkout balance sync.
  const checkoutId = search.checkout_id;
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isPolling, setIsPolling] = useState(!!checkoutId);
  const [balanceSnapshot, setBalanceSnapshot] = useState<number | null>(null);
  const [redirectingProductId, setRedirectingProductId] = useState<string | null>(null);

  // User-scoped balance + history. No organizationId.
  const balanceQuery = useSuspenseQuery(trpc.credits.getBalance.queryOptions(undefined));
  const topUpsQuery = useSuspenseQuery(trpc.credits.listTopUps.queryOptions({ page: currentPage, pageSize: 20 }));
  const chargesQuery = useSuspenseQuery(trpc.credits.listCharges.queryOptions({ page: currentPage, pageSize: 20 }));

  const handlePageChange = (newPage: number) => {
    void navigate({ replace: true, search: { page: newPage } });
  };

  const handleTopUp = (productId: string) => {
    // Polar-native checkout via the `@polar-sh/better-auth` plugin endpoint.
    // Plugin auto-binds the Polar customer to `session.user.id` and returns
    // a Polar checkout URL. We navigate the browser there.
    setRedirectingProductId(productId);
    auth
      .checkout({ products: [productId] })
      .then((res) => {
        const url = res?.data?.url;
        if (url) window.location.assign(url);
      })
      .catch(() => {
        setRedirectingProductId(null);
      });
  };

  // Balance polling after Polar checkout redirect.
  useEffect(() => {
    if (!checkoutId) return;

    setIsPolling(true);
    setBalanceSnapshot(balanceQuery.data.available);

    pollTimerRef.current = setInterval(() => {
      queryClient.invalidateQueries(trpc.credits.getBalance.queryOptions(undefined)).catch(() => {});
    }, POLL_INTERVAL_MS);

    pollTimeoutRef.current = setTimeout(() => {
      clearPolling();
      void navigate({ replace: true, search: { page: currentPage } });
    }, POLL_TIMEOUT_MS);

    return clearPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutId]);

  // Detect balance change while polling -> stop + clean URL.
  useEffect(() => {
    if (!isPolling || balanceSnapshot === null) return;
    if (balanceQuery.data.available > balanceSnapshot) {
      clearPolling();
      setIsPolling(false);
      void navigate({ replace: true, search: { page: currentPage } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balanceQuery.data.available, isPolling, balanceSnapshot]);

  function clearPolling() {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }

  const currentBalance = useMemo(() => {
    const credits = balanceQuery.data.available;
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(credits);
  }, [balanceQuery.data.available]);

  const hasTopUpProducts = POLAR_TOPUP_PRODUCTS.length > 0;

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl flex-1 space-y-6 p-6">
      <h1 className="text-2xl font-bold text-foreground">Credits</h1>

      {isPolling && (
        <Card className="w-full border-primary/30 bg-primary/5 backdrop-blur-sm">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <div>
              <p className="text-sm font-medium text-foreground">Processing top-up…</p>
              <p className="text-[11px] text-muted-foreground">
                Waiting for Polar to confirm your payment. This may take a few seconds.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

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
          {hasTopUpProducts ? (
            <div className="flex flex-wrap gap-3">
              {POLAR_TOPUP_PRODUCTS.map((product) => (
                <Button
                  className="flex-1"
                  disabled={redirectingProductId === product.id}
                  key={product.id}
                  onClick={() => handleTopUp(product.id)}
                  size="lg"
                >
                  {redirectingProductId === product.id
                    ? "Redirecting..."
                    : `${product.label} (${product.units} credits)`}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Top-up products are not configured. Set <code>VITE_PUBLIC_POLAR_TOPUP_PRODUCTS</code> in your environment.
            </p>
          )}
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
                <span className="text-sm text-muted-foreground">{new Date(tx.createdAt).toLocaleString()}</span>
                <span className="text-sm font-medium text-primary">+${(tx.amountCents / 100).toFixed(2)}</span>
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
                key={`${tx.requestId ?? "noid"}-${String(tx.createdAt)}`}
              >
                <span className="text-sm text-muted-foreground">{new Date(tx.createdAt).toLocaleString()}</span>
                <span className="text-sm font-medium text-destructive">-{tx.costUnits} credits</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Pager */}
      {(topUpsQuery.data.hasNext || chargesQuery.data.hasNext) && (
        <div className="flex justify-center gap-2">
          <Button disabled={currentPage <= 1} onClick={() => handlePageChange(currentPage - 1)} variant="outline">
            Previous
          </Button>
          <Button
            disabled={!topUpsQuery.data.hasNext && !chargesQuery.data.hasNext}
            onClick={() => handlePageChange(currentPage + 1)}
            variant="outline"
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
