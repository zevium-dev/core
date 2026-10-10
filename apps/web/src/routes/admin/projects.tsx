import { ListBoundary } from "#/components/list-boundary";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "#/components/ui/table";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Eye, EyeOff, FileStack } from "lucide-react";
import {
  usePaginatedQuery,
  useMutation as useConvexMutation,
} from "convex/react";
import { useState } from "react";
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
import {
  ADMIN_STATUS_OPTIONS,
  ADMIN_VISIBILITY_OPTIONS,
  parseProjectStatus,
  parseProjectVisibility,
  type ProjectStatusFilter,
  type ProjectVisibilityFilter,
} from "#/lib/admin-filters";
import { api } from "#/lib/convex-api";
import { humanError } from "#/lib/human-error";
import type { AdminProjectView } from "../../../../../convex/admin";

const PROJECT_PAGE_SIZE = 25;

const SELECT_CLASS =
  "flex h-9 min-w-[9rem] rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] duration-[var(--dur-instant)] ease-[var(--ease)] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

export const Route = createFileRoute("/admin/projects")({
  component: () => (
    <ListBoundary label="projects">
      <AdminProjectsPage />
    </ListBoundary>
  ),
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

  const [killTarget, setKillTarget] = useState<KillSwitchTarget | null>(null);
  const {
    results: rows,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.admin.listProjects,
    {
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(visibilityFilter ? { visibility: visibilityFilter } : {}),
    },
    { initialNumItems: PROJECT_PAGE_SIZE },
  );

  const convexSetVisibility = useConvexMutation(api.admin.setProjectVisibility);
  const toggleMutation = useMutation({
    mutationFn: (vars: {
      organizationHandle: string;
      projectSlug: string;
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

  const firstPagePending = status === "LoadingFirstPage";
  const loadMorePending = status === "LoadingMore";
  const canLoadMore = status === "CanLoadMore";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="text-sm text-muted-foreground">
          Review project status and change public catalogue visibility.
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
                <Table className="w-full text-sm">
                  <TableHeader>
                    <TableRow className="border-b text-left text-muted-foreground">
                      <TableHead scope="col" className="px-2 py-2 font-medium">
                        Name
                      </TableHead>
                      <TableHead scope="col" className="px-2 py-2 font-medium">
                        Org
                      </TableHead>
                      <TableHead scope="col" className="px-2 py-2 font-medium">
                        Status
                      </TableHead>
                      <TableHead scope="col" className="px-2 py-2 font-medium">
                        Visibility
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="px-2 py-2 font-medium text-right"
                      >
                        Visibility action
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((project) => (
                      <ProjectRow
                        key={project.handle}
                        project={project}
                        orgLabel={project.organizationName}
                        disabled={toggleMutation.isPending}
                        onToggle={(target) =>
                          setKillTarget({ project, target })
                        }
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
              {canLoadMore || loadMorePending ? (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadMorePending || !canLoadMore}
                    onClick={() => loadMore(PROJECT_PAGE_SIZE)}
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
            organizationHandle: killTarget.project.organizationHandle,
            projectSlug: killTarget.project.slug,
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
    <TableRow className="border-b last:border-0">
      <TableCell className="px-2 py-2.5 font-medium">{project.name}</TableCell>
      <TableCell className="px-2 py-2.5 text-muted-foreground">
        {orgLabel}
      </TableCell>
      <TableCell className="px-2 py-2.5">
        {project.status === "published" ? (
          <Badge variant="secondary">published</Badge>
        ) : (
          <Badge variant="outline">draft</Badge>
        )}
      </TableCell>
      <TableCell className="px-2 py-2.5">
        {isPublic ? (
          <Badge variant="secondary">public</Badge>
        ) : (
          <Badge variant="outline">private</Badge>
        )}
      </TableCell>
      <TableCell className="px-2 py-2.5 text-right">
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
      </TableCell>
    </TableRow>
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
