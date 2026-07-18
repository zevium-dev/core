import { convexQuery } from "@convex-dev/react-query";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Eye, EyeOff, FileStack } from "lucide-react";
import { useMutation as useConvexMutation } from "convex/react";
import { useEffect, useMemo, useState } from "react";
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
} from "#/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Label } from "#/components/ui/label";
import { Skeleton } from "#/components/ui/skeleton";
import { mergeUsagePages } from "#/lib/activity-filters";
import {
  ADMIN_STATUS_OPTIONS,
  ADMIN_VISIBILITY_OPTIONS,
  buildOrgNameMap,
  orgDisplayName,
  parseProjectStatus,
  parseProjectVisibility,
  type OrgNameEntry,
  type ProjectStatusFilter,
  type ProjectVisibilityFilter,
} from "#/lib/admin-filters";
import { api } from "#/lib/convex-api";
import type { Id } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";
import type { AdminProjectView } from "../../../../../convex/admin";

const PROJECT_PAGE_SIZE = 25;
const ORG_MAP_PAGE_SIZE = 100;

const SELECT_CLASS =
  "flex h-9 min-w-[9rem] rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] duration-[var(--dur-instant)] ease-[var(--ease)] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

export const Route = createFileRoute("/admin/projects")({
  component: AdminProjectsPage,
  head: () => ({
    meta: [{ title: "Admin Projects · Zevium" }],
  }),
  pendingComponent: ProjectsSkeleton,
});

type KillSwitchTarget = {
  project: AdminProjectView;
  /** Visibility the confirm action will force. */
  target: ProjectVisibilityFilter;
};

function AdminProjectsPage() {
  const [statusFilter, setStatusFilter] = useState<
    ProjectStatusFilter | undefined
  >(undefined);
  const [visibilityFilter, setVisibilityFilter] = useState<
    ProjectVisibilityFilter | undefined
  >(undefined);

  const [cursor, setCursor] = useState<string | null>(null);
  const [rows, setRows] = useState<AdminProjectView[]>([]);
  const [isDone, setIsDone] = useState(false);
  const [continueCursor, setContinueCursor] = useState<string | null>(null);
  const [killTarget, setKillTarget] = useState<KillSwitchTarget | null>(null);

  const orgMap = useOrgNameMap();

  const listArgs = useMemo(() => {
    const args: {
      paginationOpts: { numItems: number; cursor: string | null };
      status?: ProjectStatusFilter;
      visibility?: ProjectVisibilityFilter;
    } = { paginationOpts: { numItems: PROJECT_PAGE_SIZE, cursor } };
    if (statusFilter !== undefined) args.status = statusFilter;
    if (visibilityFilter !== undefined) args.visibility = visibilityFilter;
    return args;
  }, [cursor, statusFilter, visibilityFilter]);

  const projectsQuery = useQuery(convexQuery(api.admin.listProjects, listArgs));

  // Reset accumulated pages when filters change.
  useEffect(() => {
    setCursor(null);
    setRows([]);
    setIsDone(false);
    setContinueCursor(null);
  }, [statusFilter, visibilityFilter]);

  useEffect(() => {
    if (!projectsQuery.data || projectsQuery.isPending) return;
    const page = projectsQuery.data.page;
    setRows((prev) => mergeUsagePages(prev, page, cursor === null));
    setIsDone(projectsQuery.data.isDone);
    setContinueCursor(projectsQuery.data.continueCursor);
  }, [projectsQuery.data, projectsQuery.isPending, cursor]);

  const convexSetVisibility = useConvexMutation(api.admin.setProjectVisibility);
  const toggleMutation = useMutation({
    mutationFn: (vars: {
      projectId: Id<"projects">;
      visibility: ProjectVisibilityFilter;
    }) => convexSetVisibility(vars),
    onSuccess: (_data, vars) => {
      toast.success(`Project visibility forced to ${vars.visibility}.`);
      setKillTarget(null);
    },
    onError: (err) => {
      toast.error(humanError(err));
    },
  });

  const firstPagePending = projectsQuery.isPending && cursor === null;
  const loadMorePending = projectsQuery.isPending && cursor !== null;
  const canLoadMore =
    !isDone && continueCursor !== null && !projectsQuery.isPending;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="text-sm text-muted-foreground">
          All projects with a platform-admin visibility kill switch.
        </p>
      </div>

      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle>Projects</CardTitle>
            <CardDescription>
              Name, organization, status, visibility.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="admin-status" className="text-xs">
                Status
              </Label>
              <select
                id="admin-status"
                className={SELECT_CLASS}
                value={statusFilter ?? "all"}
                onChange={(e) =>
                  setStatusFilter(parseProjectStatus(e.target.value))
                }
              >
                <option value="all">All statuses</option>
                {ADMIN_STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-visibility" className="text-xs">
                Visibility
              </Label>
              <select
                id="admin-visibility"
                className={SELECT_CLASS}
                value={visibilityFilter ?? "all"}
                onChange={(e) =>
                  setVisibilityFilter(parseProjectVisibility(e.target.value))
                }
              >
                <option value="all">All visibilities</option>
                {ADMIN_VISIBILITY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {firstPagePending ? (
            <ProjectsTableSkeleton />
          ) : rows.length === 0 ? (
            <EmptyProjects />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th scope="col" className="px-2 py-2 font-medium">
                        Name
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        Org
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        Status
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        Visibility
                      </th>
                      <th
                        scope="col"
                        className="px-2 py-2 font-medium text-right"
                      >
                        Kill switch
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((project) => (
                      <ProjectRow
                        key={project._id}
                        project={project}
                        orgLabel={orgDisplayName(
                          project.organizationId,
                          orgMap,
                        )}
                        disabled={toggleMutation.isPending}
                        onToggle={(target) =>
                          setKillTarget({ project, target })
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              {canLoadMore || loadMorePending ? (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadMorePending || !canLoadMore}
                    onClick={() => {
                      if (continueCursor !== null) {
                        setCursor(continueCursor);
                      }
                    }}
                  >
                    {loadMorePending ? "Loading…" : "Load more"}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <KillSwitchDialog
        target={killTarget}
        pending={toggleMutation.isPending}
        onCancel={() => setKillTarget(null)}
        onConfirm={() => {
          if (killTarget === null) return;
          toggleMutation.mutate({
            projectId: killTarget.project._id,
            visibility: killTarget.target,
          });
        }}
      />
    </div>
  );
}

function ProjectRow({
  project,
  orgLabel,
  disabled,
  onToggle,
}: {
  project: AdminProjectView;
  orgLabel: string;
  disabled: boolean;
  onToggle: (target: ProjectVisibilityFilter) => void;
}) {
  const isPublic = project.visibility === "public";
  // Inline toggle target (trivial): private → public, public → private.
  const target: ProjectVisibilityFilter = isPublic ? "private" : "public";

  return (
    <tr className="border-b last:border-0">
      <td className="px-2 py-2.5 font-medium">{project.name}</td>
      <td className="px-2 py-2.5 text-muted-foreground">{orgLabel}</td>
      <td className="px-2 py-2.5">
        {project.status === "published" ? (
          <Badge variant="secondary">published</Badge>
        ) : (
          <Badge variant="outline">draft</Badge>
        )}
      </td>
      <td className="px-2 py-2.5">
        {isPublic ? (
          <Badge variant="secondary">public</Badge>
        ) : (
          <Badge variant="outline">private</Badge>
        )}
      </td>
      <td className="px-2 py-2.5 text-right">
        <Button
          size="xs"
          variant={target === "private" ? "destructive" : "outline"}
          disabled={disabled}
          onClick={() => onToggle(target)}
        >
          {target === "private" ? (
            <>
              <EyeOff className="size-3" />
              Force private
            </>
          ) : (
            <>
              <Eye className="size-3" />
              Make public
            </>
          )}
        </Button>
      </td>
    </tr>
  );
}

function KillSwitchDialog({
  target,
  pending,
  onCancel,
  onConfirm,
}: {
  target: KillSwitchTarget | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const forcingPrivate = target?.target === "private";
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {forcingPrivate ? "Force project private?" : "Make project public?"}
          </DialogTitle>
          <DialogDescription>
            {target ? (
              <>
                Platform admin override for{" "}
                <span className="font-medium text-foreground">
                  {target.project.name}
                </span>
                . The owning organization will be notified and a{" "}
                <span className="font-mono text-xs">
                  project.visibility_changed
                </span>{" "}
                webhook will fire.
                {forcingPrivate
                  ? " Forcing private delists it from the public catalogue."
                  : ""}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={forcingPrivate ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending
              ? "Applying…"
              : forcingPrivate
                ? "Force private"
                : "Make public"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Background org-name lookup. `listProjects` returns only `organizationId`,
 * so page through every org once (admin tool, bounded scale) and build a
 * complete id → name map. Realtime: stays fresh via the Convex subscription.
 */
function useOrgNameMap() {
  const [orgs, setOrgs] = useState<OrgNameEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isDone, setIsDone] = useState(false);
  const [continueCursor, setContinueCursor] = useState<string | null>(null);

  const args = useMemo(
    () => ({ paginationOpts: { numItems: ORG_MAP_PAGE_SIZE, cursor } }),
    [cursor],
  );
  const orgsQuery = useQuery(convexQuery(api.admin.listOrgs, args));

  useEffect(() => {
    if (!orgsQuery.data || orgsQuery.isPending) return;
    setOrgs((prev) =>
      mergeUsagePages<OrgNameEntry>(
        prev,
        orgsQuery.data!.page,
        cursor === null,
      ),
    );
    setIsDone(orgsQuery.data.isDone);
    setContinueCursor(orgsQuery.data.continueCursor);
  }, [orgsQuery.data, orgsQuery.isPending, cursor]);

  // Auto-advance until every org page is loaded.
  useEffect(() => {
    if (isDone || orgsQuery.isPending) return;
    if (continueCursor !== null) setCursor(continueCursor);
  }, [isDone, continueCursor, orgsQuery.isPending]);

  return useMemo(() => buildOrgNameMap(orgs), [orgs]);
}

function EmptyProjects() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileStack />
        </EmptyMedia>
        <EmptyTitle>No projects</EmptyTitle>
        <EmptyDescription>No projects match these filters.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ProjectsTableSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="ml-auto h-6 w-24" />
        </div>
      ))}
    </div>
  );
}

function ProjectsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent>
          <ProjectsTableSkeleton />
        </CardContent>
      </Card>
    </div>
  );
}
