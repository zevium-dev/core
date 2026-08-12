import {
  OrganizationList,
  OrganizationProfile,
  useOrganization,
} from "@clerk/tanstack-react-start";
import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useAction } from "convex/react";
import { Building2, Landmark, Plus, Users } from "lucide-react";
import { useEffect, useState } from "react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
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
import { clerkShadcnTheme } from "#/lib/clerk-theme";
import { humanError } from "#/lib/human-error";
import { isPrivilegedOrgRole } from "#/lib/org-capabilities";
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
            className="min-w-0 text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]"
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
            <Badge variant="secondary" className="max-w-64 font-mono text-xs">
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

      <PublicHandleCard />
      <PublisherPaymentsCard />

      <div className="min-h-[28rem] w-full overflow-hidden rounded-xl">
        <OrganizationProfile
          routing="hash"
          appearance={{
            theme: clerkShadcnTheme,
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

function PublicHandleCard() {
  const { membership } = useOrganization();
  const mine = useQuery(convexQuery(api.organizations.listMine, {}));
  const setPublicHandle = useConvexMutation(api.organizations.setPublicHandle);
  const current = mine.data?.[0]?.publisherHandle ?? "";
  const handleLocked = mine.data?.[0]?.publicHandleLocked ?? false;
  const [handle, setHandle] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setHandle(current);
  }, [current]);

  const normalized = handle.trim().toLowerCase();
  const valid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized);
  const changed = normalized !== current;
  const lookup = useQuery({
    ...convexQuery(api.organizations.checkPublicHandleAvailability, {
      handle: normalized,
    }),
    enabled: valid && changed && !handleLocked && !mine.isPending,
  });
  const unavailable = lookup.data?.available === false;
  const availabilityConfirmed = lookup.data?.available === true;
  const checking = lookup.isPending && valid && changed;
  const isAdmin = isPrivilegedOrgRole(membership?.role);
  const { mutate: save, isPending } = useMutation({
    mutationFn: () => setPublicHandle({ handle: normalized }),
    onSuccess: () => {
      setConfirming(false);
      void mine.refetch();
    },
    onError: (error: unknown) => {
      toast.error(humanError(error, "Could not update public handle"));
    },
  });

  async function copyPublicUrl() {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/catalogue/${current}`,
      );
      toast.success("Public catalogue URL copied");
    } catch {
      toast.error("Could not copy public catalogue URL");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Public publisher handle</CardTitle>
        <CardDescription>
          This stable handle appears in catalogue, gateway, mock, and MCP URLs.
          Clerk organization slugs are internal identity values and never form
          public URLs.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Label htmlFor="public-handle">Handle</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id="public-handle"
            name="public-handle"
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="public-handle-help"
            aria-invalid={normalized !== "" && (!valid || unavailable)}
            aria-busy={checking}
            readOnly={!isAdmin || handleLocked || mine.isPending}
          />
          <Button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={
              !isAdmin ||
              mine.isPending ||
              handleLocked ||
              isPending ||
              !changed ||
              !valid ||
              lookup.isError ||
              !availabilityConfirmed
            }
          >
            Save handle
          </Button>
        </div>
        {handleLocked ? (
          <p className="text-sm text-muted-foreground">
            Permanent after first publication. Existing API URLs stay stable.
          </p>
        ) : !isAdmin ? (
          <p className="text-sm text-muted-foreground">
            An organization admin can change this public handle.
          </p>
        ) : null}
        {current ? (
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-xs text-muted-foreground">
              /catalogue/{current}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void copyPublicUrl()}
            >
              Copy public URL
            </Button>
            <span className="text-xs text-muted-foreground">
              Shared by gateway, mock, discovery, and MCP routes.
            </span>
          </div>
        ) : null}
        <p
          id="public-handle-help"
          role="status"
          aria-live="polite"
          className="text-sm text-muted-foreground"
        >
          {normalized === ""
            ? "Choose lowercase letters, numbers, and single hyphens."
            : !valid
              ? "Use lowercase letters, numbers, and single hyphens."
              : !changed
                ? "This is the current public handle."
                : checking
                  ? "Checking availability…"
                  : lookup.isError
                    ? "Could not check availability. Edit the handle to retry."
                    : unavailable
                      ? "This handle is already taken."
                      : availabilityConfirmed
                        ? "This handle is available."
                        : "Enter a new handle to check availability."}
        </p>
      </CardContent>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change public publisher handle?</DialogTitle>
            <DialogDescription>
              Future catalogue, gateway, mock, and MCP URLs will use this
              handle. It becomes permanent when you publish your first API.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirming(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => save()}
              disabled={isPending || !availabilityConfirmed}
            >
              {isPending ? "Saving…" : "Change handle"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function PublisherPaymentsCard() {
  const { membership } = useOrganization();
  const isAdmin = isPrivilegedOrgRole(membership?.role);
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

  if (payoutState.isPending) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-9 w-44" />
        </CardContent>
      </Card>
    );
  }

  if (payoutState.isError || !payoutState.data) {
    return (
      <Card role="alert">
        <CardHeader>
          <CardTitle>Publisher payout status did not load</CardTitle>
          <CardDescription>
            Check your connection, then retry. No payout settings were changed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            variant="outline"
            onClick={() => void payoutState.refetch()}
          >
            Retry payout status
          </Button>
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
          <Landmark aria-hidden="true" className="size-3.5" />
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
        {!isAdmin ? (
          <p className="text-sm text-muted-foreground">
            An organization admin manages Stripe onboarding and payout details.
          </p>
        ) : display.action && display.actionLabel ? (
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
          appearance={{ theme: clerkShadcnTheme }}
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
