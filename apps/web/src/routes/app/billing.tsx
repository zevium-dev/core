import { useOrganization } from "@clerk/tanstack-react-start";
import { convexQuery } from "@convex-dev/react-query";
import { useMutation, useQueries } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useAction, useConvexAuth } from "convex/react";
import { ChartNoAxesColumn, CreditCard, Wallet } from "lucide-react";
import { useState } from "react";
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import { Skeleton } from "#/components/ui/skeleton";
import { api } from "#/lib/convex-api";
import {
  formatCredits,
  formatCycleMonthLabel,
  isCycleEmpty,
  truncateKeyId,
} from "#/lib/billing-cycle";
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

  const orgSlug =
    organization && typeof organization.slug === "string"
      ? organization.slug
      : null;

  if (!organization || !orgSlug) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Select an organization to manage credits.
        </p>
      </div>
    );
  }

  return <BillingContent checkoutSessionId={checkout} orgSlug={orgSlug} />;
}

function BillingContent({
  checkoutSessionId,
  orgSlug,
}: {
  checkoutSessionId?: string;
  orgSlug: string;
}) {
  const { membership } = useOrganization();
  const canManageBilling = membership?.role === "org:admin";
  const [billingQuery, cycleQuery] = useQueries({
    queries: [
      convexQuery(api.billing.getBillingState, { checkoutSessionId }),
      convexQuery(api.billing.cycleBreakdown, { orgSlug }),
    ],
  });
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

  if (billingQuery.isPending || cycleQuery.isPending) {
    return <BillingSkeleton />;
  }

  if (
    billingQuery.isError ||
    cycleQuery.isError ||
    billingQuery.data === undefined ||
    cycleQuery.data === undefined
  ) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>Billing did not load</CardTitle>
          <CardDescription>
            Check your connection, then retry. No billing state was changed.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void billingQuery.refetch();
              void cycleQuery.refetch();
            }}
          >
            Retry billing
          </Button>
        </CardFooter>
      </Card>
    );
  }

  const billing = billingQuery.data;
  const cycle = cycleQuery.data;

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
            <p
              className="text-xl font-semibold tabular-nums"
              style={{ viewTransitionName: "credit-balance" }}
            >
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

      <CycleUsage cycle={cycle} />

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Buy credits</h2>
          <p className="text-sm text-muted-foreground">
            $1 = 10,000 credits. One-time packs at one fixed exchange rate.
          </p>
        </div>
        {!canManageBilling ? (
          <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            Organization admins buy credits. Every member can review wallet
            usage and attribution below.
          </p>
        ) : null}
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
                    {formatCredits(pack.credits)}
                    <span className="ml-1 text-sm font-normal text-muted-foreground">
                      credits
                    </span>
                  </CardTitle>
                  <CardDescription>{price} one-time purchase</CardDescription>
                </CardHeader>
                <CardFooter>
                  <Button
                    className="w-full"
                    disabled={!canManageBilling || button.disabled}
                    onClick={() => buyPack(pack.packId)}
                  >
                    {canManageBilling ? button.label : "Admin only"}
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
                        {formatCredits(payment.credits)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(payment.createdAt)}
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
                          {formatCredits(payment.credits)}
                        </td>
                        <td className="px-2 py-2.5 whitespace-nowrap text-muted-foreground">
                          {formatDateTime(payment.createdAt)}
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

type CycleUsageData = {
  cycleStart: number;
  cycleEnd: number;
  asOf: number;
  totalCalls: number;
  totalCredits: number;
  projectedCredits: number;
  byProject: Array<{
    projectId: string;
    name: string;
    slug: string;
    calls: number;
    credits: number;
  }>;
  byKey: Array<{
    keyId: string;
    keyName: string;
    ownerUserId: string | null;
    calls: number;
    credits: number;
  }>;
  byMember: Array<{
    userId: string | null;
    name: string;
    email: string | null;
    calls: number;
    credits: number;
  }>;
  byEndpoint: Array<{
    projectId: string;
    projectName: string;
    projectSlug: string;
    method: string;
    endpoint: string;
    calls: number;
    credits: number;
  }>;
};

function CycleUsage({ cycle }: { cycle: CycleUsageData }) {
  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <ChartNoAxesColumn className="size-4" aria-hidden="true" />
            Current usage cycle
          </CardTitle>
          <CardDescription>
            {formatCycleMonthLabel(cycle.cycleStart)} · ends{" "}
            {formatDateTime(cycle.cycleEnd)}
          </CardDescription>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/app/settings/activity" search={{}}>
            Inspect calls
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border bg-muted/20 p-4">
            <p className="text-xs text-muted-foreground">Calls</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {formatCredits(cycle.totalCalls)}
            </p>
          </div>
          <div className="rounded-lg border bg-muted/20 p-4">
            <p className="text-xs text-muted-foreground">Projected spend</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {formatCredits(cycle.projectedCredits)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Month-end estimate from usage through {formatDateTime(cycle.asOf)}
            </p>
          </div>
          <div className="rounded-lg border bg-muted/20 p-4">
            <p className="text-xs text-muted-foreground">Credits spent</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {formatCredits(cycle.totalCredits)}
            </p>
          </div>
        </div>

        {isCycleEmpty(cycle) ? (
          <Empty className="border border-dashed py-8">
            <EmptyHeader>
              <EmptyTitle>No metered calls this cycle</EmptyTitle>
              <EmptyDescription>
                Keyless mock calls cost zero and do not appear in billing usage.
                Live calls will break down by API and key here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            <UsageBreakdownTable
              title="By member"
              rows={cycle.byMember.map((row) => ({
                id: row.userId ?? "unattributed",
                label: row.name,
                detail: row.email ?? "Legacy usage without member metadata",
                calls: row.calls,
                credits: row.credits,
                search: row.userId ? { member: row.userId } : undefined,
              }))}
            />
            <UsageBreakdownTable
              title="By key"
              rows={cycle.byKey.map((row) => ({
                id: row.keyId,
                label: row.keyName,
                detail: truncateKeyId(row.keyId),
                calls: row.calls,
                credits: row.credits,
                search: { key: row.keyId },
              }))}
            />
            <UsageBreakdownTable
              title="By API"
              rows={cycle.byProject.map((row) => ({
                id: row.projectId,
                label: row.name,
                detail: row.slug,
                calls: row.calls,
                credits: row.credits,
                search: { project: row.projectId },
              }))}
            />
            <UsageBreakdownTable
              title="By endpoint"
              rows={cycle.byEndpoint.map((row) => ({
                id: `${row.projectId}:${row.method}:${row.endpoint}`,
                label: row.projectName,
                detail: `${row.method.toUpperCase()} ${row.endpoint}`,
                calls: row.calls,
                credits: row.credits,
                search: {
                  project: row.projectId,
                  endpoint: row.endpoint,
                  method: row.method,
                },
              }))}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UsageBreakdownTable({
  title,
  rows,
}: {
  title: string;
  rows: Array<{
    id: string;
    label: string;
    detail: string;
    calls: number;
    credits: number;
    search?: {
      project?: string;
      key?: string;
      member?: string;
      endpoint?: string;
      method?: string;
    };
  }>;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No breakdown available.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[22rem] text-left text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Name
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Calls
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Credits
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b last:border-0">
                  <th scope="row" className="px-3 py-2 font-medium">
                    {row.search ? (
                      <Link
                        to="/app/settings/activity"
                        search={row.search}
                        className="link-draw inline-block"
                      >
                        {row.label}
                      </Link>
                    ) : (
                      <span className="block">{row.label}</span>
                    )}
                    <span className="block font-mono text-xs font-normal text-muted-foreground">
                      {row.detail}
                    </span>
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatCredits(row.calls)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatCredits(row.credits)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

function formatDateTime(timestamp: number): string {
  return DATE_TIME_FORMATTER.format(timestamp);
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
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
