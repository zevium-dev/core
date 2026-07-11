import { useOrganization } from "@clerk/tanstack-react-start";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import {
  BookOpen,
  CheckCircle2,
  Circle,
  KeyRound,
  PhoneCall,
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
import { Skeleton } from "#/components/ui/skeleton";
import { listKeys } from "#/lib/api-keys";
import { api } from "#/lib/convex-api";
import { deriveOnboardingFlags, shouldShowOnboarding } from "#/lib/onboarding";

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

  const keyCount = keysQuery.data?.length ?? 0;
  const keysLoaded = !keysQuery.isPending;
  const flags = deriveOnboardingFlags({
    keyCount,
    callsCycle: overview.callsCycle,
    balance: wallet.balance,
  });
  const showOnboarding = shouldShowOnboarding({ keysLoaded, flags });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Wallet, recent calls, and quick actions.
        </p>
      </div>

      {showOnboarding ? (
        <OnboardingChecklist
          hasKey={flags.hasKey}
          hasCall={flags.hasCall}
          hasTopUp={flags.hasTopUp}
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              <Wallet className="size-3.5" />
              Wallet balance
            </CardDescription>
            <CardTitle
              className="text-3xl tabular-nums"
              style={{ viewTransitionName: "credit-balance" }}
            >
              <NumberTicker value={overview.balance} />
              <span className="ml-2 text-base font-normal text-muted-foreground">
                credits
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Live org wallet. Zero balance blocks every call.
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              <PhoneCall className="size-3.5" />
              Calls this cycle
            </CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              <NumberTicker value={overview.callsCycle} />
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {overview.creditsCycle.toLocaleString()} credits spent ·{" "}
            {overview.callsToday.toLocaleString()} today
            {overview.truncated ? (
              <span className="mt-1 block text-xs">
                Scan capped at {overview.scanCap.toLocaleString()} events —
                totals may undercount.
              </span>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Projected spend</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              <NumberTicker value={overview.projectedCycleSpend} />
              <span className="ml-2 text-base font-normal text-muted-foreground">
                credits
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Linear projection from cycle-to-date (UTC calendar month).
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick actions</CardTitle>
          <CardDescription>Top up, manage keys, or browse APIs</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/app/billing">Top up</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/app/settings/keys">Keys</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/catalogue">
              <BookOpen className="size-4" />
              Browse
            </Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent calls</CardTitle>
          <CardDescription>Latest metered gateway activity</CardDescription>
        </CardHeader>
        <CardContent>
          {overview.recent.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed px-6 py-12 text-center">
              <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                <PhoneCall className="size-5 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">No calls yet</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Create a key, top up, then hit the gateway. Usage lands here
                  live.
                </p>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link to="/catalogue">Browse catalogue</Link>
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-2 py-2 font-medium">When</th>
                    <th className="px-2 py-2 font-medium">API</th>
                    <th className="px-2 py-2 font-medium">Endpoint</th>
                    <th className="px-2 py-2 font-medium">Status</th>
                    <th className="px-2 py-2 font-medium text-right">
                      Credits
                    </th>
                    <th className="px-2 py-2 font-medium text-right">
                      Latency
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overview.recent.map((event) => (
                    <tr key={event._id} className="border-b last:border-0">
                      <td className="whitespace-nowrap px-2 py-2.5 text-muted-foreground">
                        {new Date(event.at).toLocaleString()}
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
                        {event.credits.toLocaleString()}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                        {event.latencyMs}ms
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
  const steps = [
    {
      done: hasKey,
      title: "Get an API key",
      body: "One key per user. Copy it once — you won't see it again.",
      href: "/app/settings/keys" as const,
      cta: "Create key",
      icon: KeyRound,
    },
    {
      done: hasCall,
      title: "Make your first call",
      body: "Browse the catalogue and hit a free-tier or paid endpoint.",
      href: "/catalogue" as const,
      cta: "Browse APIs",
      icon: PhoneCall,
    },
    {
      done: hasTopUp,
      title: "Top up credits",
      body: "Prepaid org wallet. Zero balance blocks every call.",
      href: "/app/billing" as const,
      cta: "Top up",
      icon: Wallet,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Get started</CardTitle>
        <CardDescription>
          Key → first call → top up. Time-to-first-call under a minute.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {steps.map((step) => {
          const Icon = step.icon;
          return (
            <div
              key={step.title}
              className="flex items-start gap-3 rounded-md border px-3 py-3"
            >
              {step.done ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
              ) : (
                <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <Icon className="size-3.5 text-muted-foreground" />
                  <p className="text-sm font-medium">{step.title}</p>
                </div>
                <p className="text-sm text-muted-foreground">{step.body}</p>
              </div>
              {!step.done ? (
                <Button asChild size="sm" variant="outline">
                  <Link to={step.href}>{step.cta}</Link>
                </Button>
              ) : (
                <Badge variant="secondary">Done</Badge>
              )}
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

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-36 rounded-xl" />
        <Skeleton className="h-36 rounded-xl" />
        <Skeleton className="h-36 rounded-xl" />
      </div>
      <Skeleton className="h-24 rounded-xl" />
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-9 w-9 rounded-md" />
              <div className="flex-1 space-y-1.5">
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
