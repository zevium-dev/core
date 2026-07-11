import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
import { parseTagsInput } from "#/lib/project-helpers";

export function ProjectSettingsPanel({
  project,
  orgSlug,
}: {
  project: Doc<"projects">;
  orgSlug: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const updateProject = useConvexMutation(api.projects.update);
  const removeProject = useConvexMutation(api.projects.remove);

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [tagsText, setTagsText] = useState(project.tags.join(", "));
  const [visibilityOpen, setVisibilityOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  // Keep local form in sync when realtime project doc changes (e.g. header visibility).
  useEffect(() => {
    setName(project.name);
    setDescription(project.description ?? "");
    setTagsText(project.tags.join(", "));
  }, [project.name, project.description, project.tags, project._id]);

  async function invalidateProjectQueries() {
    await queryClient.invalidateQueries({
      queryKey: convexQuery(api.projects.get, {
        orgSlug,
        projectSlug: project.slug,
      }).queryKey,
    });
    await queryClient.invalidateQueries({
      queryKey: convexQuery(api.projects.list, { orgSlug }).queryKey,
    });
  }

  const { mutate: saveDetails, isPending: savePending } = useMutation({
    mutationFn: (patch: {
      name: string;
      description: string | null;
      tags: string[];
    }) =>
      updateProject({
        projectId: project._id,
        patch,
      }),
    onMutate: async (patch) => {
      const queryOpts = convexQuery(api.projects.get, {
        orgSlug,
        projectSlug: project.slug,
      });
      await queryClient.cancelQueries({ queryKey: queryOpts.queryKey });
      const previous = queryClient.getQueryData<Doc<"projects"> | null>(
        queryOpts.queryKey,
      );
      if (previous) {
        queryClient.setQueryData<Doc<"projects">>(queryOpts.queryKey, {
          ...previous,
          name: patch.name,
          description: patch.description ?? undefined,
          tags: patch.tags,
        });
      }
      return { previous, queryKey: queryOpts.queryKey };
    },
    onSuccess: async () => {
      toast.success("Project updated");
      await invalidateProjectQueries();
    },
    onError: (err: unknown, _patch, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
      toast.error(humanError(err, "Could not update project"));
    },
  });

  const { mutate: setVisibility, isPending: visibilityPending } = useMutation({
    mutationFn: (visibility: "public" | "private") =>
      updateProject({
        projectId: project._id,
        patch: { visibility },
      }),
    onSuccess: async (updated) => {
      toast.success(
        updated.visibility === "public"
          ? "Project is now public"
          : "Project is now private",
      );
      setVisibilityOpen(false);
      await invalidateProjectQueries();
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not update visibility"));
    },
  });

  const { mutate: deleteProject, isPending: deletePending } = useMutation({
    mutationFn: () => removeProject({ projectId: project._id }),
    onSuccess: async () => {
      toast.success("Project deleted");
      setDeleteOpen(false);
      await queryClient.invalidateQueries({
        queryKey: convexQuery(api.projects.list, { orgSlug }).queryKey,
      });
      void navigate({ to: "/app/projects" });
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not delete project"));
    },
  });

  const nextVisibility = project.visibility === "public" ? "private" : "public";
  const tagsPreview = parseTagsInput(tagsText);
  const canDelete = deleteConfirm.trim() === project.slug;

  function onSaveDetails(e: FormEvent) {
    e.preventDefault();
    if (savePending) return;

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      toast.error("Name is required");
      return;
    }
    if (tagsPreview.length > 32) {
      toast.error("At most 32 tags");
      return;
    }

    const trimmedDescription = description.trim();
    saveDetails({
      name: trimmedName,
      description: trimmedDescription === "" ? null : trimmedDescription,
      tags: tagsPreview,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <form onSubmit={onSaveDetails}>
          <CardHeader>
            <CardTitle>Project details</CardTitle>
            <CardDescription>
              Name, description, and catalogue tags. Slug is permanent.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="settings-name">Name</Label>
              <Input
                id="settings-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                disabled={savePending}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="settings-slug">Slug</Label>
              <Input
                id="settings-slug"
                value={project.slug}
                disabled
                readOnly
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Slug cannot be changed after creation.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="settings-description">Description</Label>
              <textarea
                id="settings-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                disabled={savePending}
                rows={4}
                className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="settings-tags">Tags</Label>
              <Input
                id="settings-tags"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder="ai, llm, tools"
                disabled={savePending}
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated. Lowercased and de-duplicated on save (max 32).
              </p>
              {tagsPreview.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {tagsPreview.map((tag) => (
                    <Badge key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
          </CardContent>
          <CardFooter className="justify-end border-t pt-6">
            <Button type="submit" disabled={savePending}>
              {savePending ? "Saving…" : "Save changes"}
            </Button>
          </CardFooter>
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Visibility</CardTitle>
          <CardDescription>
            Public projects appear in the catalogue when published. Private
            projects stay hidden.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1 text-sm">
            <p>
              Current:{" "}
              <span className="font-medium capitalize">
                {project.visibility}
              </span>
            </p>
            <p className="text-muted-foreground">
              Status:{" "}
              <span className="font-medium capitalize">{project.status}</span>
            </p>
          </div>
          <Dialog open={visibilityOpen} onOpenChange={setVisibilityOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">
                Make {nextVisibility === "public" ? "Public" : "Private"}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Make project {nextVisibility}?</DialogTitle>
                <DialogDescription>
                  {nextVisibility === "public"
                    ? "Public projects appear in the catalogue when published. Only published specs are listed."
                    : "Private projects stay hidden from the public catalogue."}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => setVisibilityOpen(false)}
                  disabled={visibilityPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => setVisibility(nextVisibility)}
                  disabled={visibilityPending}
                >
                  {visibilityPending ? "Updating…" : `Make ${nextVisibility}`}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>
            Delete this project and its draft/spec versions permanently. Usage
            history is retained for analytics integrity.
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
              <Button variant="destructive">Delete project</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete project?</DialogTitle>
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
                  {deletePending ? "Deleting…" : "Delete project"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </div>
  );
}
