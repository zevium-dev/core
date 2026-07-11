import { useOrganization } from "@clerk/tanstack-react-start";
import {
  convexQuery,
  useConvexMutation,
} from "@convex-dev/react-query";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

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
  DialogTrigger,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Skeleton } from "#/components/ui/skeleton";
import { getAuthOrg } from "#/lib/auth-session";
import { api } from "#/lib/convex-api";
import type { Id } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";
import {
  formatPricingSummary,
  summarizeDraftPricing,
} from "#/lib/spec-pricing";
import type { RouterContext } from "#/router";

type SpecIssue = {
  level: "error" | "warning";
  path: string;
  message: string;
};

export const Route = createFileRoute("/app/projects/$projectSlug/spec")({
  loader: async ({ context, params }) => {
    const { queryClient } = context as RouterContext;
    try {
      const session = await getAuthOrg();
      if (!session.orgSlug) return;
      const project = await queryClient.ensureQueryData(
        convexQuery(api.projects.get, {
          orgSlug: session.orgSlug,
          projectSlug: params.projectSlug,
        }),
      );
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
  const { organization, isLoaded } = useOrganization();
  const orgSlug =
    organization && typeof organization.slug === "string"
      ? organization.slug
      : null;

  if (!isLoaded) {
    return <SpecEditorSkeleton />;
  }

  if (!orgSlug) {
    return (
      <p className="text-sm text-muted-foreground">
        Select an organization to edit this spec.
      </p>
    );
  }

  return (
    <Suspense fallback={<SpecEditorSkeleton />}>
      <SpecEditor orgSlug={orgSlug} projectSlug={projectSlug} />
    </Suspense>
  );
}

function SpecEditor({
  orgSlug,
  projectSlug,
}: {
  orgSlug: string;
  projectSlug: string;
}) {
  const { data: project } = useSuspenseQuery(
    convexQuery(api.projects.get, { orgSlug, projectSlug }),
  );

  if (project === null) {
    return (
      <p className="text-sm text-muted-foreground">Project not found.</p>
    );
  }

  return (
    <Suspense fallback={<SpecEditorSkeleton />}>
      <SpecEditorInner
        projectId={project._id}
        orgSlug={orgSlug}
        projectSlug={projectSlug}
      />
    </Suspense>
  );
}

function SpecEditorInner({
  projectId,
  orgSlug,
  projectSlug,
}: {
  projectId: Id<"projects">;
  orgSlug: string;
  projectSlug: string;
}) {
  const queryClient = useQueryClient();
  const { data: draftRow } = useSuspenseQuery(
    convexQuery(api.specs.getDraft, { projectId }),
  );
  const { data: versions } = useSuspenseQuery(
    convexQuery(api.specs.listVersions, { projectId }),
  );

  const savedDraft = draftRow?.draft ?? "";
  const [text, setText] = useState(savedDraft);
  const [issues, setIssues] = useState<SpecIssue[]>([]);
  const [publishOpen, setPublishOpen] = useState(false);
  const [version, setVersion] = useState(() =>
    defaultNextVersion(versions.map((v) => v.version)),
  );

  useEffect(() => {
    setText(savedDraft);
  }, [savedDraft]);

  useEffect(() => {
    setVersion(defaultNextVersion(versions.map((v) => v.version)));
  }, [versions]);

  const dirty = text !== savedDraft;
  const pricing = useMemo(() => summarizeDraftPricing(text), [text]);

  const saveDraftFn = useConvexMutation(api.specs.saveDraft);
  const publishFn = useConvexMutation(api.specs.publish);

  const { mutate: saveDraft, isPending: savePending } = useMutation({
    mutationFn: () => saveDraftFn({ projectId, spec: text }),
    onSuccess: async (result) => {
      setIssues(result.issues);
      if (!result.ok) {
        toast.error("Draft has errors — fix issues before saving");
        return;
      }
      toast.success("Draft saved");
      await queryClient.invalidateQueries({
        queryKey: convexQuery(api.specs.getDraft, { projectId }).queryKey,
      });
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not save draft"));
    },
  });

  const { mutate: publish, isPending: publishPending } = useMutation({
    mutationFn: () =>
      publishFn({
        projectId,
        version: version.trim(),
      }),
    onSuccess: async (result) => {
      setIssues(result.issues);
      if (!result.ok) {
        const first = result.issues.find((i) => i.level === "error");
        toast.error(first?.message ?? "Publish failed — check issues");
        return;
      }
      toast.success(`Published v${result.version?.version ?? version}`);
      setPublishOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: convexQuery(api.specs.listVersions, { projectId }).queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: convexQuery(api.projects.get, { orgSlug, projectSlug })
            .queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: convexQuery(api.projects.list, { orgSlug }).queryKey,
        }),
      ]);
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not publish"));
    },
  });

  const errorCount = issues.filter((i) => i.level === "error").length;
  const warningCount = issues.filter((i) => i.level === "warning").length;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {pricing ? (
              <Badge variant="secondary">{formatPricingSummary(pricing)}</Badge>
            ) : (
              <Badge variant="outline">Invalid JSON</Badge>
            )}
            {dirty ? (
              <span className="text-xs text-muted-foreground">Unsaved</span>
            ) : (
              <span className="text-xs text-muted-foreground">Saved</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              disabled={!dirty || savePending}
              onClick={() => saveDraft()}
            >
              {savePending ? "Saving…" : "Save draft"}
            </Button>
            <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
              <DialogTrigger asChild>
                <Button disabled={dirty || savePending}>Publish</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Publish version</DialogTitle>
                  <DialogDescription>
                    Published versions are immutable. Use semver (e.g. 0.1.0).
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-2 py-2">
                  <Label htmlFor="semver">Version</Label>
                  <Input
                    id="semver"
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    placeholder="0.1.0"
                    className="font-mono"
                    disabled={publishPending}
                  />
                </div>
                <DialogFooter>
                  <Button
                    variant="ghost"
                    onClick={() => setPublishOpen(false)}
                    disabled={publishPending}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => publish()}
                    disabled={publishPending || version.trim() === ""}
                  >
                    {publishPending ? "Publishing…" : "Publish"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          className="min-h-[28rem] w-full resize-y rounded-md border border-input bg-transparent p-3 font-mono text-xs leading-relaxed shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          placeholder={`{\n  "openapi": "3.1.0",\n  "info": { "title": "My API", "version": "0.1.0" },\n  "servers": [{ "url": "https://api.example.com" }],\n  "paths": {}\n}`}
        />
      </div>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">Issues</CardTitle>
              {issues.length > 0 ? (
                <Badge variant={errorCount > 0 ? "destructive" : "secondary"}>
                  {errorCount > 0
                    ? `${errorCount} error${errorCount === 1 ? "" : "s"}`
                    : `${warningCount} warning${warningCount === 1 ? "" : "s"}`}
                </Badge>
              ) : (
                <Badge variant="outline">Clean</Badge>
              )}
            </div>
            <CardDescription>
              Validation from last save or publish attempt.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {issues.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No issues reported yet. Save draft to validate.
              </p>
            ) : (
              <ul className="space-y-3">
                {issues.map((issue, i) => (
                  <li key={`${issue.path}-${i}`} className="text-sm">
                    <div className="flex items-start gap-2">
                      <Badge
                        variant={
                          issue.level === "error" ? "destructive" : "secondary"
                        }
                        className="mt-0.5"
                      >
                        {issue.level}
                      </Badge>
                      <div className="min-w-0">
                        <p className="break-words">{issue.message}</p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {issue.path}
                        </p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Versions</CardTitle>
            <CardDescription>Published snapshots (immutable).</CardDescription>
          </CardHeader>
          <CardContent>
            {versions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No published versions yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {versions.map((v) => (
                  <li
                    key={v._id}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="font-mono">v{v.version}</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(v.publishedAt).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function defaultNextVersion(existing: string[]): string {
  if (existing.length === 0) return "0.1.0";
  let best: [number, number, number] | null = null;
  for (const v of existing) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    if (!m) continue;
    const triple: [number, number, number] = [
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
    ];
    if (
      best === null ||
      triple[0] > best[0] ||
      (triple[0] === best[0] && triple[1] > best[1]) ||
      (triple[0] === best[0] &&
        triple[1] === best[1] &&
        triple[2] > best[2])
    ) {
      best = triple;
    }
  }
  if (best === null) return "0.1.0";
  return `${best[0]}.${best[1]}.${best[2] + 1}`;
}

function SpecEditorSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
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
      </div>
    </div>
  );
}
