import {
  OrganizationList,
  OrganizationProfile,
  useOrganization,
} from "@clerk/tanstack-react-start";
import { shadcn } from "@clerk/ui/themes";
import { convexQuery } from "@convex-dev/react-query";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useAction } from "convex/react";
import { Building2, Landmark, Plus, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { FadeIn } from "#/components/motion/fade-in";
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
import { Skeleton } from "#/components/ui/skeleton";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { api } from "#/lib/convex-api";
import { humanError } from "#/lib/human-error";
import { connectedAccountDisplay } from "#/lib/stripe-ui";

export const Route = createFileRoute("/app/org/")({
  component: OrgHomePage,
  head: () => ({
    meta: [{ title: "Organization · Zevium" }],
  }),
  pendingComponent: OrgHomeSkeleton,
});

function OrgHomePage() {
  const { organization, isLoaded } = useOrganization();

  if (!isLoaded) {
    return <OrgHomeSkeleton />;
  }

  if (!organization) {
    return <NoActiveOrg />;
  }

  const slug = typeof organization.slug === "string" ? organization.slug : null;
  const membersCount =
    typeof organization.membersCount === "number"
      ? organization.membersCount
      : null;

  return (
    <FadeIn className="flex flex-col gap-6">
      <div className="min-w-0 space-y-3">
        <div className="min-w-0 space-y-1">
          <h1
            className="truncate text-2xl font-semibold tracking-tight"
            style={
              slug ? { viewTransitionName: `org-name-${slug}` } : undefined
            }
          >
            {organization.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            Members, invitations, and organization settings.
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap gap-2">
          {slug ? (
            <Badge
              variant="secondary"
              className="max-w-64 font-mono text-xs"
            >
              <span className="truncate">{slug}</span>
            </Badge>
          ) : null}
          {membersCount !== null ? (
            <Badge variant="outline">
              <Users />
              {membersCount} {membersCount === 1 ? "member" : "members"}
            </Badge>
          ) : null}
        </div>
      </div>

      <PublisherPaymentsCard />

      <div className="min-h-[28rem] w-full overflow-hidden rounded-xl">
        <OrganizationProfile
          routing="hash"
          appearance={{
            theme: shadcn,
            elements: {
              rootBox: "w-full!",
              cardBox: "w-full! max-w-none!",
              card: "w-full! max-w-none!",
            },
          }}
          afterLeaveOrganizationUrl="/app/org"
        />
      </div>
    </FadeIn>
  );
}

function PublisherPaymentsCard() {
  const [publisherCountry, setPublisherCountry] = useState("");
  const payoutState = useQuery(convexQuery(api.payouts.getPayoutState, {}));
  const startOnboarding = useAction(api.payouts.startOnboarding);
  const { mutate: openOnboarding, isPending } = useMutation({
    mutationFn: () =>
      startOnboarding({
        country:
          payoutState.data?.profile.status === "not_started"
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

  if (payoutState.isPending || !payoutState.data) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-4 w-80" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-9 w-44" />
        </CardContent>
      </Card>
    );
  }

  const { profile } = payoutState.data;
  const display = connectedAccountDisplay(
    profile.status,
    profile.disabledReason,
    profile.requirements,
  );

  return (
    <Card>
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          <Landmark className="size-3.5" />
          Publisher payouts
        </CardDescription>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-lg">{display.title}</CardTitle>
          <Badge variant={display.variant}>
            {profile.status.replaceAll("_", " ")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{display.description}</p>
        {profile.requirements.length > 0 ? (
          <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
            {profile.requirements.map((requirement) => (
              <li key={requirement}>{requirement}</li>
            ))}
          </ul>
        ) : null}
        {display.action && display.actionLabel ? (
          <div className="space-y-3">
            {profile.status === "not_started" ? (
              <div className="max-w-xs space-y-2">
                <Label htmlFor="org-publisher-country">Publisher country</Label>
                <Input
                  id="org-publisher-country"
                  maxLength={2}
                  placeholder="US"
                  value={publisherCountry}
                  onChange={(event) => setPublisherCountry(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Two-letter ISO country code for the publisher legal entity.
                </p>
              </div>
            ) : null}
            <Button
              disabled={
                isPending ||
                (profile.status === "not_started" &&
                  !/^[A-Za-z]{2}$/.test(publisherCountry.trim()))
              }
              onClick={() => openOnboarding()}
            >
              {isPending ? "Opening Stripe…" : display.actionLabel}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function NoActiveOrg() {
  return (
    <FadeIn className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Organization</h1>
        <p className="text-sm text-muted-foreground">
          Select an organization or create one to continue.
        </p>
      </div>

      <Empty className="min-h-80 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Building2 />
          </EmptyMedia>
          <EmptyTitle>No active organization</EmptyTitle>
          <EmptyDescription>
            Wallet, projects, and API keys are org-scoped. Pick an org below or
            create a new one.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link to="/app/org/create">
              <Plus data-icon="inline-start" />
              Create organization
            </Link>
          </Button>
        </EmptyContent>
      </Empty>

      <div className="flex justify-center">
        <OrganizationList
          appearance={{ theme: shadcn }}
          hidePersonal={false}
          afterSelectOrganizationUrl="/app/org"
          afterCreateOrganizationUrl="/app"
          afterSelectPersonalUrl="/app/org"
        />
      </div>
    </FadeIn>
  );
}

function OrgHomeSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-14 w-24 rounded-lg" />
      </div>
      <Skeleton className="h-[28rem] w-full rounded-xl" />
    </div>
  );
}
