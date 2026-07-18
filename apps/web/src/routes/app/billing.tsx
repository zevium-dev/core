import { useOrganization } from "@clerk/tanstack-react-start";
import { convexQuery } from "@convex-dev/react-query";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useAction, useConvexAuth } from "convex/react";
import { CreditCard, Wallet } from "lucide-react";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { NumberTicker } from "#/components/motion/number-ticker";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
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
import { api } from "#/lib/convex-api";
import { humanError } from "#/lib/human-error";
import {
  checkoutDisplay,
  checkoutPackButton,
  checkoutStartFailureMessage,
  checkoutStateFromStatus,
  paymentStatusLabel,
  paymentStatusVariant,
} from "#/lib/stripe-ui";

type BillingSearch = {
  checkout?: string;
};
type PackId = "pack_10" | "pack_50" | "pack_100";

export const Route = createFileRoute("/app/billing")({
  validateSearch: (search: Record<string, unknown>): BillingSearch => {
    const checkout = search.checkout;
    return typeof checkout === "string" && checkout.trim().length > 0
      ? { checkout: checkout.trim() }
      : {};
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
  const { checkout } = Route.useSearch();

  if (!isLoaded || convexAuthLoading || !isAuthenticated) {
    return <BillingSkeleton />;
  }

  if (!organization) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Select an organization to manage credits.
        </p>
      </div>
    );
  }

  return (
    <Suspense fallback={<BillingSkeleton />}>
      <BillingContent checkoutSessionId={checkout} />
    </Suspense>
  );
}

function BillingContent({ checkoutSessionId }: { checkoutSessionId?: string }) {
  const { data: billing } = useSuspenseQuery(
    convexQuery(api.billing.getBillingState, { checkoutSessionId }),
  );
  const createCheckout = useAction(api.billing.createCheckout);
  const [checkoutPackId, setCheckoutPackId] = useState<string | null>(null);

  const { mutate: buyPack, isPending: checkoutPending } = useMutation({
    mutationFn: async (packId: PackId) => {
      setCheckoutPackId(packId);
      return await createCheckout({ packId });
    },
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
    onError: (error: unknown) => {
      setCheckoutPackId(null);
      toast.error(
        checkoutStartFailureMessage(
          humanError(error, "Could not start secure checkout."),
        ),
      );
    },
  });

  const checkoutState = billing.checkout
    ? checkoutStateFromStatus(billing.checkout.status)
    : null;
  const checkoutNotice = checkoutState ? checkoutDisplay(checkoutState) : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
          <p className="text-sm text-muted-foreground">
            Buy prepaid credits and review payment history.
          </p>
        </div>
        <div className="flex w-full items-center gap-3 rounded-lg border bg-card px-4 py-3 sm:w-auto">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
            <Wallet
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Wallet balance</p>
            <p className="text-xl font-semibold tabular-nums">
              <NumberTicker value={billing.wallet.balance} />
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                credits
              </span>
            </p>
          </div>
        </div>
      </div>

      {checkoutNotice ? (
        <Card
          aria-live="polite"
          className={
            checkoutState === "failed" ? "border-destructive/40" : undefined
          }
        >
          <CardHeader className="gap-2">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base">
                {checkoutNotice.title}
              </CardTitle>
              <Badge variant={checkoutNotice.variant}>
                {checkoutState === "succeeded"
                  ? "Confirmed"
                  : checkoutState === "failed"
                    ? "Not completed"
                    : "Processing"}
              </Badge>
            </div>
            <CardDescription>{checkoutNotice.description}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Buy credits</h2>
          <p className="text-sm text-muted-foreground">
            $1 = 10,000 credits. One-time packs; larger packs include bonus
            credits.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {billing.packs.map((pack) => {
            const price = formatMoney(pack.priceCents, "USD");
            const button = checkoutPackButton(
              pack.packId,
              checkoutPackId,
              checkoutPending,
              price,
            );
            return (
              <Card
                key={pack.packId}
                className="transition-[translate,box-shadow] duration-[var(--dur-instant)] ease-[var(--ease)] hover:-translate-y-0.5 hover:shadow-sm motion-reduce:transition-none motion-reduce:hover:translate-y-0"
              >
                <CardHeader>
                  <CardTitle className="text-xl tabular-nums">
                    {pack.credits.toLocaleString()}
                    <span className="ml-1 text-sm font-normal text-muted-foreground">
                      credits
                    </span>
                  </CardTitle>
                  <CardDescription>{price} one-time purchase</CardDescription>
                  {pack.bonusCredits > 0 ? (
                    <CardAction>
                      <Badge variant="secondary">
                        +{pack.bonusCredits.toLocaleString()} bonus
                      </Badge>
                    </CardAction>
                  ) : null}
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  {pack.bonusCredits > 0
                    ? `${pack.baseCredits.toLocaleString()} purchased credits`
                    : "No bonus credits"}
                </CardContent>
                <CardFooter>
                  <Button
                    className="w-full"
                    disabled={button.disabled}
                    onClick={() => buyPack(pack.packId)}
                  >
                    {button.label}
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="size-4" aria-hidden="true" />
            Payment history
          </CardTitle>
          <CardDescription>
            Stripe payment status and credits added to this wallet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {billing.payments.length === 0 ? (
            <Empty className="py-8 md:py-10">
              <EmptyHeader>
                <EmptyTitle>No payments yet</EmptyTitle>
                <EmptyDescription>
                  Completed credit purchases and their Stripe status appear
                  here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <div className="divide-y sm:hidden">
                {billing.payments.map((payment) => (
                  <div key={payment.id} className="space-y-3 py-4 first:pt-0">
                    <div className="flex items-center justify-between gap-3">
                      <Badge variant={paymentStatusVariant(payment.status)}>
                        {paymentStatusLabel(payment.status)}
                      </Badge>
                      <span className="font-medium tabular-nums">
                        {formatMoney(payment.amount, payment.currency)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-3 text-sm">
                      <span className="text-muted-foreground">
                        Credits added
                      </span>
                      <span className="tabular-nums">
                        {payment.credits.toLocaleString()}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {new Date(payment.createdAt).toLocaleString()}
                    </p>
                    {payment.failureReason ? (
                      <p className="text-sm text-destructive">
                        {payment.failureReason}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th scope="col" className="px-2 py-2 font-medium">
                        Status
                      </th>
                      <th
                        scope="col"
                        className="px-2 py-2 font-medium text-right"
                      >
                        Amount
                      </th>
                      <th
                        scope="col"
                        className="px-2 py-2 font-medium text-right"
                      >
                        Credits
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        Date
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        Details
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {billing.payments.map((payment) => (
                      <tr key={payment.id} className="border-b last:border-0">
                        <td className="px-2 py-2.5">
                          <Badge variant={paymentStatusVariant(payment.status)}>
                            {paymentStatusLabel(payment.status)}
                          </Badge>
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums">
                          {formatMoney(payment.amount, payment.currency)}
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums">
                          {payment.credits.toLocaleString()}
                        </td>
                        <td className="px-2 py-2.5 whitespace-nowrap text-muted-foreground">
                          {new Date(payment.createdAt).toLocaleString()}
                        </td>
                        <td className="max-w-64 truncate px-2 py-2.5 text-muted-foreground">
                          {payment.failureReason ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

function BillingSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-64" />
      </div>
      <Skeleton className="h-20 rounded-xl" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
