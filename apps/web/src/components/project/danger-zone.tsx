import { useConvexMutation } from "@convex-dev/react-query";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

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
import { api } from "#/lib/convex-api";
import type { Doc } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";
export function DangerZone({ project }: { project: Doc<"projects"> }) {
  const navigate = useNavigate();
  const removeProject = useConvexMutation(api.projects.remove);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const { mutate: deleteProject, isPending: deletePending } = useMutation({
    mutationFn: () => removeProject({ projectId: project._id }),
    onSuccess: () => {
      toast.success(
        project.status === "draft" ? "Project deleted" : "Project retired",
      );
      setDeleteOpen(false);
      void navigate({ to: "/app/projects" });
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not remove project"));
    },
  });

  const canDelete = deleteConfirm.trim() === project.slug;
  const canRemoveProject =
    project.status !== "published" ||
    (project.sunsetAt !== undefined && Date.now() >= project.sunsetAt);
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">Danger zone</CardTitle>
        <CardDescription>
          {project.status === "draft"
            ? "Remove this draft project from your workspace. Its API URL cannot be reused."
            : "Remove this published API after its sunset. Published versions, usage history, and financial records will be kept."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Dialog
          open={deleteOpen}
          onOpenChange={(open) => {
            if (deletePending) return;
            setDeleteOpen(open);
            if (!open) setDeleteConfirm("");
          }}
        >
          <DialogTrigger asChild>
            <Button variant="destructive" disabled={!canRemoveProject}>
              {project.status === "draft" ? "Delete project" : "Retire project"}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {project.status === "draft"
                  ? "Delete project?"
                  : "Retire project?"}
              </DialogTitle>
              <DialogDescription>
                This cannot be undone. Type{" "}
                <span className="font-mono text-foreground">
                  {project.slug}
                </span>{" "}
                to confirm.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="delete-confirm">Project slug</Label>
              <Input
                id="delete-confirm"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder={project.slug}
                className="font-mono text-sm"
                disabled={deletePending}
                autoComplete="off"
              />
            </div>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => {
                  setDeleteOpen(false);
                  setDeleteConfirm("");
                }}
                disabled={deletePending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={deletePending || !canDelete}
                onClick={() => deleteProject()}
              >
                {deletePending
                  ? "Removing…"
                  : project.status === "draft"
                    ? "Delete project"
                    : "Retire project"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {!canRemoveProject ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Published projects can be retired only after their scheduled sunset.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
