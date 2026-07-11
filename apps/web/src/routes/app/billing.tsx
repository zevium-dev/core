import { useOrganization } from "@clerk/tanstack-react-start";
import {
  convexQuery,
  useConvexMutation,
} from "@convex-dev/react-query";
import {
  useMutation,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useAction, useConvexAuth } from "convex/react";
import { CreditCard, Sparkles, Wallet } from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
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
import { Skeleton } from "#/components/ui/skeleton";
import { api } from "#/lib/convex-api";
import { humanError } from "#/lib/human-error";

type BillingSearch = {
  success?: string;
};

export const Route = createFileRoute("/app/billing")({
  validateSearch: (search: Record<string, unknown>): BillingSearch => {
    const raw = search.success;
    if (raw === "1" || raw === "true" || raw === true || raw === 1) {
      return { success: "1" };
    }
    return {};
  },
  component: BillingPage,
  head: () => ({
    meta: [{ title: "Billing · Zevium" }],
  }),
  pendingComponent: BillingSkeleton,
});

function BillingPage() {
  const { organization, isLoaded } = useOrganization();
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
  const orgSlug =
    organization && typeof organization.slug === "string"
      ? organization.slug
      : null;

  if (!isLoaded || convexAuthLoading) {
    return <BillingSkeleton />;
  }

  if (!orgSlug) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Select an organization to manage credits.
        </p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <BillingSkeleton />;
  }

  return (
    <Suspense fallback={<BillingSkeleton />}>
      <BillingContent orgSlug={orgSlug} />
    </Suspense>
  );
}

function BillingContent({ orgSlug }: { orgSlug: string }) {
  const search = Route.useSearch();
  const success = search.success === "1";

  const { data: wallet } = useSuspenseQuery(
    convexQuery(api.wallets.getMyWallet, { orgSlug }),
  );

  const ensureWallet = useConvexMutation(api.wallets.ensureWallet);
  const createCheckout = useAction(api.billing.createCheckout);

  const packsQuery = useSuspenseQuery(
    convexQuery(api.billing.listPacksStatic, {}),
  );
  const packs = packsQuery.data;

  const [checkoutPackId, setCheckoutPackId] = useState<string | null>(null);

  // Ensure wallet row exists so grants land cleanly.
  useEffect(() => {
    void ensureWallet({ orgSlug }).catch(() => {
      // Non-fatal; grant path also creates wallet.
    });
  }, [ensureWallet, orgSlug]);

  useEffect(() => {
    if (success) {
      toast.success("Payment received. Credits land when Polar confirms.");
    }
  }, [success]);

  const { mutate: buyPack, isPending: buyPending } = useMutation({
    mutationFn: async (packId: "pack_10" | "pack_50" | "pack_100") => {
      setCheckoutPackId(packId);
      return await createCheckout({ orgSlug, packId });
    },
    onSuccess: (result) => {
      window.location.href = result.url;
    },
    onError: (err: unknown) => {
      setCheckoutPackId(null);
      toast.error(humanError(err, "Could not start checkout."));
    },
  });

  const grants = useMemo(
    () => wallet.entries.filter((e) => e.kind === "grant"),
    [wallet.entries],
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Org wallet balance, credit packs, and ledger.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              <Wallet className="size-3.5" />
              Wallet balance
            </CardDescription>
            <CardTitle className="text-3xl">
              <NumberTicker value={wallet.balance} />
              <span className="ml-2 text-base font-normal text-muted-foreground">
                credits
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            $1 = 10,000 credits. Zero balance blocks every call.
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              <Sparkles className="size-3.5" />
              Usage this cycle
            </CardDescription>
            <CardTitle className="text-xl">Coming soon</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Projected spend and per-key / per-endpoint breakdown land with the
            usage rollup cron.
          </CardContent>
        </Card>
      </div>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Buy credits</h2>
          <p className="text-sm text-muted-foreground">
            One-time packs via Polar checkout. Larger packs include a bonus.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {packs.map((pack) => {
            const price = (pack.priceCents / 100).toLocaleString(undefined, {
              style: "currency",
              currency: "USD",
              maximumFractionDigits: 0,
            });
            const pending = buyPending && checkoutPackId === pack.packId;
            return (
              <Card
                key={pack.packId}
                className="transition-[transform,box-shadow] duration-[var(--dur-instant)] ease-[var(--ease)] hover:-translate-y-0.5 hover:shadow-sm"
              >
                <CardHeader>
                  <CardDescription>{price}</CardDescription>
                  <CardTitle className="text-xl tabular-nums">
                    {pack.credits.toLocaleString()}{" "}
                    <span className="text-sm font-normal text-muted-foreground">
                      credits
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  {pack.bonusCredits > 0 ? (
                    <span>
                      {pack.baseCredits.toLocaleString()} base +{" "}
                      {pack.bonusCredits.toLocaleString()} bonus
                    </span>
                  ) : (
                    <span>{pack.description}</span>
                  )}
                </CardContent>
                <CardFooter>
                  <Button
                    className="w-full"
                    disabled={buyPending}
                    onClick={() =>
                      buyPack(
                        pack.packId as "pack_10" | "pack_50" | "pack_100",
                      )
                    }
                  >
                    {pending ? "Redirecting…" : `Buy ${price}`}
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CreditCard className="size-4" />
              Top-up history
            </CardTitle>
            <CardDescription>Credit grants from checkout</CardDescription>
          </CardHeader>
          <CardContent>
            {grants.length === 0 ? (
              <p className="text-sm text-muted-foreground">No top-ups yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {grants.map((entry) => (
                  <li
                    key={entry._id}
                    className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="font-medium tabular-nums">
                        +{entry.amount.toLocaleString()} credits
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {new Date(entry.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <Badge variant="secondary">grant</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ledger</CardTitle>
            <CardDescription>Recent wallet entries</CardDescription>
          </CardHeader>
          <CardContent>
            {wallet.entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Ledger empty. Top up or make a call.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {wallet.entries.map((entry) => (
                  <li
                    key={entry._id}
                    className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="font-medium tabular-nums">
                        {entry.kind === "settle" ? "−" : "+"}
                        {entry.amount.toLocaleString()}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {entry.refId}
                      </div>
                    </div>
                    <KindBadge kind={entry.kind} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function KindBadge({ kind }: { kind: "grant" | "settle" | "refund_note" }) {
  if (kind === "grant") {
    return <Badge variant="secondary">grant</Badge>;
  }
  if (kind === "settle") {
    return <Badge variant="outline">settle</Badge>;
  }
  return <Badge variant="ghost">refund</Badge>;
}

function BillingSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-36 rounded-xl" />
        <Skeleton className="h-36 rounded-xl lg:col-span-2" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    </div>
  );
}
