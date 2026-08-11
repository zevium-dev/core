import { useOrganization } from "@clerk/tanstack-react-start";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import {
  CheckCircle2,
  Circle,
  KeyRound,
  PhoneCall,
  TestTube2,
  Wallet,
} from "lucide-react";
import { Suspense } from "react";

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
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Separator } from "#/components/ui/separator";
import { Skeleton } from "#/components/ui/skeleton";
import { listKeys } from "#/lib/api-keys";
import { api } from "#/lib/convex-api";
import {
  deriveOnboardingFlags,
  nextOnboardingStep,
  shouldShowOnboarding,
} from "#/lib/onboarding";

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

export const Route = createFileRoute("/app/")({
  component: DashboardPage,
  head: () => ({
    meta: [{ title: "Dashboard · Zevium" }],
  }),
  pendingComponent: DashboardSkeleton,
});

function DashboardPage() {
  const { organization, isLoaded } = useOrganization();
  const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
  const orgSlug =
    organization && typeof organization.slug === "string"
      ? organization.slug
      : null;

  if (!isLoaded || convexAuthLoading) {
    return <DashboardSkeleton />;
  }

  if (!orgSlug) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Select an organization to see wallet and usage.
        </p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <DashboardSkeleton />;
  }

  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardContent orgSlug={orgSlug} />
    </Suspense>
  );
}

function DashboardContent({ orgSlug }: { orgSlug: string }) {
  const { data: overview } = useSuspenseQuery(
    convexQuery(api.analytics.orgOverview, { orgSlug }),
  );

  const { data: wallet } = useSuspenseQuery(
    convexQuery(api.wallets.getMyWallet, { orgSlug }),
  );

  const keysQuery = useQuery({
    queryKey: ["settings", "api-keys", "count"] as const,
    queryFn: () => listKeys(),
    staleTime: 30_000,
  });

  const keyCount = keysQuery.data?.filter((key) => key.current).length ?? 0;
  const keysLoaded = !keysQuery.isPending;
  const flags = deriveOnboardingFlags({
    keyCount,
    callsCycle: overview.callsCycle,
    balance: wallet.balance,
  });
  const showOnboarding = shouldShowOnboarding({ keysLoaded, flags });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Wallet balance and metered usage for this organization.
          </p>
        </div>
        {keysLoaded && !showOnboarding ? (
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to="/app/billing">Top up</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/app/settings/keys">Manage keys</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/catalogue">Browse APIs</Link>
            </Button>
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Wallet balance</CardTitle>
            <CardDescription>Zero balance blocks new calls.</CardDescription>
          </CardHeader>
          <CardContent>
            <p
              className="text-3xl font-semibold tabular-nums"
              style={{ viewTransitionName: "credit-balance" }}
            >
              <NumberTicker value={wallet.balance} />
              <span className="ml-2 text-base font-normal text-muted-foreground">
                credits
              </span>
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Calls this cycle</CardTitle>
            <CardDescription>
              {formatNumber(overview.creditsCycle)} credits spent ·{" "}
              {formatNumber(overview.callsToday)} today
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums">
              <NumberTicker value={overview.callsCycle} />
            </p>
            {overview.truncated ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Scan capped at {formatNumber(overview.scanCap)} events — totals
                may undercount.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Projected spend</CardTitle>
            <CardDescription>Based on month-to-date usage.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums">
              <NumberTicker value={overview.projectedCycleSpend} />
              <span className="ml-2 text-base font-normal text-muted-foreground">
                credits
              </span>
            </p>
          </CardContent>
        </Card>
      </div>

      {keysQuery.isPending ? (
        <OnboardingSkeleton />
      ) : showOnboarding ? (
        <OnboardingChecklist
          hasKey={flags.hasKey}
          hasCall={flags.hasCall}
          hasTopUp={flags.hasTopUp}
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Recent calls</CardTitle>
          <CardDescription>Latest metered gateway activity</CardDescription>
        </CardHeader>
        <CardContent>
          {overview.recent.length === 0 ? (
            <Empty className="py-8 md:py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PhoneCall />
                </EmptyMedia>
                <EmptyTitle>No calls yet</EmptyTitle>
                <EmptyDescription>
                  Create a key, top up, then hit the gateway. Usage lands here
                  live.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild variant="outline" size="sm">
                  <Link to="/catalogue">Browse catalogue</Link>
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <>
              <div className="flex flex-col sm:hidden">
                {overview.recent.map((event, index) => (
                  <div key={event._id}>
                    <div className="flex flex-col gap-3 py-4 first:pt-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium">
                            {event.projectName ?? event.projectSlug ?? "—"}
                          </p>
                          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                            {event.method} {event.endpoint}
                          </p>
                        </div>
                        <StatusBadge status={event.status} />
                      </div>
                      <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>{formatDateTime(event.at)}</span>
                        <span className="tabular-nums">
                          {formatNumber(event.credits)} credits ·{" "}
                          {formatLatency(event.latencyMs)}
                        </span>
                      </div>
                    </div>
                    {index < overview.recent.length - 1 ? <Separator /> : null}
                  </div>
                ))}
              </div>
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th scope="col" className="px-2 py-2 font-medium">
                        When
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        API
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        Endpoint
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        Status
                      </th>
                      <th
                        scope="col"
                        className="px-2 py-2 font-medium text-right"
                      >
                        Credits
                      </th>
                      <th
                        scope="col"
                        className="px-2 py-2 font-medium text-right"
                      >
                        Latency
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.recent.map((event) => (
                      <tr key={event._id} className="border-b last:border-0">
                        <td className="whitespace-nowrap px-2 py-2.5 text-muted-foreground">
                          {formatDateTime(event.at)}
                        </td>
                        <td className="px-2 py-2.5">
                          {event.projectName ?? event.projectSlug ?? "—"}
                        </td>
                        <td className="px-2 py-2.5 font-mono text-xs">
                          <span className="text-muted-foreground">
                            {event.method}
                          </span>{" "}
                          {event.endpoint}
                        </td>
                        <td className="px-2 py-2.5">
                          <StatusBadge status={event.status} />
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums">
                          {formatNumber(event.credits)}
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                          {formatLatency(event.latencyMs)}
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

function OnboardingChecklist({
  hasKey,
  hasCall,
  hasTopUp,
}: {
  hasKey: boolean;
  hasCall: boolean;
  hasTopUp: boolean;
}) {
  const nextStep = nextOnboardingStep({ hasKey, hasCall, hasTopUp });
  const steps = [
    {
      id: "key" as const,
      done: hasKey,
      title: "Get an API key",
      body: "One key per user. Copy it once — you won't see it again.",
      href: "/app/settings/keys" as const,
      cta: "Create key",
      icon: KeyRound,
    },
    {
      id: "topup" as const,
      done: hasTopUp,
      title: "Top up credits",
      body: "Prepaid org wallet. Zero balance blocks every call.",
      href: "/app/billing" as const,
      cta: "Top up",
      icon: Wallet,
    },
    {
      id: "call" as const,
      done: hasCall,
      title: "Send your first live call",
      body: "Return to your chosen operation and confirm its exact published cost.",
      href: "/catalogue" as const,
      cta: "Choose API",
      icon: PhoneCall,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Get started</h2>
        </CardTitle>
        <CardDescription>
          Validate requests free, then create key → add credits → send live.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <TestTube2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Try an API without a key</p>
              <p className="text-sm text-muted-foreground">
                Mock mode generates a response from the published schema. Zero
                credits and no upstream execution.
              </p>
            </div>
          </div>
          <Button asChild size="sm" className="w-full shrink-0 sm:w-auto">
            <Link to="/catalogue">Browse free mocks</Link>
          </Button>
        </div>
        <Separator />
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <div key={step.title}>
              <div
                className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start"
                aria-current={step.id === nextStep ? "step" : undefined}
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  {step.done ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                  ) : (
                    <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <Icon className="size-3.5 text-muted-foreground" />
                      <p className="text-sm font-medium">{step.title}</p>
                    </div>
                    <p className="text-sm text-muted-foreground">{step.body}</p>
                  </div>
                </div>
                {!step.done && step.id === nextStep ? (
                  <Button asChild size="sm" className="w-full sm:w-auto">
                    <Link to={step.href}>{step.cta}</Link>
                  </Button>
                ) : step.done ? (
                  <Badge variant="secondary" className="self-start">
                    Done
                  </Badge>
                ) : (
                  <Badge variant="outline" className="self-start">
                    Later
                  </Badge>
                )}
              </div>
              {index < steps.length - 1 ? <Separator /> : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: number }) {
  if (status >= 200 && status < 400) {
    return <Badge variant="secondary">{status}</Badge>;
  }
  if (status >= 400 && status < 500) {
    return <Badge variant="outline">{status}</Badge>;
  }
  return <Badge variant="destructive">{status}</Badge>;
}

function OnboardingSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i}>
            <div className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <Skeleton className="size-4 shrink-0 rounded-full" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-36 max-w-full" />
                  <Skeleton className="h-3 w-80 max-w-full" />
                </div>
              </div>
              <Skeleton className="h-8 w-full sm:w-24" />
            </div>
            {i < 2 ? <Separator /> : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-36 rounded-xl" />
        <Skeleton className="h-36 rounded-xl" />
        <Skeleton className="h-36 rounded-xl" />
      </div>
      <OnboardingSkeleton />
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-9 w-9 rounded-md" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              <Skeleton className="h-4 w-12" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function formatNumber(value: number): string {
  return NUMBER_FORMATTER.format(value);
}

function formatDateTime(timestamp: number): string {
  return DATE_TIME_FORMATTER.format(new Date(timestamp));
}

function formatLatency(latencyMs: number): string {
  return `${formatNumber(latencyMs)}\u00A0ms`;
}
