import { useOrganization } from "@clerk/tanstack-react-start";
import { convexQuery } from "@convex-dev/react-query";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useAction, useConvexAuth } from "convex/react";
import { Banknote, Landmark, Send, Wallet } from "lucide-react";
import { Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { NumberTicker } from "#/components/motion/number-ticker";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
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
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { api } from "#/lib/convex-api";
import { humanError } from "#/lib/human-error";
import { formatCreditsAsUsd } from "#/lib/project-helpers";
import {
  connectedAccountDisplay,
  earningStatusLabel,
  earningStatusVariant,
  moneyMovementFailure,
  moneyMovementStatusLabel,
  moneyMovementStatusVariant,
} from "#/lib/stripe-ui";

type ConnectedPayout = {
  id: string;
  status: "pending" | "paid" | "failed" | "canceled";
  amount: number;
  currency: string;
  failureCode?: string;
  arrivalDate?: number;
  updatedAt: number;
};

type EarningsSearch = {
  onboarding?: "refresh" | "return";
};

export const Route = createFileRoute("/app/earnings")({
  validateSearch: (search: Record<string, unknown>): EarningsSearch => {
    const onboarding = search.onboarding;
    return onboarding === "refresh" || onboarding === "return"
      ? { onboarding }
      : {};
  },
  component: EarningsPage,
  head: () => ({
    meta: [{ title: "Earnings · Zevium" }],
  }),
  pendingComponent: EarningsPageSkeleton,
});

function EarningsPage() {
  const { organization, membership, isLoaded } = useOrganization();
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();

  if (!isLoaded || convexAuthLoading || !isAuthenticated) {
    return <EarningsPageSkeleton />;
  }

  if (!organization) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Earnings</h1>
        <p className="text-sm text-muted-foreground">
          Select an organization to view publisher earnings.
        </p>
      </div>
    );
  }

  return (
    <Suspense fallback={<EarningsPageSkeleton />}>
      <EarningsContent
        canManagePayouts={
          String(membership?.role) === "org:admin" ||
          String(membership?.role) === "org:owner"
        }
      />
    </Suspense>
  );
}

function EarningsContent({ canManagePayouts }: { canManagePayouts: boolean }) {
  const { onboarding } = Route.useSearch();
  const refreshStarted = useRef(false);
  const [publisherCountry, setPublisherCountry] = useState("");
  const { data: payoutState } = useSuspenseQuery(
    convexQuery(api.payouts.getPayoutState, {}),
  );
  const startOnboarding = useAction(api.payouts.startOnboarding);
  const { mutate: openOnboarding, isPending: onboardingPending } = useMutation({
    mutationFn: () =>
      startOnboarding({
        country:
          profile.status === "not_started"
            ? publisherCountry.trim().toUpperCase()
            : undefined,
      }),
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
    onError: (error: unknown) => {
      toast.error(humanError(error, "Could not open Stripe onboarding."));
    },
  });
  const { profile, earnings, payouts, transfers } = payoutState;
  useEffect(() => {
    if (!canManagePayouts || onboarding !== "refresh" || refreshStarted.current)
      return;
    refreshStarted.current = true;
    openOnboarding();
  }, [canManagePayouts, onboarding, openOnboarding]);
  const initiatePublisherTransfer = useAction(
    api.payouts.initiatePublisherTransfer,
  );
  const { mutate: initiateTransfer, isPending: transferPending } = useMutation({
    mutationFn: () => initiatePublisherTransfer({}),
    onSuccess: () => {
      toast.success("Publisher transfer submitted to Stripe.");
    },
    onError: (error: unknown) => {
      toast.error(humanError(error, "Could not submit publisher transfer."));
    },
  });
  const connect = connectedAccountDisplay(
    profile.status,
    profile.disabledReason,
    profile.requirements,
  );
  const canTransfer = profile.status === "enabled" && earnings.canTransfer;
  const transferLabel =
    earnings.available <= 0
      ? "Nothing to transfer"
      : !earnings.canTransfer
        ? `${earnings.minimumPayoutCredits.toLocaleString()} credit minimum`
        : "Transfer available earnings";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Earnings</h1>
        <p className="text-sm text-muted-foreground">
          Track your 95% publisher share from successful call to bank payout.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardDescription className="flex items-center gap-2">
            <Landmark className="size-3.5" />
            Stripe Connect
          </CardDescription>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-lg">{connect.title}</CardTitle>
            <Badge variant={connect.variant}>
              {profile.status.replaceAll("_", " ")}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{connect.description}</p>
          {profile.requirements.length > 0 ? (
            <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
              {profile.requirements.map((requirement) => (
                <li key={requirement}>{requirement}</li>
              ))}
            </ul>
          ) : null}
          {canManagePayouts && connect.action && connect.actionLabel ? (
            <div className="space-y-3">
              {profile.status === "not_started" ? (
                <div className="max-w-xs space-y-2">
                  <Label htmlFor="publisher-country">Publisher country</Label>
                  <Input
                    id="publisher-country"
                    name="publisher-country"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={2}
                    placeholder="US"
                    value={publisherCountry}
                    onChange={(event) =>
                      setPublisherCountry(event.target.value)
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Two-letter ISO country code for the publisher legal entity.
                  </p>
                </div>
              ) : null}
              <Button
                disabled={
                  onboardingPending ||
                  (profile.status === "not_started" &&
                    !/^[A-Za-z]{2}$/.test(publisherCountry.trim()))
                }
                onClick={() => openOnboarding()}
              >
                {onboardingPending ? "Opening Stripe…" : connect.actionLabel}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              Earnings lifecycle
            </h2>
            <p className="text-sm text-muted-foreground">
              Your share after Zevium&apos;s 5% fee.
            </p>
          </div>
          {canManagePayouts && profile.status === "enabled" ? (
            <Button
              disabled={transferPending || !canTransfer}
              onClick={() => initiateTransfer()}
            >
              {transferPending ? "Submitting transfer…" : transferLabel}
            </Button>
          ) : null}
        </div>
        <Card>
          <CardContent className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
            <EarningTotal
              label="Pending review"
              value={earnings.pendingRisk}
              description="Held during risk review."
            />
            <EarningTotal
              label="Available"
              value={earnings.available}
              description="Ready to transfer."
            />
            <EarningTotal
              label="Transferring"
              value={earnings.allocated}
              description="Submitted to Stripe."
            />
            <EarningTotal
              label="Stripe balance"
              value={earnings.transferred}
              description="Delivered to connected account."
            />
          </CardContent>
        </Card>
        {earnings.available > 0 && !earnings.canTransfer ? (
          <p className="text-sm text-muted-foreground">
            {(
              earnings.minimumPayoutCredits - earnings.available
            ).toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
            more credits needed to reach the $10 payout minimum. Every
            fractional credit stays in your balance.
          </p>
        ) : null}
        {earnings.available < 0 ? (
          <p className="text-sm text-destructive">
            Refund or dispute reversals exceed current available earnings by{" "}
            {Math.abs(earnings.available).toLocaleString(undefined, {
              maximumFractionDigits: 2,
            })}{" "}
            credits. Future earnings clear this balance before another transfer.
          </p>
        ) : null}
        {earnings.failed > 0 ? (
          <p className="text-sm text-destructive">
            {earnings.failed.toLocaleString()} credits need transfer review. See
            transfer history for the safe failure reason.
          </p>
        ) : null}
        {earnings.reversed > 0 ? (
          <p className="text-sm text-destructive">
            {earnings.reversed.toLocaleString()} credits were reversed. Review
            ledger for affected earnings.
          </p>
        ) : null}
      </section>

      <EarningsLedgerCard rows={earnings.rows} />

      <div className="grid gap-4 xl:grid-cols-2">
        <TransferHistoryCard transfers={transfers} />
        <PayoutHistoryCard payouts={payouts} />
      </div>
    </div>
  );
}

function EarningTotal({
  label,
  value,
  description,
}: {
  label: string;
  value: number;
  description: string;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">
        <NumberTicker value={value} decimals={2} />
        <span className="ml-1 text-sm font-normal text-muted-foreground">
          credits
        </span>
      </p>
      <p className="text-xs text-muted-foreground">
        ≈ {formatCreditsAsUsd(value)} · {description}
      </p>
    </div>
  );
}

function EarningsLedgerCard({
  rows,
}: {
  rows: {
    id: string;
    status:
      | "pending_risk"
      | "available"
      | "allocated_to_transfer"
      | "transferred"
      | "reversed"
      | "failed";
    grossCredits: number;
    platformFeeCredits: number;
    netCredits: number;
    clawedBackCredits: number;
    availableAt: number;
    createdAt: number;
  }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="size-4" />
          Earnings ledger
        </CardTitle>
        <CardDescription>
          Each completed usage settlement creates one immutable earning.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <HistoryEmpty
            title="No earnings yet"
            description="Publish a project and serve a successful paid call. Its settlement will appear here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="px-2 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium text-right">
                    Gross
                  </th>
                  <th
                    scope="col"
                    className="hidden px-2 py-2 text-right font-medium sm:table-cell"
                  >
                    Fee
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium text-right">
                    Net
                  </th>
                  <th
                    scope="col"
                    className="hidden px-2 py-2 text-right font-medium md:table-cell"
                  >
                    Reversed
                  </th>
                  <th
                    scope="col"
                    className="hidden px-2 py-2 font-medium md:table-cell"
                  >
                    Available
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((earning) => (
                  <tr key={earning.id} className="border-b last:border-0">
                    <td className="px-2 py-2.5">
                      <Badge variant={earningStatusVariant(earning.status)}>
                        {earningStatusLabel(earning.status)}
                      </Badge>
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {earning.grossCredits.toLocaleString()}
                    </td>
                    <td className="hidden px-2 py-2.5 text-right tabular-nums text-muted-foreground sm:table-cell">
                      {earning.platformFeeCredits.toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      })}
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {earning.netCredits.toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      })}
                    </td>
                    <td className="hidden px-2 py-2.5 text-right tabular-nums text-muted-foreground md:table-cell">
                      {earning.clawedBackCredits.toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      })}
                    </td>
                    <td className="hidden px-2 py-2.5 whitespace-nowrap text-muted-foreground md:table-cell">
                      {new Date(earning.availableAt).toLocaleDateString()}
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

function TransferHistoryCard({
  transfers,
}: {
  transfers: {
    id: string;
    status: "created" | "pending" | "succeeded" | "failed" | "reversed";
    amount: number;
    currency: string;
    failureReason?: string;
    stripeTransferId?: string;
    createdAt: number;
    updatedAt: number;
  }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="size-4" />
          Transfer history
        </CardTitle>
        <CardDescription>
          Platform-to-connected-account Stripe transfers.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {transfers.length === 0 ? (
          <HistoryEmpty
            title="No transfers yet"
            description="Transfers from available earnings to your connected Stripe balance appear here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="px-2 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium text-right">
                    Amount
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Created
                  </th>
                  <th
                    scope="col"
                    className="hidden px-2 py-2 font-medium md:table-cell"
                  >
                    Details
                  </th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((transfer) => {
                  const failure = moneyMovementFailure(
                    transfer.status,
                    transfer.failureReason,
                  );
                  return (
                    <tr key={transfer.id} className="border-b last:border-0">
                      <td className="px-2 py-2.5">
                        <Badge
                          variant={moneyMovementStatusVariant(transfer.status)}
                        >
                          {moneyMovementStatusLabel(transfer.status)}
                        </Badge>
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums">
                        {formatMoney(transfer.amount, transfer.currency)}
                      </td>
                      <td className="px-2 py-2.5 whitespace-nowrap text-muted-foreground">
                        {new Date(transfer.createdAt).toLocaleDateString()}
                      </td>
                      <td className="hidden max-w-56 truncate px-2 py-2.5 text-muted-foreground md:table-cell">
                        {failure ?? transfer.stripeTransferId ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PayoutHistoryCard({ payouts }: { payouts: ConnectedPayout[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Banknote className="size-4" />
          Bank payout history
        </CardTitle>
        <CardDescription>
          Payouts from the connected account to the bank account held by Stripe.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {payouts.length === 0 ? (
          <HistoryEmpty
            title="No bank payouts yet"
            description="Stripe payouts from your connected balance to your bank account appear here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="px-2 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium text-right">
                    Amount
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Arrival
                  </th>
                  <th
                    scope="col"
                    className="hidden px-2 py-2 font-medium sm:table-cell"
                  >
                    Details
                  </th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((payout) => {
                  const failure = moneyMovementFailure(
                    payout.status,
                    payout.failureCode,
                  );
                  return (
                    <tr key={payout.id} className="border-b last:border-0">
                      <td className="px-2 py-2.5">
                        <Badge
                          variant={moneyMovementStatusVariant(payout.status)}
                        >
                          {moneyMovementStatusLabel(payout.status)}
                        </Badge>
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums">
                        {formatMoney(payout.amount, payout.currency)}
                      </td>
                      <td className="px-2 py-2.5 whitespace-nowrap text-muted-foreground">
                        {payout.arrivalDate
                          ? new Date(payout.arrivalDate).toLocaleDateString()
                          : "—"}
                      </td>
                      <td className="hidden max-w-56 truncate px-2 py-2.5 text-muted-foreground sm:table-cell">
                        {failure ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HistoryEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Empty className="py-6 md:py-8">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

function EarningsPageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-44 rounded-xl" />
      <Skeleton className="h-36 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}
