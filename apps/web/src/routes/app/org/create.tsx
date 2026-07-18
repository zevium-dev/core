import { CreateOrganization } from "@clerk/tanstack-react-start";
import { shadcn } from "@clerk/ui/themes";
import { createFileRoute } from "@tanstack/react-router";

import { FadeIn } from "#/components/motion/fade-in";
import { Skeleton } from "#/components/ui/skeleton";

export const Route = createFileRoute("/app/org/create")({
  component: CreateOrgPage,
  head: () => ({
    meta: [{ title: "Create organization · Zevium" }],
  }),
  pendingComponent: CreateOrgSkeleton,
});

function CreateOrgPage() {
  return (
    <FadeIn className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Create organization
        </h1>
        <p className="text-sm text-muted-foreground">
          Name, slug, and logo. You become the owner.
        </p>
      </div>

      <div className="flex min-h-[22rem] justify-center">
        <CreateOrganization
          appearance={{ theme: shadcn }}
          afterCreateOrganizationUrl="/app"
          routing="hash"
        />
      </div>
    </FadeIn>
  );
}

function CreateOrgSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="flex justify-center">
        <Skeleton className="h-[22rem] w-full max-w-md rounded-xl" />
      </div>
    </div>
  );
}
