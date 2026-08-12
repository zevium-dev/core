import { useOrganization } from "@clerk/tanstack-react-start";
import { convexQuery } from "@convex-dev/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";

import { SpecWorkspace } from "#/components/spec-editor/spec-workspace";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader } from "#/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import { Skeleton } from "#/components/ui/skeleton";
import { api } from "#/lib/convex-api";
import type { Id } from "#/lib/convex-data-model";

import { isPrivilegedOrgRole } from "#/lib/org-capabilities";
import type { RouterContext } from "#/router";

export const Route = createFileRoute("/app/projects/$projectSlug/spec")({
  loader: async ({ context, params }) => {
    const { queryClient, orgSlug } = context as RouterContext;
    if (!orgSlug) return;

    const projectQuery = convexQuery(api.projects.get, {
      orgSlug,
      projectSlug: params.projectSlug,
    });

    // Client nav: fire-and-forget project fetch; draft/versions need project id
    // so component queries handle those after project resolves.
    if (typeof window !== "undefined") {
      void queryClient.prefetchQuery(projectQuery);
      return;
    }

    try {
      const project = await queryClient.ensureQueryData(projectQuery);
      if (project) {
        await Promise.all([
          queryClient.ensureQueryData(
            convexQuery(api.specs.getDraft, { projectId: project._id }),
          ),
          queryClient.ensureQueryData(
            convexQuery(api.specs.listVersions, { projectId: project._id }),
          ),
        ]);
      }
    } catch {
      // component handles missing org / not found
    }
  },
  component: SpecEditorPage,
  head: ({ params }) => ({
    meta: [{ title: `Spec · ${params.projectSlug} · Zevium` }],
  }),
  pendingComponent: SpecEditorSkeleton,
});

function SpecEditorPage() {
  const { projectSlug } = Route.useParams();
  const { organization, membership, isLoaded } = useOrganization();
  const orgSlug =
    organization && typeof organization.slug === "string"
      ? organization.slug
      : null;

  if (!isLoaded) {
    return <SpecEditorSkeleton />;
  }

  if (!orgSlug) {
    return (
      <Empty className="min-h-80 flex-none border">
        <EmptyHeader>
          <EmptyTitle>No active organization</EmptyTitle>
          <EmptyDescription>
            Select an organization before editing a project spec.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Suspense fallback={<SpecEditorSkeleton />}>
      <SpecEditor
        orgSlug={orgSlug}
        projectSlug={projectSlug}

        canAdminister={isPrivilegedOrgRole(membership?.role)}
      />
    </Suspense>
  );
}

function SpecEditor({
  orgSlug,
  projectSlug,
  canAdminister,
}: {
  orgSlug: string;
  projectSlug: string;
  canAdminister: boolean;
}) {
  const { data: project } = useSuspenseQuery(
    convexQuery(api.projects.get, { orgSlug, projectSlug }),
  );

  if (project === null) {
    return (
      <Empty className="min-h-80 flex-none border">
        <EmptyHeader>
          <EmptyTitle>Project not found</EmptyTitle>
          <EmptyDescription>
            This project does not exist in the active organization.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline">
            <Link to="/app/projects">Back to projects</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <Suspense fallback={<SpecEditorSkeleton />}>
      <SpecEditorInner
        projectId={project._id}
        orgSlug={orgSlug}
        projectSlug={projectSlug}
        visibility={project.visibility}
        description={project.description}
        canAdminister={canAdminister}
      />
    </Suspense>
  );
}

function SpecEditorInner({
  projectId,
  orgSlug,
  projectSlug,
  visibility,
  description,
  canAdminister,
}: {
  projectId: Id<"projects">;
  orgSlug: string;
  projectSlug: string;
  visibility: "public" | "private";
  description: string | undefined;
  canAdminister: boolean;
}) {
  const { data: draftRow } = useSuspenseQuery(
    convexQuery(api.specs.getDraft, { projectId }),
  );
  const { data: versions } = useSuspenseQuery(
    convexQuery(api.specs.listVersions, { projectId }),
  );

  return (
    <SpecWorkspace
      projectId={projectId}
      orgSlug={orgSlug}
      projectSlug={projectSlug}
      visibility={visibility}
      description={description}
      canAdminister={canAdminister}
      savedDraft={draftRow?.draft ?? ""}
      savedDraftHash={draftRow?.draftHash ?? null}
      lastSavedAt={draftRow?.lastSavedAt ?? null}
      versions={versions.map((v) => ({
        _id: v._id,
        version: v.version,
        publishedAt: v.publishedAt,
        deprecatedAt: v.deprecatedAt,
        sunsetAt: v.sunsetAt,
        deprecationMessage: v.deprecationMessage,
      }))}
    />
  );
}

function SpecEditorSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="space-y-3">
        <div className="flex justify-between">
          <Skeleton className="h-6 w-40" />
          <div className="flex gap-2">
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-24" />
          </div>
        </div>
        <Skeleton className="min-h-[28rem] w-full" />
      </div>
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-4 w-40" />
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-24" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-4 w-full" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-24" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-4 w-full" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
