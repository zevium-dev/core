import {
  OrganizationList,
  OrganizationProfile,
  useOrganization,
} from "@clerk/tanstack-react-start";
import { shadcn } from "@clerk/ui/themes";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Building2, Plus } from "lucide-react";

import { FadeIn } from "#/components/motion/fade-in";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Skeleton } from "#/components/ui/skeleton";

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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1
              className="truncate text-2xl font-semibold tracking-tight"
              style={
                slug ? { viewTransitionName: `org-name-${slug}` } : undefined
              }
            >
              {organization.name}
            </h1>
            {slug ? (
              <Badge variant="secondary" className="font-mono text-xs">
                {slug}
              </Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            Members, invitations, and organization settings.
          </p>
        </div>
        {membersCount !== null ? (
          <div className="rounded-lg border bg-card px-3 py-2 text-sm">
            <span className="text-muted-foreground">Members</span>
            <p className="text-lg font-semibold tabular-nums leading-none">
              {membersCount}
            </p>
          </div>
        ) : null}
      </div>

      <div className="min-h-[28rem] w-full overflow-hidden rounded-xl border bg-card">
        <OrganizationProfile
          routing="hash"
          appearance={{ theme: shadcn }}
          afterLeaveOrganizationUrl="/app/org"
        />
      </div>
    </FadeIn>
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

      <Card className="border-dashed">
        <CardHeader className="items-center py-10 text-center">
          <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-muted">
            <Building2 className="size-5 text-muted-foreground" />
          </div>
          <CardTitle>No active organization</CardTitle>
          <CardDescription className="max-w-sm">
            Wallet, projects, and API keys are org-scoped. Pick an org below or
            create a new one.
          </CardDescription>
        </CardHeader>
        <CardFooter className="justify-center pb-8">
          <Button asChild>
            <Link to="/app/org/create">
              <Plus />
              Create organization
            </Link>
          </Button>
        </CardFooter>
      </Card>

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
